'use client';

// ==========================================================
// DOCENT — Chat Orchestration Hook
// Core hook that ties TTS, Memory, PDF, Presentation, and Sessions together
// ==========================================================

// ── Smart timeout: scales with model capability + active features ───
function computeTimeout(
  model: ModelOption | undefined,
  flags: { deepThinking: boolean; hasPdf: boolean; search: boolean; presentation: boolean },
): number {
  // Base: 2 minutes for any request
  let ms = 2 * 60_000;

  // Model-driven: scale by max output tokens (~1 min per 16K max output)
  const maxOut = model?.maxCompletionTokens || 4096;
  ms += Math.ceil(maxOut / 16_000) * 60_000;

  // Reasoning models are ~2x slower in token generation
  if (model?.capabilities?.reasoning) ms += 2 * 60_000;

  // Feature multipliers
  if (flags.deepThinking) ms += 3 * 60_000;   // +3 min for deep thinking budget
  if (flags.hasPdf)       ms += 2 * 60_000;   // +2 min for PDF processing
  if (flags.search)       ms += 1 * 60_000;   // +1 min for web search latency
  if (flags.presentation) ms += 3 * 60_000;   // +3 min for slide generation

  // No hard cap — the activity-based useEffect timeout (2-3 min inactivity) is the real safety net.
  return ms;
}

import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  Message,
  Slide,
  UploadedFile,
  ActiveTab,
  VoiceGender,
  TTSEngine,
  STTEngine,
  ImageCatalogEntry,
  ExtractedFigure,
  NarrativeArcEntry,
  PresentationPlan,
  PresentationMode,
  AssessmentState,
  AssessmentQuestion,
  AssessmentAnswer,
  AuditCheck,
  AuditResult,
  PosterState,
} from '@/src/types';
import { callChat, callChatStream } from '@/src/lib/api';
import type { TokenUsage } from '@/src/lib/api';
import type { ModelOption } from '@/src/types';
import { getPresentationPrompt, PRESENTATION_WORKFLOW, DEFAULT_MODEL, FALLBACK_MODELS, INTENT_META_INSTRUCTION, AUTHOR_MODE_PROMPT, JOURNAL_CLUB_PROMPT, getPosterPrompt, POSTER_WORKFLOW } from '@/src/lib/constants';
import {
  isPresentationIntent,
  extractPresentationJson,
  isPosterIntent,
  extractPosterJson,
  buildImageCatalog,
  cleanTextForSpeech,
  createIncrementalParseState,
  extractIncrementalSlides,
} from '@/src/lib/presentation';
import type { IncrementalParseState } from '@/src/lib/presentation';
import {
  generateExportHTML,
  exportPresentationPPTX as exportPPTX,
} from '@/src/lib/export-utils';
import { detectLanguage } from '@/src/lib/language-detect';
import {
  extractFiguresFromPdf,
  preCropExtractedFigures,
  buildExtractedFigureCatalog,
  detectMainContentEnd,
  EXTRACTION_MODEL,
} from '@/src/lib/figure-extraction';
import {
  detectPresentationMode,
  detectPlanResponse,
  formatPlanForChat,
} from '@/src/lib/presentation-modes';
import {
  isAssessmentIntent,
  isQuitIntent,
  createInitialAssessmentState,
  buildSlideSummaries,
  buildAssessmentSystemPrompt,
  buildEvaluationSystemPrompt,
  parseQuestionResponse,
  parseEvaluationResponse,
  selectTier,
  computeNextTheta,
  shouldStopAssessment,
  buildGapReport,
  buildFullBreakdown,
} from '@/src/lib/assessment';
import { buildDeepAnalysisPrompt } from '@/src/lib/deep-analysis';
import { useTTS } from './useTTS';
import { useSTT } from './useSTT';
import { useMemory } from './useMemory';
import { usePDF } from './usePDF';
import { usePresentation } from './usePresentation';
import { useSessions } from './useSessions';

// ── Narrative arc planning ──────────────────────────────────
// This planning call runs on the MAIN model (user's selected model) with optional
// deep thinking, producing a narrative arc and paper summary from the figure catalog
// and PDF text. Separated from the cheap vision model (Gemini Flash) which only
// handles figure/table detection.

const NARRATIVE_FRAMING: Record<PresentationMode, string> = {
  general: `NARRATIVE STANCE — GENERAL OVERVIEW:
Reorganize for maximum clarity to someone unfamiliar with the work.
Lead with the main result, then explain how it was achieved. Context before details.
Third-person voice ("the paper shows", "the authors demonstrate").
Cover background, methods, key results, and conclusions evenly. Give each aspect proportional attention.`,

  author: `NARRATIVE STANCE — AUTHOR ADVOCACY:
Follow the paper's own presentation order. If the paper presents examples before
theorems, do the same — the authors chose this order for a reason. Emphasize what's novel
("our contribution", "we show for the first time"). First-person voice.
Lead with the problem the authors solved, then their method and its novelty,
then results that demonstrate superiority over prior work. Emphasize contribution and impact.`,

  journal_club: `NARRATIVE STANCE — CRITICAL ANALYSIS:
Present the paper's claims, then evaluate them. Include at least 2 slides
dedicated to: (a) methodological assumptions and their validity, (b) what the paper doesn't
address / open questions for discussion. Third-person critical voice.
Lead with the paper's central claim, then examine methodology strengths and weaknesses,
assess evidence quality, identify limitations, and end with discussion points for the group.`,
};

const SLIDE_COUNT_GUIDANCE: Record<PresentationMode, string> = {
  general: '12-18 content slides',
  author: '15-22 content slides for a 15-20 minute conference talk',
  journal_club: '14-20 content slides, including 2-3 discussion/critique slides',
};

function buildNarrativePlanningPrompt(
  figures: ExtractedFigure[],
  textSummary: string,
  mode: PresentationMode,
): string {
  // Provide a summary of available visuals WITH ef_N IDs and Gemini's content
  // descriptions so the planner knows what each figure actually shows.
  const visualSummary = figures.length > 0
    ? figures.map(f => `  - ${f.id}: ${f.label || f.kind} (page ${f.page}) — ${f.description}`).join('\n')
    : '  (no figures/tables detected)';

  return `You are planning a presentation about a research paper. Your task is to produce a structured slide plan — NOT the slides themselves.

PAPER TEXT (main body + references):
${textSummary}

VISUAL ELEMENTS IN THE PAPER:
${visualSummary}

${NARRATIVE_FRAMING[mode]}

STRUCTURAL EXTRACTION (required before proposing slides):
Before proposing slides, inventory the paper's labeled elements:
- All numbered Theorems, Propositions, Lemmas, Corollaries, Definitions
- All numbered or named Examples, Case Studies, Use Cases
- All numbered Algorithms
- All Figures and Tables (with brief description)
- Any explicitly posed questions or labeled Findings/Observations
- Any negative results or counterexamples

Your slide plan must account for every major item in this inventory.
If you omit a numbered result or named example, state why in the plan.

NUMBERING RULE: When referencing numbered results (Theorem 1, Proposition 2, Algorithm 3, etc.),
use the EXACT numbering from the paper. Do not renumber or reorder results in the plan.

Produce a JSON object with exactly two fields:

1. "paper_summary": A 2-3 sentence summary of the paper's main contribution and key findings.

2. "narrative_arc": An ordered slide plan. Each entry:
   { "slide_number": N, "title": "Slide Title", "visual_need": "brief description of what visual this slide needs, or empty string for text-only slides", "purpose": "One-line description of what this slide accomplishes" }

   Rules:
   - Target ${SLIDE_COUNT_GUIDANCE[mode]} (do NOT include title or closing slides — those are added automatically).
     For equation-heavy or theory papers (5+ named theorems/equations), err toward the higher end.
   - For "visual_need": match each slide to the element from the VISUAL ELEMENTS list whose DESCRIPTION best fits the slide topic.
     CRITICAL: Match by what the figure SHOWS (the description after the —), NOT by figure number.
     The figure numbers in the list may not match the paper's numbering exactly.
     Format: "ef_N: brief description of content" (e.g. "ef_3: CDF of download speeds per community").
     Use ONLY elements from the VISUAL ELEMENTS list above — do NOT reference figures/tables that are not in that list.
   - Not every slide needs a visual — some slides work best as text-only (use "visual_need": "").
   - Order slides to tell a coherent story. ${mode === 'author' ? 'Follow the paper\'s own presentation order where possible.' : 'Context → method → results → implications.'}

Output ONLY valid JSON:
{
  "paper_summary": "...",
  "narrative_arc": [
    { "slide_number": 1, "title": "...", "visual_need": "...", "purpose": "..." },
    ...
  ]
}`;
}

function parseNarrativePlanResponse(raw: string): {
  narrative_arc: NarrativeArcEntry[];
  paper_summary: string;
} {
  let narrative_arc: NarrativeArcEntry[] = [];
  let paper_summary = '';

  try {
    let jsonStr = raw;
    const jsonBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonBlock) jsonStr = jsonBlock[1];

    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      const parsed = JSON.parse(jsonStr.substring(start, end + 1));

      if (typeof parsed.paper_summary === 'string') {
        paper_summary = parsed.paper_summary;
      }

      if (Array.isArray(parsed.narrative_arc)) {
        narrative_arc = parsed.narrative_arc
          .filter((e: { title?: string }) => e.title)
          .map((e: { slide_number?: number; title: string; visual_need?: string; purpose?: string }, i: number) => ({
            slide_number: i + 1,
            title: e.title,
            visual_need: typeof e.visual_need === 'string' ? e.visual_need : '',
            purpose: e.purpose || '',
          }));
      }
    }
  } catch (err) {
    console.warn('[Planning] Failed to parse narrative arc response:', err);
  }

  return { narrative_arc, paper_summary };
}

export function useChat() {
  // ── Core chat state ──────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState(false);
  const [deepThinking, setDeepThinking] = useState(false);

  // ── Presentation plan state (bridges Pass 1 ↔ Pass 2 for Author/JournalClub modes) ──
  const [pendingPlan, setPendingPlan] = useState<PresentationPlan | null>(null);
  const pendingPlanRef = useRef<PresentationPlan | null>(null);
  useEffect(() => { pendingPlanRef.current = pendingPlan; }, [pendingPlan]);

  // ── Assessment (Socratic) state ────────────────────────
  const [assessmentState, setAssessmentState] = useState<AssessmentState>(createInitialAssessmentState());
  const assessmentStateRef = useRef<AssessmentState>(createInitialAssessmentState());
  useEffect(() => { assessmentStateRef.current = assessmentState; }, [assessmentState]);
  const postPresQACountRef = useRef(0);

  // ── Slide Audit state ──────────────────────────────────
  const [auditResults, setAuditResults] = useState<Record<number, AuditResult>>({});
  const [isAuditing, setIsAuditing] = useState(false);
  const [isDeepAnalyzing, setIsDeepAnalyzing] = useState(false);

  // ── Poster state ────────────────────────────────────────
  const [posterState, setPosterState] = useState<PosterState | null>(null);


  // ── File state ───────────────────────────────────────────
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);

  // ── UI state ─────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat');
  const [showSidebar, setShowSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // ── Voice/model state ────────────────────────────────────
  const [voiceGender, setVoiceGender] = useState<VoiceGender>(() => {
    if (typeof window !== 'undefined') return (localStorage.getItem('docent_voiceGender') as VoiceGender) || 'female';
    return 'female';
  });
  const [autoVoice, setAutoVoice] = useState(false);
  const [ttsEngine, setTTSEngine] = useState<TTSEngine>(() => {
    if (typeof window !== 'undefined') return (localStorage.getItem('docent_ttsEngine') as TTSEngine) || 'browser';
    return 'browser';
  });
  const [googleApiKey, setGoogleApiKey] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('docent_googleApiKey') || '';
    return '';
  });
  const [browserVoiceName, setBrowserVoiceName] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('docent_browserVoiceName') || '';
    return '';
  });
  const [sttEngine, setSttEngine] = useState<STTEngine>(() => {
    if (typeof window !== 'undefined') return (localStorage.getItem('docent_sttEngine') as STTEngine) || 'browser';
    return 'browser';
  });
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [extractionModel, setExtractionModel] = useState(EXTRACTION_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [freeMode, setFreeMode] = useState(false); // true when server has key & user has none
  const [freeModeAvailable, setFreeModeAvailable] = useState(false); // server key exists

  // Persist voice/TTS settings to localStorage
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('docent_voiceGender', voiceGender); }, [voiceGender]);
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('docent_ttsEngine', ttsEngine); }, [ttsEngine]);
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('docent_googleApiKey', googleApiKey); }, [googleApiKey]);
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('docent_browserVoiceName', browserVoiceName); }, [browserVoiceName]);
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('docent_sttEngine', sttEngine); }, [sttEngine]);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>(FALLBACK_MODELS);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [maxOutputTokens, setMaxOutputTokens] = useState(16000);
  const [lastTokenUsage, setLastTokenUsage] = useState<TokenUsage | null>(null);

  // ── Refs ──────────────────────────────────────────────────
  const abortRef = useRef<AbortController | null>(null);
  const requestGenRef = useRef(0);
  const cancelledGens = useRef<Set<number>>(new Set());
  const presInProgressRef = useRef(false);
  const lastActivityRef = useRef<number>(Date.now());
  const incrementalParseRef = useRef<IncrementalParseState>(createIncrementalParseState());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const imageCatalogRef = useRef<ImageCatalogEntry[]>([]);
  const thumbnailsSentRef = useRef(false);

  // ── Composed hooks ────────────────────────────────────────
  const tts = useTTS(voiceGender, ttsEngine, googleApiKey, browserVoiceName);
  const memory = useMemory();
  const pdf = usePDF({ setLoadingMsg });
  const presentation = usePresentation(imageCatalogRef);
  const sessions = useSessions();

  // ── Speech-to-Text ──────────────────────────────────────
  // Derive session language from last Sage message for STT language hint
  const sttLanguage = [...messages].reverse().find(m => m.sender === 'sage' && m.language)?.language
    || presentation.presentationRef.current.language
    || undefined;

  const handleSendRef = useRef<((text?: string) => void) | undefined>(undefined);
  const stt = useSTT({
    engine: sttEngine,
    apiKey,
    language: sttLanguage,
    onFinalTranscript: useCallback((text: string) => {
      // Stop TTS if speaking (prevent feedback)
      tts.stopSpeaking();
      handleSendRef.current?.(text);
    }, [tts]),
  });

  // ── Load API key, maxOutputTokens, TTS engine & Google API key from localStorage on mount ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = localStorage.getItem('docent:apiKey');
    if (stored) setApiKey(stored);
    const storedTokens = localStorage.getItem('docent:maxOutputTokens');
    if (storedTokens) setMaxOutputTokens(parseInt(storedTokens, 10));
    const storedEngine = localStorage.getItem('docent:ttsEngine');
    if (storedEngine === 'browser' || storedEngine === 'gemini') setTTSEngine(storedEngine);
    const storedGoogleKey = localStorage.getItem('docent:googleApiKey');
    if (storedGoogleKey) setGoogleApiKey(storedGoogleKey);
    const storedExtractionModel = localStorage.getItem('docent:extractionModel');
    if (storedExtractionModel) setExtractionModel(storedExtractionModel);
    const storedBrowserVoice = localStorage.getItem('docent:browserVoiceName');
    if (storedBrowserVoice) setBrowserVoiceName(storedBrowserVoice);
  }, []);

  // ── Check if server has an API key (free mode available) ──
  useEffect(() => {
    fetch('/api/free-status')
      .then(r => r.json())
      .then(d => { if (d.available) setFreeModeAvailable(true); })
      .catch(() => {});
  }, []);

  // Derive free-mode: server key exists AND user has no key
  useEffect(() => {
    setFreeMode(freeModeAvailable && !apiKey);
  }, [freeModeAvailable, apiKey]);

  // Persist API key changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (apiKey) {
      localStorage.setItem('docent:apiKey', apiKey);
    }
  }, [apiKey]);

  // Persist maxOutputTokens changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('docent:maxOutputTokens', String(maxOutputTokens));
  }, [maxOutputTokens]);

  // Persist TTS engine changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('docent:ttsEngine', ttsEngine);
  }, [ttsEngine]);

  // Persist Google API key changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (googleApiKey) {
      localStorage.setItem('docent:googleApiKey', googleApiKey);
    }
  }, [googleApiKey]);

  // Persist extraction model changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('docent:extractionModel', extractionModel);
  }, [extractionModel]);

  // Persist browser voice name changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('docent:browserVoiceName', browserVoiceName);
  }, [browserVoiceName]);


  // ── Fetch models from OpenRouter when API key changes ────
  useEffect(() => {
    if (!apiKey || !apiKey.startsWith('sk-or-')) {
      // In free mode, still use fallback models (server picks the model anyway)
      setAvailableModels(FALLBACK_MODELS);
      return;
    }

    let cancelled = false;
    const fetchModels = async () => {
      setModelsLoading(true);
      try {
        const headers: Record<string, string> = {};
        if (apiKey) headers['x-api-key'] = apiKey;
        const res = await fetch('/api/models', { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && data.models?.length > 0) {
          setAvailableModels(data.models);
        }
      } catch (e) {
        console.warn('Failed to fetch models, using fallback:', e);
        if (!cancelled) setAvailableModels(FALLBACK_MODELS);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };

    // Debounce: wait 500ms after key stops changing
    const timer = setTimeout(fetchModels, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiKey]);

  // ── Auto-scroll chat on new messages or tab switch ────────
  useEffect(() => {
    // Small delay ensures ChatPanel has mounted when switching tabs
    const t = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
    return () => clearTimeout(t);
  }, [messages, activeTab]);

  // ── Safety timeout: activity-based auto-reset ────────────
  // Instead of a fixed wall-clock timeout, we track when the last SSE chunk arrived
  // (via lastActivityRef, updated in every streaming callback). If the stream goes
  // silent for too long, we abort. This eliminates the old bug where changing the
  // loading message (e.g. "Generating slides...") would reset the timeout.
  const hasPdfContext = pdf.pdfThumbnails.length > 0 || (pdf.pdfTextPages?.length ?? 0) > 0;
  useEffect(() => {
    if (!isLoading) return;

    // Mark loading start as initial activity
    lastActivityRef.current = Date.now();

    // Check every 15 seconds whether the stream has gone silent
    const checker = setInterval(() => {
      const silentMs = Date.now() - lastActivityRef.current;

      // Inactivity threshold:
      // - Deep analysis: 5 minutes (huge prompt, long time-to-first-token)
      // - Presentations: 3 minutes (model may pause between slides for search/thinking)
      // - Normal chat: 2 minutes
      const isPresentation = presInProgressRef.current;
      const threshold = isDeepAnalyzing ? 5 * 60_000 : isPresentation ? 3 * 60_000 : 2 * 60_000;

      if (silentMs > threshold) {
        console.warn(`[Timeout] Stream silent for ${Math.round(silentMs / 1000)}s — aborting`);

        if (isDeepAnalyzing) {
          // Deep analysis uses its own controller — abort it and keep streamed content
          deepAnalysisControllerRef.current?.abort();
          deepAnalysisControllerRef.current = null;
          setIsDeepAnalyzing(false);
          setIsLoading(false);
          setLoadingMsg('');
          // Keep whatever was streamed — finalize instead of deleting
          setMessages(prev => prev.map(m =>
            m.isThinking ? { ...m, isThinking: false, text: m.text + '\n\n---\n\n> ⚠️ *Deep analysis timed out — partial report shown above.*' } : m
          ));
        } else {
          abortRef.current?.abort();
          abortRef.current = null;
          setIsLoading(false);
          setLoadingMsg('');
          setMessages(prev => prev.filter(m => !m.isThinking));
          presInProgressRef.current = false;
          presentation.finalizePresentation();
        }
        const timeoutMins = isDeepAnalyzing ? 5 : isPresentation ? 3 : 2;
        setError(`Request timed out — no data received for ${timeoutMins} minutes. Please try again.`);
      }
    }, 15_000);

    return () => clearInterval(checker);
  }, [isLoading, isDeepAnalyzing]);

  // ── Build system prompt ───────────────────────────────────
  // Accepts userText so we can conditionally include presentation rules.
  // forcePresIntent overrides the keyword check (used after model-based intent detection).
  const buildSystemPrompt = useCallback((userText: string, forcePresIntent?: boolean, plan?: PresentationPlan | null): string => {
    // Base identity — always present
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    let prompt = `You are Sage, the AI assistant powering Docent — an intelligent presentation and research tool built by Symbiont AI Cognitive Labs. You speak with confidence and warmth, making complex topics accessible.

Today's date is ${today}.

CAPABILITIES (share these when the user greets you or asks what you can do):
• Upload a PDF paper and get a full slide deck with figures, speaker notes, and references
• Three presentation modes: General (balanced overview), Author (first-person advocacy), and Journal Club (critical analysis)
• Ask questions about any uploaded PDF — summarize, explain sections, compare findings
• Generate topic-based presentations from scratch (no PDF needed) with web search
• Export presentations to PPTX (PowerPoint) or HTML
• Narrate slides with text-to-speech (multiple voices and languages)
• Deep Thinking mode for more thorough analysis
• Remembers your preferences across sessions via Sage's Notes

You can save important observations, user preferences, and key findings using [NOTE: your observation] tags. These will persist across conversations.`;

    // Detect if the user is requesting a presentation
    const isPres = forcePresIntent ?? isPresentationIntent(userText, messages);

    if (isPres) {
      // Presentation mode: include workflow + generation rules
      // When a plan exists (Author/JournalClub confirmed), skip PRESENTATION_WORKFLOW
      // since the user already reviewed and approved the plan — go straight to generation.
      if (!plan) {
        prompt += `\n\n${PRESENTATION_WORKFLOW}`;
      }
      prompt += `\n\n${getPresentationPrompt()}`;

      // Mode-specific narrative stance
      if (plan) {
        if (plan.mode === 'author') {
          prompt += `\n\n${AUTHOR_MODE_PROMPT}`;
        } else if (plan.mode === 'journal_club') {
          prompt += `\n\n${JOURNAL_CLUB_PROMPT}`;
        }

        // Inject the narrative arc as a structural guide for Pass 2
        if (plan.narrative_arc.length > 0) {
          // Pre-compute mapping from visual_need → catalog ef_N IDs
          const figureMap = new Map<number, string>(); // slide_number → ef_N
          for (const entry of plan.narrative_arc) {
            if (!entry.visual_need) continue;
            const vn = entry.visual_need.toLowerCase();
            // Strategy 1: Direct ef_N reference from the planner (e.g., "ef_5: unconnectable peers")
            const directRef = vn.match(/^(ef_\d+)/);
            if (directRef) {
              const fig = plan.figures.find(f => f.id === directRef[1]);
              if (fig) {
                console.log(`[FigureMap] Slide ${entry.slide_number}: direct ref → ${fig.id} (${fig.label})`);
                figureMap.set(entry.slide_number, fig.id); continue;
              }
            }
            // Strategy 2: Match by figure/table label (e.g., "Figure 3" or "Table 2")
            const labelMatch = vn.match(/(figure|fig\.?|table|tab\.?)\s*([ivxlcdm\d]+\w*)/i);
            if (labelMatch) {
              const vnType = labelMatch[1].toLowerCase().startsWith('fig') ? 'fig' : 'tab';
              const vnNumber = labelMatch[2].toLowerCase();
              for (const fig of plan.figures) {
                const fl = (fig.label || '').toLowerCase();
                const flMatch = fl.match(/(figure|fig\.?|table|tab\.?)\s*([ivxlcdm\d]+\w*)/i);
                if (flMatch) {
                  const fType = flMatch[1].toLowerCase().startsWith('fig') ? 'fig' : 'tab';
                  if (vnType === fType && vnNumber === flMatch[2].toLowerCase()) {
                    console.log(`[FigureMap] Slide ${entry.slide_number}: label match "${labelMatch[0]}" → ${fig.id} (${fig.label})`);
                    figureMap.set(entry.slide_number, fig.id); break;
                  }
                }
              }
              if (figureMap.has(entry.slide_number)) continue;
            }
            // Strategy 3: Description similarity fallback — find the figure whose description
            // best matches the visual_need text (excluding the ef_N prefix)
            const descPart = vn.replace(/^ef_\d+[:\s]*/, '').trim();
            if (descPart.length > 5) {
              let bestMatch: ExtractedFigure | null = null;
              let bestScore = 0;
              const vnWords = new Set(descPart.split(/\s+/).filter(w => w.length > 3));
              for (const fig of plan.figures) {
                const figDesc = (fig.description || '').toLowerCase();
                const figWords = new Set(figDesc.split(/\s+/).filter(w => w.length > 3));
                let overlap = 0;
                for (const w of vnWords) { if (figWords.has(w)) overlap++; }
                const score = vnWords.size > 0 ? overlap / vnWords.size : 0;
                if (score > bestScore) { bestScore = score; bestMatch = fig; }
              }
              if (bestMatch && bestScore >= 0.3) {
                console.log(`[FigureMap] Slide ${entry.slide_number}: desc match (${(bestScore * 100).toFixed(0)}%) → ${bestMatch.id} (${bestMatch.label})`);
                figureMap.set(entry.slide_number, bestMatch.id);
              } else {
                console.warn(`[FigureMap] Slide ${entry.slide_number}: NO MATCH for visual_need="${entry.visual_need}"`);
              }
            }
          }

          // Log the full mapping summary for debugging
          console.log(`[FigureMap] Summary: ${figureMap.size} slides mapped:`,
            [...figureMap.entries()].map(([s, id]) => {
              const fig = plan.figures.find(f => f.id === id);
              return `  Slide ${s} → ${id} (${fig?.label || '?'})`;
            }).join('\n'));

          // Build arc lines with explicit extractedId assignments
          const arcLines = plan.narrative_arc.map(e => {
            const efId = figureMap.get(e.slide_number);
            if (efId) {
              const fig = plan.figures.find(f => f.id === efId);
              const paperLabel = fig?.label ? ` [${fig.label}]` : '';
              return `Slide ${e.slide_number}: "${e.title}" — FIGURE: {"type": "extracted_ref", "extractedId": "${efId}"}${paperLabel} — ${e.purpose}`;
            }
            return `Slide ${e.slide_number}: "${e.title}" — FIGURE: none (text-only or SVG) — ${e.purpose}`;
          }).join('\n');

          prompt += `\n\nSLIDE PLAN (follow this structure exactly):
${arcLines}

FIGURE RULES:
1. MANDATORY: Copy the exact FIGURE JSON shown above into each slide's "figure" field. Do NOT choose a different extractedId.
2. The figure assignments above are pre-verified. Do NOT override them based on your own image analysis.
3. For slides with FIGURE: none, use SVG diagrams or text-only layouts.
4. Do NOT create SVG diagrams for figures/tables that exist in the EXTRACTED FIGURE CATALOG.
5. Do NOT predict new crop coordinates — use only the pre-cropped figures from the catalog.`;
        }

        // Paper summary for additional context
        if (plan.paper_summary) {
          prompt += `\n\nPAPER SUMMARY: ${plan.paper_summary}`;
        }
      }
    }

    // Memory context — always include
    const memoryCtx = memory.getMemoryContext();
    if (memoryCtx) {
      prompt += memoryCtx;
    }

    // PDF context
    if (pdf.pdfDoc && pdf.pdfTotalPages > 0) {
      prompt += `\n\nPDF CONTEXT: A ${pdf.pdfTotalPages}-page PDF document is uploaded. You can reference specific pages and regions using pdf_crop figures in presentations. Thumbnails of the PDF pages are provided as images in the conversation.`;
    }

    // Presentation Q&A mode — when slides exist but user is NOT requesting a new presentation
    const presState = presentation.presentationRef.current;
    if (!isPres && presState.slides.length > 0) {
      // Detect which slide the user is asking about
      const lastUserMsg = userText.toLowerCase();
      const slideNumMatch = lastUserMsg.match(/slide\s*(\d+)/i);
      const referencedSlideNum = slideNumMatch ? parseInt(slideNumMatch[1]) : null;

      // Build slide index: brief for all slides, expanded for the referenced slide
      const slideIndex = presState.slides.map((s, i) => {
        const num = i + 1;
        const viewing = i === presState.currentSlide ? ' ← CURRENTLY VIEWING' : '';
        const isReferenced = referencedSlideNum === num;
        const figTag = s.figure?.label
          ? ` [${s.figure.label}]`
          : s.figure?.type === 'svg'
            ? ' [SVG diagram]'
            : '';

        if (isReferenced) {
          // Expanded details for the slide the user asked about
          const bullets = s.content?.length ? s.content.join(' | ') : '(no bullets)';
          const notes = s.speakerNotes ? `\n    Speaker notes: ${s.speakerNotes}` : '';
          const refs = s.references?.length ? `\n    References: ${s.references.join('; ')}` : '';
          const figDesc = s.figure?.description ? `\n    Figure description: ${s.figure.description}` : '';
          return `>>> SLIDE ${num}: "${s.title}"${viewing}${figTag} <<<\n    Bullets: ${bullets}${figDesc}${refs}${notes}`;
        }
        // Brief entry for other slides
        const bullets = s.content?.length ? ' — ' + s.content.slice(0, 2).join(' | ') : '';
        return `  ${num}. "${s.title}"${viewing}${figTag}${bullets}`;
      }).join('\n');

      prompt += `\n\nPRESENTATION Q&A — You presented "${presState.title}" (${presState.slides.length} slides). Answer as the presenter.

SLIDE CONTENTS (${presState.slides.length} slides, numbered 1–${presState.slides.length}):
${slideIndex}

RULES:
- When the user says "slide N", respond about EXACTLY the slide numbered ${referencedSlideNum || 'N'} above. Slide 1 = first slide (title). Do NOT recount or skip.
- When a slide's figure image is provided in the conversation, describe what you SEE in the image — do not guess from text alone.
- If the user asks about "this figure" or "this slide" without a number, use the CURRENTLY VIEWING slide.`;
    }

    // Detect poster intent — separate from presentation intent
    const isPoster = isPosterIntent(userText, messages);
    if (isPoster && !isPres) {
      prompt += `\n\n${POSTER_WORKFLOW}`;
      prompt += `\n\n${getPosterPrompt()}`;

      // Include extracted figure catalog so the model can reference them
      if (extractedFiguresRef.current && extractedFiguresRef.current.length > 0) {
        const figCatalog = extractedFiguresRef.current.map(f =>
          `- ${f.id}: ${f.kind} on page ${f.page}${f.label ? ` (${f.label})` : ''}: ${f.description}`
        ).join('\n');
        prompt += `\n\nEXTRACTED FIGURE CATALOG (use "extracted_ref" type with these IDs):\n${figCatalog}`;
      }
    }

    // Image catalog
    const { catalog, prompt: catalogPrompt } = buildImageCatalog(uploadedFiles, null);
    imageCatalogRef.current = catalog;
    if (catalogPrompt) {
      prompt += catalogPrompt;
    }

    // When NOT a presentation or poster, append intent meta-instruction so the model
    // can signal [PRESENTATION_INTENT] or [POSTER_INTENT] for non-English requests.
    // This has zero overhead for chat — the model just answers normally.
    if (!isPres && !isPoster) {
      prompt += INTENT_META_INSTRUCTION;
    }

    return prompt;
  }, [memory, messages, pdf.pdfDoc, pdf.pdfTotalPages, presentation.presentationRef, uploadedFiles]);

  // ── Build API messages ────────────────────────────────────
  // forcePresIntent overrides the keyword check (used after model-based intent detection).
  // extractedFiguresRef holds the result of Pass 1 extraction (populated in sendMessage, consumed in buildApiMessages)
  const extractedFiguresRef = useRef<ExtractedFigure[] | null>(null);

  const buildApiMessages = useCallback((userText: string, forcePresIntent?: boolean): Array<{
    role: 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }> => {
    const isPres = forcePresIntent ?? isPresentationIntent(userText, messages);
    const isPoster = !isPres && isPosterIntent(userText, messages);
    const apiMessages: Array<{
      role: 'user' | 'assistant';
      content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    }> = [];

    // 1. PDF context — smart routing: images for visual tasks, text for everything else
    const hasPdf = pdf.pdfThumbnails.length > 0 || (pdf.pdfTextPages && pdf.pdfTextPages.length > 0);
    // Detect visual need early — also used to control history size (step 2)
    const needsVisual = hasPdf && (
      isPres || isPoster ||
      /\b(figure|diagram|table|chart|image|graph|plot|illustration|photo|picture|visual|layout)\b/i.test(userText.toLowerCase())
    );
    if (hasPdf) {

      // Detect page range from user message (e.g. "pages 3-5", "page 7")
      const pageRangeMatch = userText.match(/pages?\s*(\d+)\s*(?:[-–to]+\s*(\d+))?/i);

      // Check if Pass 1 extraction produced figures (set by sendMessage before calling buildApiMessages)
      const extractedFigures = extractedFiguresRef.current;

      if ((isPres || isPoster) && pdf.pdfThumbnails.length > 0 && !thumbnailsSentRef.current) {
        if (extractedFigures && extractedFigures.length > 0) {
          // ── Pass 2: Catalog-based presentation generation (cheap) ──
          // Send extracted figure catalog + compressed crop images + PDF text
          // Instead of all 30 full-page thumbnails (~$1+), we send small crops + text (~$0.10-0.30)
          const catalog = buildExtractedFigureCatalog(extractedFigures);
          const catalogBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

          catalogBlocks.push({
            type: 'text',
            text: `${catalog}\n\nPre-cropped images of each extracted visual element:`,
          });

          for (const fig of extractedFigures) {
            const imgURL = fig.apiDataURL || fig.croppedDataURL;
            if (imgURL) {
              catalogBlocks.push({
                type: 'text',
                text: `--- ${fig.id}: ${fig.label || fig.kind} (page ${fig.page}) ---`,
              });
              catalogBlocks.push({
                type: 'image_url',
                image_url: { url: imgURL },
              });
            }
          }

          // Include PDF text: main body + references only (no appendix/supplementary/checklist)
          // We send all main content without token budget truncation — modern models handle it fine.
          const { mainContentEnd, referencesPage, postReferencesPage, totalPages: detectedPages } =
            detectMainContentEnd(pdf.pdfTextPages);

          let textContent = `\nPDF Document Text (main body + references, ${mainContentEnd} of ${pdf.pdfTotalPages} pages):\n\n`;
          for (let i = 0; i < mainContentEnd; i++) {
            if (pdf.pdfTextPages[i]) {
              textContent += `--- PAGE ${i + 1} ---\n${pdf.pdfTextPages[i]}\n\n`;
            }
          }
          if (mainContentEnd < pdf.pdfTotalPages) {
            textContent += `\n--- Pages ${mainContentEnd + 1}–${pdf.pdfTotalPages} are appendix/supplementary material (not included for slide generation). ---\n`;
          }
          // Log clear breakdown of which pages were sent
          const sections: string[] = [];
          if (referencesPage) {
            sections.push(`  Main body:      pages 1–${referencesPage - 1}`);
            sections.push(`  References:     pages ${referencesPage}–${mainContentEnd}`);
          } else {
            sections.push(`  Content:        pages 1–${mainContentEnd}`);
            sections.push(`  References:     not detected`);
          }
          if (postReferencesPage) {
            sections.push(`  Post-refs:      pages ${postReferencesPage}–${pdf.pdfTotalPages} (EXCLUDED)`);
          }
          console.log(
            `[API] Pass 2 text sent to model:\n` +
            `  Pages sent:     1–${mainContentEnd} (${mainContentEnd} of ${pdf.pdfTotalPages} total)\n` +
            sections.join('\n') + '\n' +
            `  Text size:      ~${Math.round(textContent.length / 4)} tokens (${textContent.length} chars)`
          );
          catalogBlocks.push({ type: 'text', text: textContent });

          apiMessages.push({ role: 'user' as const, content: catalogBlocks });
          apiMessages.push({
            role: 'assistant' as const,
            content: `I've received the extracted figure catalog with ${extractedFigures.length} pre-identified visual elements, their cropped images, and the full paper text. I'll use "extracted_ref" to reference these figures when building ${isPoster ? 'the poster' : 'slides'}.`,
          });
          thumbnailsSentRef.current = true;

          const cropCount = extractedFigures.filter(f => f.apiDataURL || f.croppedDataURL).length;
          console.log(`[API] Pass 2: catalog (${extractedFigures.length} figures, ${cropCount} crops) + text (${mainContentEnd} pages) — skipping ${pdf.pdfThumbnails.length} full-page thumbnails`);
        } else {
          // Fallback: no extraction or no figures found — send all thumbnails (existing behavior)
          let startIdx = 0;
          let endIdx = pdf.pdfThumbnails.length;
          if (pageRangeMatch) {
            const from = parseInt(pageRangeMatch[1], 10);
            const to = pageRangeMatch[2] ? parseInt(pageRangeMatch[2], 10) : from;
            startIdx = Math.max(0, from - 1);
            endIdx = Math.min(pdf.pdfThumbnails.length, to);
          }
          const thumbnailBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

          const sendingAll = startIdx === 0 && endIdx === pdf.pdfThumbnails.length;
          const pageRangeLabel = sendingAll
            ? `all ${pdf.pdfTotalPages} pages`
            : `pages ${startIdx + 1}–${endIdx} of ${pdf.pdfTotalPages}`;
          thumbnailBlocks.push({
            type: 'text',
            text: `Here are high-resolution images of ${pageRangeLabel} of the uploaded PDF. LOOK AT EACH PAGE IMAGE to identify exactly where figures, tables, and diagrams are positioned. When specifying crop regions [left, top, right, bottom], use what you SEE in these images.`,
          });

          for (let i = startIdx; i < endIdx; i++) {
            if (pdf.pdfThumbnails[i]) {
              thumbnailBlocks.push({
                type: 'image_url',
                image_url: { url: pdf.pdfThumbnails[i] },
              });
            }
          }

          apiMessages.push({ role: 'user' as const, content: thumbnailBlocks });
          apiMessages.push({
            role: 'assistant' as const,
            content: 'I have carefully examined each page image. I can see exactly where figures, tables, and diagrams are positioned on each page, and I will use precise [left, top, right, bottom] coordinates based on what I see.',
          });
          thumbnailsSentRef.current = true;
        }
      } else if (needsVisual && pageRangeMatch && pdf.pdfThumbnails.length > 0) {
        // Figure Q&A with page reference — send only the targeted page(s), not all 30
        const from = parseInt(pageRangeMatch[1], 10);
        const to = pageRangeMatch[2] ? parseInt(pageRangeMatch[2], 10) : from;
        const startIdx = Math.max(0, from - 1);
        const endIdx = Math.min(pdf.pdfThumbnails.length, to);
        const pageRangeLabel = `pages ${startIdx + 1}–${endIdx} of ${pdf.pdfTotalPages}`;

        const thumbnailBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        thumbnailBlocks.push({
          type: 'text',
          text: `The user is asking about a figure/visual. Here are images of ${pageRangeLabel}:`,
        });
        for (let i = startIdx; i < endIdx; i++) {
          if (pdf.pdfThumbnails[i]) {
            thumbnailBlocks.push({ type: 'image_url', image_url: { url: pdf.pdfThumbnails[i] } });
          }
        }
        console.log(`[API] Figure Q&A: sending ${endIdx - startIdx} page thumbnail(s) (pages ${startIdx + 1}–${endIdx})`);
        apiMessages.push({ role: 'user' as const, content: thumbnailBlocks });
        apiMessages.push({
          role: 'assistant' as const,
          content: `I can see the requested PDF page(s). I'll examine the figures and visuals on ${pageRangeLabel}.`,
        });
      } else if (needsVisual && pdf.figureIndex.length > 0 && pdf.pdfThumbnails.length > 0) {
        // Figure Q&A via local index — look up figure/table label and send that page
        const figureRefMatch = userText.match(
          /\b(?:Supplementary\s+)?(?:Figure|Fig\.?|Table|Equation|Eq\.?|Scheme|Chart|Plate|Box)\s*\.?\s*(\d+[a-zA-Z]?(?:\.\d+)?)/i
        );
        if (figureRefMatch) {
          const queryNum = figureRefMatch[1];
          const queryType = figureRefMatch[0].toLowerCase().replace(/[.\s]*\d.*/, '').trim(); // e.g. "figure", "table"
          const entry = pdf.figureIndex.find(e =>
            e.label.toLowerCase().includes(queryNum) &&
            e.type.includes(queryType.replace(/\./, ''))
          );
          if (entry && pdf.pdfThumbnails[entry.page - 1]) {
            const thumbnailBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
            thumbnailBlocks.push({
              type: 'text',
              text: `The user is asking about ${entry.label} (found on page ${entry.page} of ${pdf.pdfTotalPages}). Here is the full page:`,
            });
            thumbnailBlocks.push({ type: 'image_url', image_url: { url: pdf.pdfThumbnails[entry.page - 1] } });
            // Include that page's extracted text for caption/context
            if (pdf.pdfTextPages[entry.page - 1]) {
              thumbnailBlocks.push({ type: 'text', text: `Page ${entry.page} text:\n${pdf.pdfTextPages[entry.page - 1]}` });
            }
            console.log(`[API] Figure Q&A via index: ${entry.label} → page ${entry.page}`);
            apiMessages.push({ role: 'user' as const, content: thumbnailBlocks });
            apiMessages.push({
              role: 'assistant' as const,
              content: `I can see ${entry.label} on page ${entry.page}. I'll examine it carefully.`,
            });
          }
          // If not found in index, fall through to text mode below
        }
        // If no figureRefMatch, fall through to text mode below
      }

      // ── Slide visual context injection ──────────────────────────
      // When the user asks about a specific slide, send:
      //   1. The figure image (pdf_crop or uploaded image) as image_url
      //   2. Full slide data as structured text (title, bullets, notes, refs, figure metadata)
      //   3. SVG source for SVG figures (model can read XML to understand diagrams)
      //   4. Source page text from the PDF
      // Detection: explicit "slide N" reference, or implicit "this figure/plot" while viewing a slide.
      const presStateForQA = presentation.presentationRef.current;
      const slideRefMatch = userText.match(/slide\s*#?\s*(\d+)/i);
      const isImplicitSlideRef = !slideRefMatch && presStateForQA.slides.length > 0 &&
        /\b(this|the|that|current)\b.*\b(figure|plot|graph|chart|diagram|table|image|visual|slide|result)\b/i.test(userText);
      const targetSlideNum = slideRefMatch
        ? parseInt(slideRefMatch[1], 10)
        : isImplicitSlideRef
          ? presStateForQA.currentSlide + 1  // currentSlide is 0-indexed
          : null;

      if (targetSlideNum && targetSlideNum <= presStateForQA.slides.length) {
        const slideIdx = targetSlideNum - 1;
        const slide = presStateForQA.slides[slideIdx];
        const refType = slideRefMatch ? 'explicit' : 'implicit (currently viewing)';
        console.log(`[API] Slide Q&A: detected ${refType} reference to slide ${targetSlideNum}`);

        if (slide) {
          const contentBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

          // a. Figure image — synchronous: use existing croppedDataURL/src for raster figures
          const fig = slide.figure;
          let figImageSent = false;
          if (fig) {
            const figDataURL = fig.croppedDataURL || fig.src;
            if (figDataURL) {
              contentBlocks.push({
                type: 'text',
                text: `The user is asking about slide ${targetSlideNum}: "${slide.title}". Here is the figure image from this slide:`,
              });
              contentBlocks.push({ type: 'image_url', image_url: { url: figDataURL } });
              figImageSent = true;
              console.log(`[API] Slide Q&A: sending figure image for slide ${targetSlideNum} (${fig.label || fig.type}, ${figDataURL.length} chars)`);
            } else if (fig.page && pdf.pdfThumbnails[fig.page - 1]) {
              // No crop — fall back to full page thumbnail
              contentBlocks.push({
                type: 'text',
                text: `The user is asking about slide ${targetSlideNum}: "${slide.title}". The figure is from page ${fig.page}. Here is the full page:`,
              });
              contentBlocks.push({ type: 'image_url', image_url: { url: pdf.pdfThumbnails[fig.page - 1] } });
              figImageSent = true;
              console.log(`[API] Slide Q&A: sending page ${fig.page} thumbnail for slide ${targetSlideNum} (no crop available)`);
            }
          }

          if (!figImageSent) {
            contentBlocks.push({
              type: 'text',
              text: `The user is asking about slide ${targetSlideNum}: "${slide.title}".`,
            });
          }

          // b. Full slide data as structured text
          const slideData: Record<string, unknown> = {
            slideNumber: targetSlideNum,
            title: slide.title,
            content: slide.content,
            speakerNotes: slide.speakerNotes,
            references: slide.references,
            layout: slide.layout,
          };
          if (fig) {
            slideData.figure = {
              type: fig.type,
              label: fig.label,
              description: fig.description,
              caption: fig.caption,
              page: fig.page,
            };
            // c. SVG source — model can read XML to understand generated diagrams
            if (fig.type === 'svg' && fig.content) {
              slideData.svgContent = fig.content;
            }
          }
          contentBlocks.push({
            type: 'text',
            text: `Full slide data:\n${JSON.stringify(slideData, null, 2)}`,
          });

          // d. Source page text from the PDF (where the figure originates)
          if (fig?.page && pdf.pdfTextPages[fig.page - 1]) {
            contentBlocks.push({
              type: 'text',
              text: `Source page ${fig.page} text:\n${pdf.pdfTextPages[fig.page - 1]}`,
            });
          }

          apiMessages.push({ role: 'user' as const, content: contentBlocks });
          apiMessages.push({
            role: 'assistant' as const,
            content: figImageSent
              ? `I can see the figure from slide ${targetSlideNum} ("${slide.title}") and I have the full slide data including speaker notes and references. I'll examine it carefully to answer your question.`
              : `I have the full data for slide ${targetSlideNum} ("${slide.title}") including speaker notes and references. How can I help?`,
          });
        }
      }

      // Text mode — send full paper text for Q&A context.
      // This is additive: if slide visual was injected above, text is still appended.
      if (pdf.pdfTextPages && pdf.pdfTextPages.length > 0) {
        const hasSlides = presStateForQA.slides.length > 0;

        // Full text mode — send ALL extracted text for Q&A (no truncation)
        // The model needs complete paper context to answer questions properly,
        // including appendices and supplementary material.
        // This applies to BOTH post-presentation Q&A and standalone Q&A.
        {
          const qaLabel = hasSlides && !isPres ? 'Post-pres Q&A' : 'Q&A';
          let textContent = `PDF Document (${pdf.pdfTotalPages} pages) — Full Extracted Text:\n\n`;
          let includedPages = 0;
          for (let i = 0; i < pdf.pdfTextPages.length; i++) {
            if (pdf.pdfTextPages[i]) {
              textContent += `--- PAGE ${i + 1} ---\n${pdf.pdfTextPages[i]}\n\n`;
              includedPages++;
            }
          }
          console.log(`[API] ${qaLabel} full text: ${includedPages} pages, ~${Math.round(textContent.length / 4)} tokens`);
          apiMessages.push({ role: 'user' as const, content: textContent });
          apiMessages.push({
            role: 'assistant' as const,
            content: `I've read the full text of the ${pdf.pdfTotalPages}-page PDF document. I can answer questions about any part of the paper. What would you like to know?`,
          });
        }
      }
    }

    // 2. Conversation history
    // For visual/presentation requests the PDF thumbnails already consume most of
    // the context budget, so we send fewer history messages and strip old image
    // attachments to avoid blowing past the model's context window or credits.
    const isVisualRequest = needsVisual;
    const historyLimit = isVisualRequest ? 6 : 20; // 3 pairs for visual, 10 for text
    const recentMessages = messages.slice(-historyLimit).filter(m => !m.isThinking);
    for (const msg of recentMessages) {
      if (msg.sender === 'user') {
        // For visual requests, strip old image attachments from history
        // (the PDF thumbnails already provide the visual context)
        if (msg.attachments && msg.attachments.length > 0 && !isVisualRequest) {
          const contentBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

          for (const att of msg.attachments) {
            if (att.mediaType?.startsWith('image/') && att.dataURL) {
              contentBlocks.push({
                type: 'image_url',
                image_url: { url: att.dataURL },
              });
            }
          }

          contentBlocks.push({
            type: 'text',
            text: msg.text,
          });

          apiMessages.push({
            role: 'user' as const,
            content: contentBlocks,
          });
        } else {
          apiMessages.push({
            role: 'user' as const,
            content: msg.text,
          });
        }
      } else if (msg.sender === 'sage') {
        // Strip bulky SVG content from old assistant messages to prevent OOM
        // during Q&A. The slide text/titles/notes/references are preserved.
        let text = msg.text;
        if (!isPres) {
          text = text.replace(/"content"\s*:\s*"<svg[^"]*"/g, '"content":"[SVG diagram]"');
          text = text.replace(/'content'\s*:\s*'<svg[^']*'/g, "'content':'[SVG diagram]'");
        }
        apiMessages.push({
          role: 'assistant' as const,
          content: text,
        });
      }
    }

    // 3. Current user message (if not already the last one)
    const lastMsg = apiMessages[apiMessages.length - 1];
    const lastIsCurrentUser = lastMsg?.role === 'user' &&
      (typeof lastMsg.content === 'string' ? lastMsg.content : '') === userText;

    if (!lastIsCurrentUser) {
      // Check if current message has image attachments
      const imageFiles = uploadedFiles.filter(f => f.mediaType?.startsWith('image/'));
      if (imageFiles.length > 0) {
        const contentBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        for (const img of imageFiles) {
          contentBlocks.push({
            type: 'image_url',
            image_url: { url: img.dataURL },
          });
        }
        contentBlocks.push({ type: 'text', text: userText });
        apiMessages.push({ role: 'user' as const, content: contentBlocks });
      } else {
        apiMessages.push({ role: 'user' as const, content: userText });
      }
    }

    // 4. Inject slide count reminder for presentation requests
    if (isPres) {
      const slideCountMatch = userText.match(/(\d+)\s*(content\s+)?(?:slides?|slayt)/i);
      if (slideCountMatch) {
        const n = parseInt(slideCountMatch[1], 10);
        // Append a strong reminder as a separate user message
        apiMessages.push({
          role: 'user' as const,
          content: `⚠️ CRITICAL: The user asked for EXACTLY ${n} content slides. Your JSON array must have EXACTLY ${n + 4} slides total (1 title + 1 overview + ${n} content + 1 references + 1 closing). Do NOT generate more or fewer than ${n} content slides. If you find yourself exceeding ${n}, STOP and remove the extra content slides before outputting.`,
        });
      }
    }

    return apiMessages;
  }, [messages, pdf.pdfThumbnails, pdf.pdfTextPages, pdf.pdfTotalPages, uploadedFiles, availableModels, selectedModel]);

  // ── Cancel generation ─────────────────────────────────────
  const cancelGeneration = useCallback(() => {
    const gen = requestGenRef.current;
    cancelledGens.current.add(gen);
    abortRef.current?.abort();
    abortRef.current = null;
    presInProgressRef.current = false;
    setIsLoading(false);
    setLoadingMsg('');
  }, []);

  // ── Handle send ───────────────────────────────────────────
  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (overrideText || input).trim();
    if (!text || isLoading) return;

    setError(null);
    setInput('');

    // ── Assessment mode intercept ─────────────────────────
    const assessment = assessmentStateRef.current;
    const presSlides = presentation.presentationRef.current.slides;

    // Quit assessment
    if (assessment.phase === 'active' && isQuitIntent(text)) {
      const quitUserMsg: Message = { id: Date.now(), sender: 'user', text };
      const quitSageMsg: Message = { id: Date.now() + 1, sender: 'sage', text: 'Assessment cancelled. Feel free to ask questions or say **assess me** to try again.' };
      setMessages(prev => [...prev, quitUserMsg, quitSageMsg]);
      const resetState = createInitialAssessmentState();
      resetState.offeredThisPresentation = true; // Don't re-offer
      setAssessmentState(resetState);
      assessmentStateRef.current = resetState;
      return;
    }

    // Start assessment
    if (assessment.phase === 'idle' && presSlides.length > 0 && isAssessmentIntent(text)) {
      const userMsg: Message = { id: Date.now(), sender: 'user', text };
      setMessages(prev => [...prev, userMsg]);
      setIsLoading(true);
      setLoadingMsg('Preparing assessment...');

      const newState: AssessmentState = {
        ...createInitialAssessmentState(),
        phase: 'active',
        offeredThisPresentation: true,
      };
      setAssessmentState(newState);
      assessmentStateRef.current = newState;

      try {
        const slideSummaries = buildSlideSummaries(presSlides);
        const tier = selectTier(newState.theta);
        const systemPrompt = buildAssessmentSystemPrompt(slideSummaries, newState, tier);

        const { content: qRaw } = await callChat({
          messages: [{ role: 'user', content: 'Begin the assessment. Ask me your first question.' }],
          model: selectedModel,
          max_tokens: 1024,
          system: systemPrompt,
        }, apiKey);

        const parsed = parseQuestionResponse(qRaw);
        if (!parsed) throw new Error('Failed to parse question from model response');

        const question: AssessmentQuestion = {
          questionNumber: 1,
          tier,
          question: parsed.question,
          slideContext: parsed.slideContext,
        };

        const updatedState: AssessmentState = {
          ...newState,
          currentQuestionNumber: 1,
          questions: [question],
        };
        setAssessmentState(updatedState);
        assessmentStateRef.current = updatedState;

        const sageMsg: Message = {
          id: Date.now() + 1,
          sender: 'sage',
          text: `**Question 1** (Tier ${tier})\n\n${parsed.question}`,
        };
        setMessages(prev => [...prev, sageMsg]);

        // Save session
        await sessions.saveSession(
          [...messages, userMsg, sageMsg], sessions.currentSessionId || undefined,
          uploadedFiles,
          presSlides.length > 0 ? presentation.presentationRef.current : null,
          pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel, presentation.getNarrativeArc(), auditResults,
        );
      } catch (err) {
        console.error('[Assessment] Failed to start:', err);
        setError('Failed to start assessment. Please try again.');
        setAssessmentState(createInitialAssessmentState());
        assessmentStateRef.current = createInitialAssessmentState();
      } finally {
        setIsLoading(false);
        setLoadingMsg('');
      }
      return;
    }

    // Active assessment: evaluate answer + ask next question (or report)
    if (assessment.phase === 'active') {
      const userMsg: Message = { id: Date.now(), sender: 'user', text };
      setMessages(prev => [...prev, userMsg]);
      setIsLoading(true);
      setLoadingMsg('Evaluating your answer...');

      try {
        const slideSummaries = buildSlideSummaries(presSlides);
        const currentQ = assessment.questions[assessment.questions.length - 1];

        // Evaluate the answer
        const evalPrompt = buildEvaluationSystemPrompt(slideSummaries, currentQ, text);
        const { content: evalRaw } = await callChat({
          messages: [{ role: 'user', content: text }],
          model: selectedModel,
          max_tokens: 1024,
          system: evalPrompt,
        }, apiKey);

        const evalResult = parseEvaluationResponse(evalRaw);
        if (!evalResult) throw new Error('Failed to parse evaluation from model response');

        const answer: AssessmentAnswer = {
          questionNumber: currentQ.questionNumber,
          userAnswer: text,
          score: evalResult.score,
          acknowledgment: evalResult.acknowledgment,
          tier: currentQ.tier,
          slideContext: currentQ.slideContext,
        };

        // Update theta and streak counters
        const newTheta = computeNextTheta(assessment.theta, evalResult.score);
        const consT3 = evalResult.score === 1 && currentQ.tier === 3
          ? assessment.consecutiveT3Correct + 1 : (currentQ.tier === 3 ? 0 : assessment.consecutiveT3Correct);
        const consT1 = evalResult.score === 0 && currentQ.tier === 1
          ? assessment.consecutiveT1Incorrect + 1 : (currentQ.tier === 1 ? 0 : assessment.consecutiveT1Incorrect);

        const updatedState: AssessmentState = {
          ...assessment,
          theta: newTheta,
          answers: [...assessment.answers, answer],
          consecutiveT3Correct: consT3,
          consecutiveT1Incorrect: consT1,
        };

        const scoreIcon = evalResult.score === 1 ? '\u2705' : evalResult.score === 0.5 ? '\u26A0\uFE0F' : '\u274C';
        let sageText = `${scoreIcon} ${evalResult.acknowledgment}`;

        // Check stop condition
        if (shouldStopAssessment(updatedState)) {
          updatedState.phase = 'report';
          const report = buildGapReport(updatedState);
          sageText += `\n\n${report}`;
        } else {
          // Ask next question
          const nextTier = selectTier(newTheta);
          const nextQNum = assessment.currentQuestionNumber + 1;

          setLoadingMsg('Preparing next question...');
          const qPrompt = buildAssessmentSystemPrompt(slideSummaries, updatedState, nextTier);
          const { content: qRaw } = await callChat({
            messages: [{ role: 'user', content: 'Next question.' }],
            model: selectedModel,
            max_tokens: 1024,
            system: qPrompt,
          }, apiKey);

          const parsed = parseQuestionResponse(qRaw);
          if (!parsed) throw new Error('Failed to parse next question');

          const nextQ: AssessmentQuestion = {
            questionNumber: nextQNum,
            tier: nextTier,
            question: parsed.question,
            slideContext: parsed.slideContext,
          };

          updatedState.currentQuestionNumber = nextQNum;
          updatedState.questions = [...updatedState.questions, nextQ];

          sageText += `\n\n---\n\n**Question ${nextQNum}** (Tier ${nextTier})\n\n${parsed.question}`;
        }

        setAssessmentState(updatedState);
        assessmentStateRef.current = updatedState;

        const sageMsg: Message = { id: Date.now() + 1, sender: 'sage', text: sageText };
        setMessages(prev => [...prev, sageMsg]);

        // Save session
        await sessions.saveSession(
          [...messages, userMsg, sageMsg], sessions.currentSessionId || undefined,
          uploadedFiles,
          presSlides.length > 0 ? presentation.presentationRef.current : null,
          pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel, presentation.getNarrativeArc(), auditResults,
        );
      } catch (err) {
        console.error('[Assessment] Evaluation failed:', err);
        setError('Failed to evaluate answer. Please try again.');
      } finally {
        setIsLoading(false);
        setLoadingMsg('');
      }
      return;
    }

    // Assessment report: handle follow-up options (1=breakdown, 2=re-explain, 3=retry)
    if (assessment.phase === 'report') {
      const userMsg: Message = { id: Date.now(), sender: 'user', text };
      setMessages(prev => [...prev, userMsg]);

      const lower = text.toLowerCase().trim();
      if (lower === '1' || /full\s*breakdown/i.test(lower) || /detail/i.test(lower)) {
        const breakdown = buildFullBreakdown(assessment);
        const sageMsg: Message = { id: Date.now() + 1, sender: 'sage', text: breakdown };
        setMessages(prev => [...prev, sageMsg]);
        // Stay in report phase — user can still pick option 2 or 3
        return;
      }

      if (lower === '3' || /try\s*again|retake|retry/i.test(lower)) {
        // Reset and restart assessment
        const resetState = createInitialAssessmentState();
        resetState.offeredThisPresentation = true;
        setAssessmentState(resetState);
        assessmentStateRef.current = resetState;
        // Trigger assessment via recursive call
        handleSend('assess me');
        return;
      }

      if (lower === '2' || /re-?explain|teach/i.test(lower)) {
        // Exit assessment mode, let normal Q&A handle re-explanation
        const resetState = createInitialAssessmentState();
        resetState.offeredThisPresentation = true;
        setAssessmentState(resetState);
        assessmentStateRef.current = resetState;
        // Build a re-explain prompt from weak concepts
        const weakConcepts = [...new Set(
          assessment.answers.filter(a => a.score === 0).map(a => a.slideContext)
        )];
        if (weakConcepts.length > 0) {
          // Fall through to normal chat with a re-explain request
          const reExplainText = `Please re-explain these concepts in a different way: ${weakConcepts.join(', ')}`;
          handleSend(reExplainText);
          return;
        }
        // No weak concepts — just exit
        const sageMsg: Message = { id: Date.now() + 1, sender: 'sage', text: 'Great job! You had no weak areas to review. Feel free to ask any other questions.' };
        setMessages(prev => [...prev, sageMsg]);
        return;
      }

      // Unrecognized input — exit report mode, fall through to normal chat
      const resetState = createInitialAssessmentState();
      resetState.offeredThisPresentation = true;
      setAssessmentState(resetState);
      assessmentStateRef.current = resetState;
      // Don't return — let the message flow to normal chat handling below
    }

    // ── Pending plan check (Author / Journal Club modes) ──
    // If a plan is waiting for user confirmation, handle it before normal flow.
    const plan = pendingPlanRef.current;
    if (plan) {
      // Add user message to chat
      const planUserMsg: Message = { id: Date.now(), sender: 'user', text };
      setMessages(prev => [...prev, planUserMsg]);

      const planResponse = detectPlanResponse(text);
      if (planResponse === 'confirm') {
        // User confirmed — clear plan and run Pass 2
        console.log(`[Plan] User confirmed ${plan.mode} plan — starting Pass 2`);
        setPendingPlan(null);
        pendingPlanRef.current = null;
        extractedFiguresRef.current = plan.figures;
        thumbnailsSentRef.current = false; // Will be set in buildApiMessages

        // Cache narrative arc for figure enforcement during streaming
        presentation.setNarrativeContext(plan.narrative_arc, plan.figures);

        setIsLoading(true);
        presInProgressRef.current = true;
        setLoadingMsg('Generating slides...');

        const gen = ++requestGenRef.current;
        const controller = new AbortController();
        abortRef.current = controller;

        try {
          const systemPrompt = buildSystemPrompt(plan.userText, true, plan);
          const apiMessages = buildApiMessages(plan.userText, true);
          const currentModel = availableModels.find(m => m.id === selectedModel);
          const modelCap = currentModel?.maxCompletionTokens || 32000;
          const slideCountGuess = plan.userText.match(/(\d+)\s*(?:slides?|slayt)/i);
          const slides = slideCountGuess ? parseInt(slideCountGuess[1], 10) : plan.narrative_arc.length || 8;
          const maxTokens = Math.min((slides + 4) * 4000 + 2000, modelCap);
          const requestTimeout = computeTimeout(currentModel, {
            deepThinking: false,
            hasPdf: true,
            search: false,
            presentation: true,
          });

          // Add thinking placeholder
          const thinkingMsg: Message = { id: Date.now() + 1, sender: 'sage', text: '', isThinking: true };
          setMessages(prev => [...prev, thinkingMsg]);

          const chatRequest = {
            messages: apiMessages,
            model: selectedModel,
            max_tokens: maxTokens,
            system: systemPrompt,
            timeout: requestTimeout,
          };

          let streamingStarted = false;
          const incrementalParseRef2 = { current: createIncrementalParseState() };
          const streamStart2 = Date.now();

          const streamResult = await callChatStream(
            chatRequest, apiKey,
            (_delta: string, fullText: string) => {
              if (gen !== requestGenRef.current || cancelledGens.current.has(gen)) return;
              lastActivityRef.current = Date.now();
              const elapsed = Math.floor((Date.now() - streamStart2) / 1000);
              const mins = Math.floor(elapsed / 60);
              const secs = elapsed % 60;
              const timer = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;

              const { newSlides, updatedState } = extractIncrementalSlides(fullText, incrementalParseRef2.current);
              incrementalParseRef2.current = updatedState;

              if (newSlides.length > 0) {
                if (!streamingStarted) {
                  streamingStarted = true;
                  presentation.startStreamingSlides(updatedState.title, updatedState.language);
                  setActiveTab('slides');
                  setMessages(prev => prev.filter(m => !m.isThinking));
                }
                presentation.addStreamingSlides(newSlides, extractedFiguresRef.current || undefined);
              }

              if (updatedState.extractedCount > 0) {
                setLoadingMsg(`Generating slides... ${updatedState.extractedCount} received (${timer})`);
              } else {
                setLoadingMsg(`Sage is creating your presentation... (${timer})`);
              }
            },
            controller.signal,
          );

          if (gen !== requestGenRef.current || cancelledGens.current.has(gen)) return;
          presentation.finalizePresentation();

          // Capture token usage from Pass 2 stream
          if (streamResult.usage) {
            setLastTokenUsage(streamResult.usage);
          }

          // Post-generation: add assistant message confirming the mode
          const modeLabel = plan.mode === 'author' ? 'author presentation' : 'journal club analysis';
          const sageDoneMsg: Message = {
            id: Date.now() + 2,
            sender: 'sage',
            text: `Your ${modeLabel} is ready! Navigate through the slides using the controls above.`,
          };
          setMessages(prev => [...prev.filter(m => !m.isThinking), sageDoneMsg]);

          // Save session — plan confirm path doesn't reach the normal save at end of handleSend
          const msgsToSave = messages.concat(planUserMsg, sageDoneMsg);
          await sessions.saveSession(
            msgsToSave,
            sessions.currentSessionId || undefined,
            uploadedFiles,
            presentation.presentationRef.current.slides.length > 0 ? presentation.presentationRef.current : null,
            pdf.pdfPage,
            pdf.pdfZoom,
            streamResult.usage || null,
            selectedModel,
            presentation.getNarrativeArc(),
          );
        } catch (err) {
          if (gen !== requestGenRef.current || cancelledGens.current.has(gen)) return;
          console.error('[Plan Pass 2] Error:', err);
          setError(err instanceof Error ? err.message : 'Failed to generate presentation');
          setMessages(prev => prev.filter(m => !m.isThinking));
        } finally {
          setIsLoading(false);
          setLoadingMsg('');
          presInProgressRef.current = false;
        }
        return;
      } else {
        // User wants edits — send feedback to cheap model for plan revision
        console.log(`[Plan] User editing ${plan.mode} plan: "${text.slice(0, 80)}..."`);
        setIsLoading(true);
        setLoadingMsg('Revising plan...');

        try {
          const editPrompt = `You are revising a presentation slide plan based on user feedback.

Current plan (${plan.mode} mode):
${JSON.stringify(plan.narrative_arc, null, 2)}

Paper summary: ${plan.paper_summary}

Visual elements in the paper: ${plan.figures.map(f => `${f.id}: ${f.label || f.kind} (page ${f.page})`).join(', ')}

User says: "${text}"

Output ONLY valid JSON with the revised plan:
{ "narrative_arc": [...] }
Keep the same entry format: { "slide_number": N, "title": "...", "visual_need": "...", "purpose": "..." }
For "visual_need": match by DESCRIPTION CONTENT (what the figure shows), not by figure number. Format: "ef_N: brief description" (e.g. "ef_3: CDF of download speeds") or empty string for text-only slides.
ONLY reference elements from the visual elements list above.
Only modify what the user requested. Maintain reasonable slide count (${SLIDE_COUNT_GUIDANCE[plan.mode]}).
NUMBERING RULE: Use the EXACT numbering from the paper for theorems, propositions, algorithms, etc.`;

          const { content: editResponse } = await callChat({
            messages: [{ role: 'user' as const, content: editPrompt }],
            model: selectedModel,
            max_tokens: 4096,
            system: 'You are a presentation planning assistant. Output only valid JSON.',
          }, apiKey);

          // Parse the revised plan
          let updatedArc = plan.narrative_arc;
          try {
            let jsonStr = editResponse;
            const jsonBlock = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
            if (jsonBlock) jsonStr = jsonBlock[1];
            const start = jsonStr.indexOf('{');
            const end = jsonStr.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
              const parsed = JSON.parse(jsonStr.substring(start, end + 1));
              if (Array.isArray(parsed.narrative_arc)) {
                updatedArc = parsed.narrative_arc
                  .filter((e: { title?: string }) => e.title)
                  .map((e: { slide_number?: number; title: string; visual_need?: string; purpose?: string }, i: number) => ({
                    slide_number: i + 1,
                    title: e.title,
                    visual_need: typeof e.visual_need === 'string' ? e.visual_need : '',
                    purpose: e.purpose || '',
                  }));
              }
            }
          } catch (parseErr) {
            console.warn('[Plan] Failed to parse revised plan, keeping original:', parseErr);
          }

          // Update the pending plan
          const updatedPlan: PresentationPlan = { ...plan, narrative_arc: updatedArc };
          setPendingPlan(updatedPlan);
          pendingPlanRef.current = updatedPlan;

          // Post revised plan in chat
          const revisedText = formatPlanForChat(
            updatedArc, plan.paper_summary, plan.figures, plan.mode,
          );
          const revisedMsg: Message = { id: Date.now() + 2, sender: 'sage', text: revisedText };
          setMessages(prev => [...prev, revisedMsg]);

          // Save conversation with revised plan
          const currentMsgs = messages.concat(planUserMsg, revisedMsg);
          await sessions.saveSession(
            currentMsgs,
            sessions.currentSessionId || undefined,
            uploadedFiles,
            null,
            pdf.pdfPage,
            pdf.pdfZoom,
            null,
            selectedModel,
            presentation.getNarrativeArc(),
          );
        } catch (err) {
          console.error('[Plan] Edit failed:', err);
          const errorMsg: Message = {
            id: Date.now() + 2, sender: 'sage',
            text: 'I had trouble revising the plan. Could you try rephrasing your request? Or say "looks good" to proceed with the current plan.',
          };
          setMessages(prev => [...prev, errorMsg]);
        } finally {
          setIsLoading(false);
          setLoadingMsg('');
        }
        return;
      }
    }

    // Only treat as presentation intent if the *current* message asks for one.
    // Checking history caused follow-up questions to show "creating presentation..." loading.
    let presIntent = isPresentationIntent(text) && assessmentStateRef.current.phase === 'idle';
    presInProgressRef.current = presIntent;

    // Poster intent — separate from presentation intent.
    // Unlike presIntent, we DO check history here because the user's follow-up
    // (e.g. "A0 landscape, for 3DV 2026") doesn't contain "poster" but the model
    // will still respond with poster JSON. Only check history if no poster exists
    // yet — once a poster is generated, follow-ups should go through normal chat.
    const posterHistoryCtx = !posterState ? messages : undefined;
    let posterIntent = !presIntent && isPosterIntent(text, posterHistoryCtx) && assessmentStateRef.current.phase === 'idle';

    // Auto-enable search for topic presentations (no PDF) and reflect it in the UI
    if (presIntent && !pdf.pdfDoc && !searchMode) {
      setSearchMode(true);
    }
    const effectiveSearch = searchMode || (presIntent && !pdf.pdfDoc);

    // 1. Create user message
    const userMsg: Message = {
      id: Date.now(),
      sender: 'user',
      text,
      attachments: uploadedFiles
        .filter(f => f.mediaType?.startsWith('image/'))
        .map(f => ({ mediaType: f.mediaType, dataURL: f.dataURL, name: f.name })),
    };

    // Clear non-PDF files after attaching to message (original behavior)
    setUploadedFiles(prev => prev.filter(f => f.mediaType === 'application/pdf'));

    // 2. Add thinking placeholder
    const thinkingMsg: Message = {
      id: Date.now() + 1,
      sender: 'sage',
      text: '',
      isThinking: true,
    };

    const newMessages = [...messages, userMsg, thinkingMsg];
    setMessages(newMessages);
    setIsLoading(true);
    setLoadingMsg(
      deepThinking ? 'Sage is thinking deeply...'
      : presIntent ? 'Sage is creating your presentation...'
      : 'Sage is composing a response...'
    );

    // 3. Prepare API call
    const gen = ++requestGenRef.current;
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // ── Pass 1a: Figure extraction (cheap vision model) ──
      // Gemini Flash locates figures/tables/diagrams — no narrative planning here.
      extractedFiguresRef.current = null; // Reset from any previous run
      const detectedMode: PresentationMode = presIntent ? detectPresentationMode(text) : 'general';
      let activePlan: PresentationPlan | null = null;

      if ((presIntent || posterIntent) && pdf.pdfDoc && pdf.pdfThumbnails.length > 0) {
        try {
          setLoadingMsg('Analyzing paper structure and figures...');
          const extractionResult = await extractFiguresFromPdf(
            pdf.pdfThumbnails,
            pdf.pdfTextPages,
            apiKey,
            controller.signal,
            extractionModel,
          );

          if (controller.signal.aborted) throw new Error('Aborted');

          if (extractionResult.figures.length > 0) {
            setLoadingMsg(`Cropping ${extractionResult.figures.length} figures...`);
            const cropped = await preCropExtractedFigures(
              extractionResult.figures,
              pdf.pdfDoc,
              pdf.figureCacheRef.current,
            );
            extractedFiguresRef.current = cropped;
            console.log(`[Extraction] Pass 1a complete: ${cropped.length} figures cropped`,
              extractionResult.supplementaryStartPage ? `| Supplementary starts at page ${extractionResult.supplementaryStartPage}` : '');
          } else {
            console.log('[Extraction] Pass 1a found no figures — will use thumbnail fallback');
          }

          // ── Pass 1b: Narrative planning (main model, with optional deep thinking) ──
          // The main model (user's selected model) plans the slide structure using
          // the figure catalog + paper text. Deep thinking is enabled if the user has it on.
          // Skip for poster intent — poster doesn't need narrative arc planning.
          if (controller.signal.aborted) throw new Error('Aborted');

          if (presIntent) {
          setLoadingMsg(deepThinking ? 'Planning presentation (thinking deeply)...' : 'Planning presentation structure...');
          // Send full main content text (main body + references) to the planner
          const planStructure = detectMainContentEnd(pdf.pdfTextPages);
          const planMainEnd = planStructure.mainContentEnd;
          const planTextPages = pdf.pdfTextPages.slice(0, planMainEnd);
          const textSummary = planTextPages.filter(Boolean).map((p, i) => `--- PAGE ${i + 1} ---\n${p}`).join('\n\n');
          console.log(`[Planning] Sending ${planMainEnd} pages (~${Math.round(textSummary.length / 4)} tokens) to planner`);
          const planningPrompt = buildNarrativePlanningPrompt(
            extractedFiguresRef.current || extractionResult.figures,
            textSummary,
            detectedMode,
          );

          const currentModel = availableModels.find(m => m.id === selectedModel);
          const planRequest = {
            messages: [{ role: 'user' as const, content: planningPrompt }],
            model: selectedModel,
            max_tokens: 16384,
            system: 'You are a presentation planning assistant. Output ONLY valid JSON with the requested structure. No explanations, no markdown formatting outside the JSON.',
            timeout: computeTimeout(currentModel, { deepThinking, hasPdf: true, search: false, presentation: false }),
            options: {
              thinking: deepThinking,
              thinkingBudget: deepThinking ? 10000 : undefined,
            },
          };

          const planResult = await callChat(planRequest, apiKey, controller.signal);
          const { narrative_arc, paper_summary } = parseNarrativePlanResponse(planResult.content);

          console.log(`[Planning] Pass 1b complete: ${narrative_arc.length} planned slides (mode: ${detectedMode}, thinking: ${deepThinking})`,
            planResult.usage ? `| Tokens: ${planResult.usage.prompt_tokens} in / ${planResult.usage.completion_tokens} out` : '');

          // Build plan for mode-aware flow
          if (narrative_arc.length > 0) {
            activePlan = {
              mode: detectedMode,
              narrative_arc,
              paper_summary,
              figures: extractedFiguresRef.current || [],
              userText: text,
            };
            // Cache narrative arc for figure enforcement during streaming
            presentation.setNarrativeContext(narrative_arc, extractedFiguresRef.current || []);
          }

          // ── Author / Journal Club: surface plan and wait ──
          if (detectedMode !== 'general' && activePlan && activePlan.narrative_arc.length > 0) {
            const planText = formatPlanForChat(
              activePlan.narrative_arc,
              activePlan.paper_summary,
              activePlan.figures,
              activePlan.mode,
              planStructure,
            );
            const planMsg: Message = { id: Date.now() + 2, sender: 'sage', text: planText };
            setMessages(prev => [...prev.filter(m => !m.isThinking), planMsg]);

            // Store plan — pipeline pauses here until user confirms
            setPendingPlan(activePlan);
            pendingPlanRef.current = activePlan;

            console.log(`[Plan] ${detectedMode} plan surfaced — waiting for user confirmation`);

            // Save conversation so far (plan surface messages)
            const msgsToSave = [...newMessages.filter(m => !m.isThinking), planMsg];
            await sessions.saveSession(
              msgsToSave,
              sessions.currentSessionId || undefined,
              uploadedFiles,
              null,
              pdf.pdfPage,
              pdf.pdfZoom,
              null,
              selectedModel,
              presentation.getNarrativeArc(),
            );

            setIsLoading(false);
            setLoadingMsg('');
            presInProgressRef.current = false;
            return; // ← Pipeline splits here. Pass 2 runs when user confirms.
          }
          } // end if (presIntent) — skip planning for poster
        } catch (extractErr) {
          if (controller.signal.aborted) throw extractErr;
          console.warn('[Extraction/Planning] Pass 1 failed (will use thumbnail fallback):', extractErr);
          // Continue with fallback (thumbnails) — extractedFiguresRef stays null
        }
        setLoadingMsg(posterIntent ? 'Generating poster...' : 'Generating slides...');
      }

      // Build initial system prompt and messages.
      // If keywords didn't detect presentation intent, the system prompt includes
      // INTENT_META_INSTRUCTION so the model can signal [PRESENTATION_INTENT].
      // For General mode with a plan, pass the plan for structural guidance.
      let systemPrompt = buildSystemPrompt(text, presIntent, activePlan);
      let apiMessages = buildApiMessages(text, presIntent);

      // max_tokens: use user's setting for presentations, deep thinking, and PDF contexts
      let maxTokens = (deepThinking || presIntent || pdf.pdfThumbnails.length > 0)
        ? maxOutputTokens
        : 4096;

      const currentModel = availableModels.find(m => m.id === selectedModel);

      // Presentations need a LOT of tokens (SVG figures, speaker notes, references).
      // Auto-boost to a safe minimum so users don't get truncated output by default.
      if (presIntent) {
        const modelCap = currentModel?.maxCompletionTokens || 32000;
        // ~4K tokens per slide (content + SVG + notes + refs) + 2K overhead
        const slideCountGuess = text.match(/(\d+)\s*(?:slides?|slayt)/i);
        const slides = slideCountGuess ? parseInt(slideCountGuess[1], 10) : 8;
        const presMinTokens = Math.min((slides + 4) * 4000 + 2000, modelCap);
        if (maxTokens < presMinTokens) {
          console.log(`[Pres] Auto-boosting max_tokens from ${maxTokens} to ${presMinTokens} (${slides} slides estimated, model cap ${modelCap})`);
          maxTokens = presMinTokens;
        }
      }
      const requestTimeout = computeTimeout(currentModel, {
        deepThinking,
        hasPdf: hasPdfContext,
        search: effectiveSearch,
        presentation: !!presIntent,
      });

      // ── Guardrail: token estimation + hard cap ──────────────
      const approxTokens = (JSON.stringify(apiMessages).length + systemPrompt.length) / 4;
      console.log(`[API] ${presIntent ? 'PRES' : 'QA'} ~${Math.round(approxTokens)} tokens, max_out=${maxTokens}, msgs=${apiMessages.length}`);

      const MAX_QA_TOKENS = 20_000;
      // Count how many messages are trimmable conversation history (everything after
      // the first 2 PDF-context entries, minus the final user message).
      const trimmableCount = Math.max(0, apiMessages.length - 3); // 2 PDF + 1 current user
      if (!presIntent && approxTokens > MAX_QA_TOKENS && trimmableCount > 0) {
        console.warn(`[API] Q&A context exceeds ${MAX_QA_TOKENS} token cap (~${Math.round(approxTokens)}). Trimming ${trimmableCount} history messages.`);
        while (apiMessages.length > 3 && (JSON.stringify(apiMessages).length + systemPrompt.length) / 4 > MAX_QA_TOKENS) {
          apiMessages.splice(2, 1); // Remove oldest conversation message (after PDF context)
        }
        console.log(`[API] After trim: ~${Math.round((JSON.stringify(apiMessages).length + systemPrompt.length) / 4)} tokens, msgs=${apiMessages.length}`);
      }

      let chatRequest = {
        messages: apiMessages,
        model: selectedModel,
        max_tokens: maxTokens,
        system: systemPrompt,
        timeout: requestTimeout,
        options: {
          search: effectiveSearch,
          thinking: deepThinking,
          thinkingBudget: deepThinking ? 10000 : undefined,
        },
      };

      let response: string;
      let currentTokenUsage: TokenUsage | null = null;
      let currentFinishReason: string | undefined;

      // Estimate slide count from user message for realistic progress tracking
      const slideCountMatch = text.match(/(\d+)\s*(?:slides?|slayt)/i);
      const estimatedSlideCount = slideCountMatch ? parseInt(slideCountMatch[1], 10) : 15;

      try {
        if (posterIntent) {
          // Poster intent — stream silently (don't show raw JSON in chat)
          setLoadingMsg('Generating poster...');
          const posterStreamStart = Date.now();

          const posterStreamResult = await callChatStream(
            chatRequest,
            apiKey,
            (_delta, _fullText) => {
              lastActivityRef.current = Date.now();
              const elapsed = Math.floor((Date.now() - posterStreamStart) / 1000);
              const timer = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toString().padStart(2, '0')}s` : `${elapsed}s`;
              setLoadingMsg(`Generating poster... (${timer})`);
            },
            controller.signal,
          );
          response = posterStreamResult.content;
          if (posterStreamResult.finishReason) currentFinishReason = posterStreamResult.finishReason;
          if (posterStreamResult.usage) { currentTokenUsage = posterStreamResult.usage; setLastTokenUsage(posterStreamResult.usage); }
        } else if (presIntent) {
          // Mark presentation in progress for the activity-based timeout (3 min threshold vs 2 min)
          presInProgressRef.current = true;
          // Keywords matched — stream silently (don't show partial JSON), show progress %
          // Each slide averages ~3500 chars (title + bullets + speaker notes + SVG figure)
          const expectedChars = Math.min(maxTokens * 3.5, (estimatedSlideCount + 3) * 3500 + 2000);
          const streamStart = Date.now();

          // Reset incremental parse state for this new generation
          incrementalParseRef.current = createIncrementalParseState();
          let streamingStarted = false;

          const result = await callChatStream(
            chatRequest,
            apiKey,
            (_delta, fullText) => {
              lastActivityRef.current = Date.now();
              const elapsed = Math.floor((Date.now() - streamStart) / 1000);
              const mins = Math.floor(elapsed / 60);
              const secs = elapsed % 60;
              const timer = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;

              // Incremental slide extraction
              const { newSlides, updatedState } = extractIncrementalSlides(
                fullText, incrementalParseRef.current
              );
              incrementalParseRef.current = updatedState;

              if (newSlides.length > 0) {
                if (!streamingStarted) {
                  // First slides arriving — initialize streaming presentation and switch tab
                  streamingStarted = true;
                  presentation.startStreamingSlides(updatedState.title, updatedState.language);
                  setActiveTab('slides');
                }
                presentation.addStreamingSlides(newSlides, extractedFiguresRef.current || undefined);
              }

              // Update loading message
              if (updatedState.extractedCount > 0) {
                setLoadingMsg(`Generating slides... ${updatedState.extractedCount} received (${timer})`);
              } else {
                const charCount = fullText.length;
                if (charCount < 500) {
                  setLoadingMsg(`Sage is creating your presentation... (${timer})`);
                } else {
                  const rawPercent = charCount / expectedChars;
                  const estimatedPercent = rawPercent < 0.95
                    ? Math.round(rawPercent * 100)
                    : Math.min(99, 95 + Math.round(4 * (1 - Math.exp(-(rawPercent - 0.95) * 10))));
                  setLoadingMsg(`Generating presentation... ${estimatedPercent}% (${timer})`);
                }
              }
            },
            controller.signal,
          );
          response = result.content;
          if (result.finishReason) currentFinishReason = result.finishReason;
          if (result.usage) { currentTokenUsage = result.usage; setLastTokenUsage(result.usage); }
        } else {
          // Keywords missed — stream live, but watch for [PRESENTATION_INTENT] or [POSTER_INTENT] marker
          let intentDetected = false;
          let posterIntentDetected = false;
          const intentController = new AbortController();

          // Link: if user cancels, also abort the intent stream
          const onMainAbort = () => intentController.abort();
          controller.signal.addEventListener('abort', onMainAbort);

          try {
            const result = await callChatStream(
              chatRequest,
              apiKey,
              (_delta, fullText) => {
                lastActivityRef.current = Date.now();
                // Check first ~100 chars for the intent marker
                if (!intentDetected && !posterIntentDetected && fullText.length <= 150) {
                  if (fullText.includes('[PRESENTATION_INTENT]')) {
                    intentDetected = true;
                    // Abort this stream — we'll retry with full presentation prompt
                    intentController.abort();
                    return;
                  }
                  if (fullText.includes('[POSTER_INTENT]')) {
                    posterIntentDetected = true;
                    // Abort this stream — we'll retry with full poster prompt
                    intentController.abort();
                    return;
                  }
                }
                // Normal chat: stream live text into the thinking message
                setMessages(prev => prev.map(m =>
                  m.isThinking ? { ...m, text: fullText } : m
                ));
                setLoadingMsg('');
              },
              intentController.signal,
            );
            response = result.content;
            if (result.finishReason) currentFinishReason = result.finishReason;
            if (result.usage) { currentTokenUsage = result.usage; setLastTokenUsage(result.usage); }
          } catch (streamErr) {
            if (intentDetected) {
              // Expected abort — model signalled presentation intent.
              // Retry with full presentation prompt.
              console.log('[Intent] Model signalled [PRESENTATION_INTENT] — retrying with full presentation prompt');
              presIntent = true;
              presInProgressRef.current = true;

              // Clear the streamed text from the thinking bubble
              setMessages(prev => prev.map(m =>
                m.isThinking ? { ...m, text: '' } : m
              ));

              // Run Pass 1 extraction + planning if we have a PDF (same logic as initial path)
              const retryMode = detectPresentationMode(text);
              let retryPlan: PresentationPlan | null = null;
              if (pdf.pdfDoc && pdf.pdfThumbnails.length > 0 && !thumbnailsSentRef.current) {
                try {
                  // Pass 1a: Figure extraction (cheap vision model)
                  setLoadingMsg('Analyzing paper structure and figures...');
                  const extractionResult = await extractFiguresFromPdf(
                    pdf.pdfThumbnails, pdf.pdfTextPages, apiKey, controller.signal, extractionModel,
                  );
                  if (!controller.signal.aborted && extractionResult.figures.length > 0) {
                    setLoadingMsg(`Cropping ${extractionResult.figures.length} figures...`);
                    extractedFiguresRef.current = await preCropExtractedFigures(
                      extractionResult.figures, pdf.pdfDoc, pdf.figureCacheRef.current,
                    );
                    console.log(`[Extraction] Pass 1a (retry): ${extractedFiguresRef.current.length} figures cropped`);
                  }

                  // Pass 1b: Narrative planning (main model)
                  const retryPlanStructure = detectMainContentEnd(pdf.pdfTextPages);
                  if (!controller.signal.aborted) {
                    setLoadingMsg(deepThinking ? 'Planning presentation (thinking deeply)...' : 'Planning presentation structure...');
                    const retryPlanMainEnd = retryPlanStructure.mainContentEnd;
                    const retryPlanPages = pdf.pdfTextPages.slice(0, retryPlanMainEnd);
                    const textSummary = retryPlanPages.filter(Boolean).map((p, i) => `--- PAGE ${i + 1} ---\n${p}`).join('\n\n');
                    console.log(`[Planning] Retry: sending ${retryPlanMainEnd} pages (~${Math.round(textSummary.length / 4)} tokens) to planner`);
                    const planningPrompt = buildNarrativePlanningPrompt(
                      extractedFiguresRef.current || extractionResult.figures, textSummary, retryMode,
                    );
                    const planRequest = {
                      messages: [{ role: 'user' as const, content: planningPrompt }],
                      model: selectedModel,
                      max_tokens: 16384,
                      system: 'You are a presentation planning assistant. Output ONLY valid JSON with the requested structure. No explanations, no markdown formatting outside the JSON.',
                      timeout: computeTimeout(currentModel, { deepThinking, hasPdf: true, search: false, presentation: false }),
                      options: { thinking: deepThinking, thinkingBudget: deepThinking ? 10000 : undefined },
                    };
                    const planResult = await callChat(planRequest, apiKey, controller.signal);
                    const { narrative_arc, paper_summary } = parseNarrativePlanResponse(planResult.content);
                    console.log(`[Planning] Pass 1b (retry): ${narrative_arc.length} planned slides (mode: ${retryMode})`);

                    if (narrative_arc.length > 0) {
                      retryPlan = {
                        mode: retryMode,
                        narrative_arc,
                        paper_summary,
                        figures: extractedFiguresRef.current || [],
                        userText: text,
                      };
                    }
                  }

                  // Author/JournalClub: surface plan and wait
                  if (retryMode !== 'general' && retryPlan && retryPlan.narrative_arc.length > 0) {
                    const planText = formatPlanForChat(
                      retryPlan.narrative_arc, retryPlan.paper_summary, retryPlan.figures, retryPlan.mode, retryPlanStructure,
                    );
                    const planMsg: Message = { id: Date.now() + 2, sender: 'sage', text: planText };
                    setMessages(prev => [...prev.filter(m => !m.isThinking), planMsg]);
                    setPendingPlan(retryPlan);
                    pendingPlanRef.current = retryPlan;

                    // Save conversation (retry plan surface)
                    const msgsToSave = [...newMessages.filter(m => !m.isThinking), planMsg];
                    await sessions.saveSession(
                      msgsToSave, sessions.currentSessionId || undefined,
                      uploadedFiles, null, pdf.pdfPage, pdf.pdfZoom, null, selectedModel,
                      presentation.getNarrativeArc(),
                    );

                    setIsLoading(false);
                    setLoadingMsg('');
                    presInProgressRef.current = false;
                    return;
                  }
                } catch {
                  console.warn('[Extraction/Planning] Pass 1 (retry) failed — using thumbnails');
                }
              }

              setLoadingMsg('Generating slides...');

              // Rebuild with full presentation system prompt (pass plan for General mode)
              systemPrompt = buildSystemPrompt(text, true, retryPlan);
              apiMessages = buildApiMessages(text, true);
              maxTokens = maxOutputTokens;

              // Auto-boost tokens for presentations (same logic as initial path)
              {
                const modelCap = currentModel?.maxCompletionTokens || 32000;
                const slideCountGuess = text.match(/(\d+)\s*(?:slides?|slayt)/i);
                const slides = slideCountGuess ? parseInt(slideCountGuess[1], 10) : 8;
                const presMinTokens = Math.min((slides + 4) * 4000 + 2000, modelCap);
                if (maxTokens < presMinTokens) {
                  console.log(`[Pres/Retry] Auto-boosting max_tokens from ${maxTokens} to ${presMinTokens}`);
                  maxTokens = presMinTokens;
                }
              }

              // Auto-enable search for topic presentations (no PDF) and reflect in the UI
              if (!pdf.pdfDoc && !searchMode) {
                setSearchMode(true);
              }
              const retryEffectiveSearch = searchMode || !pdf.pdfDoc;

              chatRequest = {
                messages: apiMessages,
                model: selectedModel,
                max_tokens: maxTokens,
                system: systemPrompt,
                timeout: requestTimeout,
                options: {
                  search: retryEffectiveSearch,
                  thinking: deepThinking,
                  thinkingBudget: deepThinking ? 10000 : undefined,
                },
              };

              // Silent streaming for presentation with incremental slide extraction
              const expectedChars = Math.min(maxTokens * 3.5, (estimatedSlideCount + 3) * 3500 + 2000);
              const retryStreamStart = Date.now();

              // Reset incremental parse state for retry
              incrementalParseRef.current = createIncrementalParseState();
              let retryStreamingStarted = false;

              const retryResult = await callChatStream(
                chatRequest,
                apiKey,
                (_delta, fullText) => {
                  lastActivityRef.current = Date.now();
                  const elapsed = Math.floor((Date.now() - retryStreamStart) / 1000);
                  const mins = Math.floor(elapsed / 60);
                  const secs = elapsed % 60;
                  const timer = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;

                  // Incremental slide extraction
                  const { newSlides, updatedState } = extractIncrementalSlides(
                    fullText, incrementalParseRef.current
                  );
                  incrementalParseRef.current = updatedState;

                  if (newSlides.length > 0) {
                    if (!retryStreamingStarted) {
                      retryStreamingStarted = true;
                      presentation.startStreamingSlides(updatedState.title, updatedState.language);
                      setActiveTab('slides');
                    }
                    presentation.addStreamingSlides(newSlides, extractedFiguresRef.current || undefined);
                  }

                  if (updatedState.extractedCount > 0) {
                    setLoadingMsg(`Generating slides... ${updatedState.extractedCount} received (${timer})`);
                  } else {
                    const charCount = fullText.length;
                    if (charCount < 500) {
                      setLoadingMsg(`Sage is creating your presentation... (${timer})`);
                    } else {
                      const rawPercent = charCount / expectedChars;
                      const estimatedPercent = rawPercent < 0.95
                        ? Math.round(rawPercent * 100)
                        : Math.min(99, 95 + Math.round(4 * (1 - Math.exp(-(rawPercent - 0.95) * 10))));
                      setLoadingMsg(`Generating presentation... ${estimatedPercent}% (${timer})`);
                    }
                  }
                },
                controller.signal,
              );
              response = retryResult.content;
              if (retryResult.finishReason) currentFinishReason = retryResult.finishReason;
              if (retryResult.usage) {
                currentTokenUsage = retryResult.usage;
                setLastTokenUsage(retryResult.usage);
              } else {
                // Stream was truncated or usage not reported — clear stale intent-probe data
                currentTokenUsage = null;
                setLastTokenUsage(null);
              }
            } else if (posterIntentDetected) {
              // Expected abort — model signalled poster intent.
              // Retry with full poster prompt.
              console.log('[Intent] Model signalled [POSTER_INTENT] — retrying with poster prompt');

              // Clear the streamed text from the thinking bubble
              setMessages(prev => prev.map(m =>
                m.isThinking ? { ...m, text: '' } : m
              ));

              setLoadingMsg('Generating poster...');

              // Run figure extraction if we have a PDF (so poster can reference extracted figures)
              if (pdf.pdfDoc && pdf.pdfThumbnails.length > 0 && !extractedFiguresRef.current) {
                try {
                  setLoadingMsg('Analyzing paper figures for poster...');
                  const extractionResult = await extractFiguresFromPdf(
                    pdf.pdfThumbnails, pdf.pdfTextPages, apiKey, controller.signal, extractionModel,
                  );
                  if (!controller.signal.aborted && extractionResult.figures.length > 0) {
                    setLoadingMsg(`Cropping ${extractionResult.figures.length} figures...`);
                    extractedFiguresRef.current = await preCropExtractedFigures(
                      extractionResult.figures, pdf.pdfDoc, pdf.figureCacheRef.current,
                    );
                    console.log(`[Extraction] Pass 1a (poster retry): ${extractedFiguresRef.current.length} figures cropped`);
                  }
                } catch (exErr) {
                  if (controller.signal.aborted) throw exErr;
                  console.warn('[Extraction] Poster retry figure extraction failed:', exErr);
                }
                setLoadingMsg('Generating poster...');
              }

              // Rebuild with poster prompt
              // We need to inject poster intent into the system prompt
              let posterSystemPrompt = buildSystemPrompt(text, false);
              // Force-append poster prompt if not already present
              if (!posterSystemPrompt.includes('POSTERS:')) {
                posterSystemPrompt += `\n\n${POSTER_WORKFLOW}`;
                posterSystemPrompt += `\n\n${getPosterPrompt()}`;

                // Include extracted figure catalog
                if (extractedFiguresRef.current && extractedFiguresRef.current.length > 0) {
                  const figCatalog = extractedFiguresRef.current.map(f =>
                    `- ${f.id}: ${f.kind} on page ${f.page}${f.label ? ` (${f.label})` : ''}: ${f.description}`
                  ).join('\n');
                  posterSystemPrompt += `\n\nEXTRACTED FIGURE CATALOG (use "extracted_ref" type with these IDs):\n${figCatalog}`;
                }
              }

              const posterApiMessages = buildApiMessages(text, false);
              chatRequest = {
                messages: posterApiMessages,
                model: selectedModel,
                max_tokens: maxTokens,
                system: posterSystemPrompt,
                timeout: requestTimeout,
                options: {
                  search: searchMode,
                  thinking: deepThinking,
                  thinkingBudget: deepThinking ? 10000 : undefined,
                },
              };

              // Set posterIntent so post-response handling uses silent path
              posterIntent = true;

              const retryPosterStart = Date.now();
              const posterResult = await callChatStream(
                chatRequest,
                apiKey,
                (_delta, _fullText) => {
                  lastActivityRef.current = Date.now();
                  const elapsed = Math.floor((Date.now() - retryPosterStart) / 1000);
                  const timer = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toString().padStart(2, '0')}s` : `${elapsed}s`;
                  setLoadingMsg(`Generating poster... (${timer})`);
                },
                controller.signal,
              );
              response = posterResult.content;
              if (posterResult.finishReason) currentFinishReason = posterResult.finishReason;
              if (posterResult.usage) {
                currentTokenUsage = posterResult.usage;
                setLastTokenUsage(posterResult.usage);
              }
            } else {
              // Real error — re-throw
              throw streamErr;
            }
          } finally {
            controller.signal.removeEventListener('abort', onMainAbort);
          }
        }
      } catch (streamError) {
        // If streaming failed for non-abort reason, fall back to non-streaming
        if (controller.signal.aborted) throw streamError;
        console.warn('Streaming failed, falling back to non-streaming:', streamError);
        setLoadingMsg(presIntent ? 'Sage is creating your presentation...' : posterIntent ? 'Generating poster...' : 'Sage is composing a response...');
        const fallbackResult = await callChat(chatRequest, apiKey, controller.signal);
        response = fallbackResult.content;
        if (fallbackResult.usage) { currentTokenUsage = fallbackResult.usage; setLastTokenUsage(fallbackResult.usage); }
      }

      // Check if cancelled
      if (cancelledGens.current.has(gen)) {
        cancelledGens.current.delete(gen);
        // Unlock streaming mode — keep whatever slides arrived so far
        presentation.finalizePresentation();
        return;
      }

      let responseText = response;

      // Extract memory notes BEFORE stripping presentation JSON —
      // NOTE tags may be inside the JSON block and would be lost otherwise.
      await memory.extractMemoryFromResponse(responseText, text);

      // Debug: log response details for presentation intent
      if (presIntent) {
        console.log('[Pres] Response length:', responseText.length, 'Has slides:', responseText.includes('"slides"'));
        console.log('[Pres] First 300 chars:', responseText.substring(0, 300));
      }

      // 4. Extract presentation JSON if present
      const presResult = extractPresentationJson(responseText);
      const streamedSlideCount = presentation.presentationRef.current.slides.length;

      if (presResult) {
        const { presData, fullMatch } = presResult;
        // Remove the JSON block from visible text
        responseText = responseText.replace(fullMatch, '').trim();
        if (!responseText) {
          responseText = `Here's your presentation: **${presData.title}** with ${presData.slides.length} slides. Use the arrow keys or navigation controls to browse slides.`;
        }

        // Warn if the presentation was truncated (model hit token limit)
        if (currentFinishReason === 'length') {
          responseText += `\n\n⚠️ **Note:** The response hit the token limit and the presentation was likely truncated — some slides (including references or closing) may be missing. To get the full presentation, try increasing **Max Output Tokens** in Settings or requesting fewer slides.`;
          console.warn(`[Pres] Truncated! finish_reason=length. Got ${presData.slides.length} slides.`);
        }

        // Save user's current slide position (from incremental streaming)
        const savedSlideIdx = presentation.presentationRef.current.currentSlide;

        // Load the final presentation (replaces incremental slides with fully-parsed + repaired version)
        await presentation.loadPresentation(presData, {
          pdfDoc: pdf.pdfDoc,
          pdfTotalPages: pdf.pdfTotalPages,
          cropFn: pdf.cropPdfFigure,
          extractedFigures: extractedFiguresRef.current || undefined,
          mode: detectedMode,
          narrativeArc: activePlan?.narrative_arc,
        });

        // Restore slide position if user navigated during streaming
        if (savedSlideIdx > 0 && savedSlideIdx < presData.slides.length) {
          presentation.setSlide(savedSlideIdx);
        }

        // Switch to slides tab
        setActiveTab('slides');
      } else if (presIntent && streamedSlideCount > 0) {
        // Final parse failed but incremental streaming already rendered slides.
        // Keep the streamed slides and suppress raw JSON from the chat.
        console.warn(`[Pres] Final extractPresentationJson failed, but ${streamedSlideCount} slides were streamed successfully. Keeping streamed slides.`);
        responseText = `Here's your presentation: **${presentation.presentationRef.current.title}** with ${streamedSlideCount} slides. Use the arrow keys or navigation controls to browse slides.`;

        if (currentFinishReason === 'length') {
          responseText += `\n\n⚠️ **Note:** The response hit the token limit and the presentation was likely truncated — some slides may be missing.`;
        }

        setActiveTab('slides');
      } else if (presIntent) {
        console.warn('[Pres] extractPresentationJson returned null and no slides were streamed!');
        if (responseText.includes('"slides"')) {
          console.warn('[Pres] Response contains "slides" but extraction failed. Last 300 chars:', responseText.substring(responseText.length - 300));
          // NEVER show raw JSON in chat — replace with error message
          responseText = `I generated the presentation but encountered a parsing error. Please try again — you can also try requesting fewer slides or a simpler topic.`;
        }
      }

      // 4b. Extract poster JSON if present (separate from presentations)
      let extractedPosterData: PosterState | null = null;
      if (!presResult && !presIntent) {
        const posterResult = extractPosterJson(responseText);
        if (posterResult) {
          const { posterData, fullMatch } = posterResult;
          extractedPosterData = posterData;
          responseText = responseText.replace(fullMatch, '').trim();
          if (!responseText) {
            const cardCount = Object.keys(posterData.cards).length;
            responseText = `Here's your poster: **${posterData.title}** with ${cardCount} sections across ${posterData.columns.length} columns. Switch to the Poster tab to view and edit it.`;
          }
          setPosterState(posterData);
          setActiveTab('poster');
          console.log(`[Poster] Parsed poster with ${Object.keys(posterData.cards).length} cards`);
        }
      }

      // Finalize streaming — unlock read-only mode
      if (presIntent) {
        presentation.finalizePresentation();
      }

      // 5. Strip any remaining [NOTE: ...] tags from visible text
      // (Memory extraction already ran on the full response above, before JSON removal)
      responseText = responseText.replace(/\[NOTE:\s*.*?\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

      // 6. Detect response language for TTS
      const presLang = presentation.presentationRef.current.language;
      const detectedLang = detectLanguage(responseText, presLang !== 'en' ? presLang : undefined);

      // 7. Update messages (replace thinking placeholder)
      const sageMsg: Message = {
        id: Date.now() + 2,
        sender: 'sage',
        text: responseText,
        language: detectedLang,
      };

      const finalMessages = newMessages
        .filter(m => !m.isThinking)
        .concat(sageMsg);
      setMessages(finalMessages);

      // 8. Save session
      // Use extractedPosterData (from this render cycle) if we just parsed a poster,
      // because setPosterState() is async and posterState still holds the old value.
      await sessions.saveSession(
        finalMessages,
        sessions.currentSessionId || undefined,
        uploadedFiles,
        presentation.presentationRef.current.slides.length > 0 ? presentation.presentationRef.current : null,
        pdf.pdfPage,
        pdf.pdfZoom,
        currentTokenUsage,
        selectedModel,
        presentation.getNarrativeArc(),
        undefined, // auditResults
        extractedPosterData || posterState,
        extractedFiguresRef.current,
      );

      // 9. Auto-voice if enabled
      if (autoVoice && !presResult) {
        tts.speak(responseText, undefined, detectedLang);
      }

      // 10. Auto-offer assessment after 2+ Q&A messages post-presentation
      if (!presResult && presentation.presentationRef.current.slides.length > 0) {
        const currentAssessment = assessmentStateRef.current;
        if (!currentAssessment.offeredThisPresentation && currentAssessment.phase === 'idle') {
          postPresQACountRef.current++;
          if (postPresQACountRef.current >= 2) {
            const offerMsg: Message = {
              id: Date.now() + 3,
              sender: 'system',
              text: 'Ready to test your understanding? Say **"assess me"** or click the **Assess Me** button to start a Socratic quiz.',
            };
            setMessages(prev => [...prev, offerMsg]);
            setAssessmentState(prev => ({ ...prev, offeredThisPresentation: true }));
            assessmentStateRef.current = { ...assessmentStateRef.current, offeredThisPresentation: true };
          }
        }
      }
    } catch (e) {
      if (cancelledGens.current.has(gen)) {
        cancelledGens.current.delete(gen);
        presentation.finalizePresentation();
        return;
      }

      const errMsg = e instanceof Error ? e.message : 'An unexpected error occurred.';
      // Don't show abort errors as error text, but still clean up thinking placeholder
      if (errMsg.includes('abort') || errMsg.includes('cancel')) {
        setMessages(prev => prev.filter(m => !m.isThinking));
        presentation.finalizePresentation();
        return;
      }

      setError(errMsg);

      // Remove thinking placeholder on error
      setMessages(prev => prev.filter(m => !m.isThinking));
    } finally {
      if (!cancelledGens.current.has(gen)) {
        setIsLoading(false);
        setLoadingMsg('');
        abortRef.current = null;
        presInProgressRef.current = false;
        presentation.finalizePresentation();
      }
    }
  }, [
    input, isLoading, messages, searchMode, deepThinking, uploadedFiles,
    apiKey, selectedModel, autoVoice, maxOutputTokens,
    buildSystemPrompt, buildApiMessages,
    pdf.pdfDoc, pdf.pdfTotalPages, pdf.pdfThumbnails, pdf.pdfPage, pdf.pdfZoom, pdf.cropPdfFigure,
    presentation, memory, sessions, tts,
  ]);

  // Keep handleSendRef current for useSTT callback
  handleSendRef.current = handleSend;

  // ── Export HTML state ────────────────────────────────────
  const [exportHtml, setExportHtml] = useState<string | null>(null);

  // ── Auto-search active indicator ───────────────────────
  // Computed inline during render (like the original), NOT persisted as state.
  // True when: loading + presentation intent + no PDF + user didn't manually enable search
  const lastUserMsg = messages.filter(m => m.sender === 'user').pop()?.text || '';
  const autoSearchActive = isLoading && !searchMode && isPresentationIntent(lastUserMsg) && !pdf.pdfDoc;

  // ── Narrate a specific slide ───────────────────────────
  // Original behavior: speak ONLY the speaker notes, not title/bullets
  const narrateSlide = useCallback((slideIndex: number) => {
    const ps = presentation.presentationRef.current;
    if (ps.slides.length === 0 || slideIndex < 0 || slideIndex >= ps.slides.length) return;

    // Set isPresenting = true when narration begins (enables auto-advance)
    if (!ps.isPresenting) {
      presentation.setPresentationState(prev => ({ ...prev, isPresenting: true }));
    }

    const slide = ps.slides[slideIndex];
    // Only narrate speaker notes — skip slides without notes
    if (!slide.speakerNotes) {
      // Auto-advance past noteless slides
      const current = presentation.presentationRef.current;
      if (current.autoAdvance && slideIndex < current.slides.length - 1) {
        presentation.navigateSlide(1);
        setTimeout(() => narrateSlide(slideIndex + 1), 800);
      } else {
        // No more slides to advance to — end presentation mode
        presentation.setPresentationState(prev => ({ ...prev, isPresenting: false }));
      }
      return;
    }

    const text = cleanTextForSpeech(slide.speakerNotes);

    // onStarted: fires once the first chunk begins playing.
    // Prefetch only the next slide (onAlmostDone handles the one after that)
    const onStarted = () => {
      const nextIdx = slideIndex + 1;
      if (nextIdx < ps.slides.length) {
        const nextSlide = ps.slides[nextIdx];
        if (nextSlide?.speakerNotes) {
          tts.prefetchAudio(cleanTextForSpeech(nextSlide.speakerNotes));
        }
      }
    };

    // onAlmostDone: last-moment prefetch for the immediate next slide (backup if eager prefetch missed it)
    const onAlmostDone = () => {
      const current = presentation.presentationRef.current;
      if (current.autoAdvance && slideIndex + 1 < current.slides.length) {
        const nextSlide = current.slides[slideIndex + 1];
        if (nextSlide?.speakerNotes) {
          tts.prefetchAudio(cleanTextForSpeech(nextSlide.speakerNotes));
        }
      }
    };

    tts.speak(text, () => {
      // Auto-advance to next slide after narration ends
      const current = presentation.presentationRef.current;
      if (current.autoAdvance && slideIndex < current.slides.length - 1) {
        presentation.navigateSlide(1);
        // Narrate next slide after a brief pause
        setTimeout(() => narrateSlide(slideIndex + 1), 800);
      } else {
        // Narration complete — exit presentation mode
        presentation.setPresentationState(prev => ({ ...prev, isPresenting: false }));
      }
    }, ps.language, onAlmostDone, onStarted);
  }, [tts, presentation]);

  // ── Stop narration ─────────────────────────────────────
  const stopNarration = useCallback(() => {
    tts.stopSpeaking();
    // Exit presentation mode when user stops narration
    presentation.setPresentationState(prev => ({ ...prev, isPresenting: false }));
  }, [tts, presentation]);

  // ── Resolve lazy crops before export ─────────────────
  // Iterates through slides and populates croppedDataURL for any
  // pdf_crop figures that only have metadata (page + region).
  const resolveLazyCrops = useCallback(async (
    slides: Slide[],
    onProgress?: (msg: string) => void,
  ): Promise<Slide[]> => {
    const resolved: Slide[] = [];
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const fig = slide.figure;
      if (fig?.type === 'pdf_crop' && !fig.croppedDataURL && fig.page && fig.region) {
        onProgress?.(`Resolving figure crop for slide ${i + 1}/${slides.length}...`);
        const dataURL = await pdf.cropPdfFigure(fig.page, fig.region);
        if (dataURL) {
          resolved.push({ ...slide, figure: { ...fig, croppedDataURL: dataURL } });
          continue;
        }
      }
      resolved.push(slide);
    }
    return resolved;
  }, [pdf.cropPdfFigure]);

  // ── Export presentation as PPTX ────────────────────────
  const doExportPPTX = useCallback(async () => {
    setIsLoading(true);
    try {
      const ps = presentation.presentationRef.current;
      setLoadingMsg('Resolving figure crops...');
      const resolvedSlides = await resolveLazyCrops(ps.slides, setLoadingMsg);
      await exportPPTX({ ...ps, slides: resolvedSlides }, (msg) => {
        setLoadingMsg(msg);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PPTX export failed');
    } finally {
      setIsLoading(false);
      setLoadingMsg('');
    }
  }, [presentation, resolveLazyCrops]);

  // ── Export presentation as HTML ────────────────────────
  const doExportHTML = useCallback(async () => {
    const ps = presentation.presentationRef.current;
    if (ps.slides.length === 0) return;
    setIsLoading(true);
    try {
      setLoadingMsg('Resolving figure crops...');
      const resolvedSlides = await resolveLazyCrops(ps.slides, setLoadingMsg);
      const html = generateExportHTML(resolvedSlides, ps.title, ps.speakerNotesVisible);
      setExportHtml(html);
    } finally {
      setIsLoading(false);
      setLoadingMsg('');
    }
  }, [presentation, resolveLazyCrops]);

  // ── Handle file upload ────────────────────────────────────
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newFiles: UploadedFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setLoadingMsg(`Reading ${file.name}...`);

      const dataURL = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        reader.readAsDataURL(file);
      });

      const uploadedFile: UploadedFile = {
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        dataURL,
        size: file.size,
      };

      newFiles.push(uploadedFile);

      // Auto-load PDFs
      if (file.type === 'application/pdf') {
        thumbnailsSentRef.current = false; // Reset so new PDF gets thumbnails
        const doc = await pdf.loadPdf(dataURL);
        if (doc) {
          setActiveTab('pdf');
        }
      }
    }

    setUploadedFiles(prev => [...prev, ...newFiles]);
    setLoadingMsg('');

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [pdf]);

  // ── Remove an uploaded file ───────────────────────────────
  const removeFile = useCallback((index: number) => {
    setUploadedFiles(prev => {
      const file = prev[index];
      // If removing a PDF, also clear PDF state
      if (file?.mediaType === 'application/pdf') {
        pdf.removePdf();
      }
      return prev.filter((_, i) => i !== index);
    });
  }, [pdf]);

  // ── Session wrappers (bind callbacks so consumers don't need to) ──
  const sessionCallbacks = useCallback(() => ({
    setMessages,
    setUploadedFiles,
    setPresentationState: presentation.setPresentationState,
    setPdfPage: pdf.setPdfPage,
    setPdfZoom: pdf.setPdfZoom,
    loadPdf: pdf.loadPdf,
    removePdf: pdf.removePdf,
    setLoadingMsg,
    setLastTokenUsage,
    setSelectedModel,
    setNarrativeContext: (arc: NarrativeArcEntry[]) => presentation.setNarrativeContext(arc, []),
    setAuditResults,
    setPosterState,
  }), [presentation.setPresentationState, presentation.setNarrativeContext, pdf.setPdfPage, pdf.setPdfZoom, pdf.loadPdf, pdf.removePdf, setPosterState]);

  const wrappedLoadSession = useCallback(
    async (session: Parameters<typeof sessions.loadSession>[0]) => {
      // Sessions are already auto-saved after each chat response (see step 7 in sendMessage).
      // No additional auto-save needed here — it caused stale closure issues
      // where old messages/state would overwrite the current session data.
      await sessions.loadSession(session, sessionCallbacks());
      setActiveTab('chat'); // Always return to chat tab on session switch
      // Clear any pending plan from the previous session
      setPendingPlan(null);
      pendingPlanRef.current = null;
      // Reset assessment state
      setAssessmentState(createInitialAssessmentState());
      assessmentStateRef.current = createInitialAssessmentState();
      postPresQACountRef.current = 0;
    },
    [sessions, sessionCallbacks],
  );

  const wrappedDeleteSession = useCallback(
    (sessionId: string) => sessions.deleteSession(sessionId),
    [sessions],
  );

  const wrappedNewSession = useCallback(
    () => {
      sessions.newSession(sessionCallbacks());
      setActiveTab('chat'); // Switch back to chat tab
      // Clear any pending plan
      setPendingPlan(null);
      pendingPlanRef.current = null;
      // Reset assessment state
      setAssessmentState(createInitialAssessmentState());
      assessmentStateRef.current = createInitialAssessmentState();
      postPresQACountRef.current = 0;
    },
    [sessions, sessionCallbacks],
  );

  const wrappedClearAllSessions = useCallback(
    () => sessions.clearAllSessions(sessionCallbacks()),
    [sessions, sessionCallbacks],
  );

  // --- Lightweight session persist (for non-chat state changes like image generation) ---
  const persistSession = useCallback(async () => {
    if (!sessions.currentSessionId) return;
    const currentMsgs = messages.filter(m => !m.isThinking);
    if (currentMsgs.length === 0) return;
    await sessions.saveSession(
      currentMsgs,
      sessions.currentSessionId,
      uploadedFiles,
      presentation.presentationRef.current.slides.length > 0 ? presentation.presentationRef.current : null,
      pdf.pdfPage,
      pdf.pdfZoom,
      lastTokenUsage,
      selectedModel,
      presentation.getNarrativeArc(),
      undefined, // auditResults
      posterState,
      extractedFiguresRef.current,
    );
  }, [sessions, messages, uploadedFiles, presentation, pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel, posterState]);

  // ── Slide Audit ──────────────────────────────────────────
  // Keep a ref so we can pass the latest value to saveSession without stale closures
  const auditResultsRef = useRef(auditResults);
  auditResultsRef.current = auditResults;

  /** Store audit result in state AND persist to session */
  const storeAuditResult = useCallback((slideIndex: number, result: AuditResult) => {
    setAuditResults(prev => {
      const next = { ...prev, [slideIndex]: result };
      console.log(`[Audit] Storing result for slide ${slideIndex}. Map keys: [${Object.keys(next).join(', ')}]`);
      // Persist to session in the background
      const presSlides = presentation.presentationRef.current.slides;
      sessions.saveSession(
        messages, sessions.currentSessionId || undefined,
        uploadedFiles,
        presSlides.length > 0 ? presentation.presentationRef.current : null,
        pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel, presentation.getNarrativeArc(), next,
      );
      return next;
    });
  }, [presentation, sessions, messages, uploadedFiles, pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel]);

  const auditSlide = useCallback(async (slideIndex: number) => {
    if (isAuditing) return;

    const slides = presentation.presentationRef.current.slides;
    const slide = slides[slideIndex];
    if (!slide) return;

    setIsAuditing(true);

    try {
      // ── References slide → dedicated references audit ──
      const isRefSlide = /^(references|bibliography|sources|works cited|citations)$/i.test(slide.title.trim());
      if (isRefSlide) {
        console.log(`[Audit] References slide detected: "${slide.title}"`);

        // Gather per-slide footnote citations from all other slides
        const citedRefs: { slideNum: number; title: string; refs: string[] }[] = [];
        slides.forEach((s, i) => {
          if (i !== slideIndex && s.references && s.references.length > 0) {
            citedRefs.push({ slideNum: i + 1, title: s.title, refs: s.references });
          }
        });

        const refBullets = slide.content || [];

        // Build per-slide citation summary
        const citationSummary = citedRefs.length > 0
          ? citedRefs.map(c =>
              `Slide ${c.slideNum} "${c.title}":\n${c.refs.map((r, j) => `  [${j + 1}] ${r}`).join('\n')}`
            ).join('\n\n')
          : 'No per-slide citations were found in any content slide.';

        const refSystemPrompt = `You are a presentation references auditor. Check the References slide against citations used throughout the deck.

REFERENCES SLIDE ENTRIES (${refBullets.length} items):
${refBullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}

CITATIONS USED IN CONTENT SLIDES:
${citationSummary}

Perform these checks:
1. Coverage — Is every cited reference (from content slides) present in the References list? Match by author surname and year.
2. Orphans — Are there entries in the References list that are never cited in any content slide?
3. Formatting — Are entries consistently formatted (Author, Title, Venue, Year)?

Return ONLY valid JSON (no markdown fences):
{
  "checks": [
    { "id": 7, "name": "References", "pass": true/false, "detail": "<explanation listing any issues found>" }
  ]
}

Rules:
- "pass" = true only if coverage is complete AND no orphans AND formatting is consistent.
- "detail" should specifically list any missing, orphaned, or inconsistently formatted entries.
- If no per-slide citations exist, focus only on formatting consistency and pass if formatting is fine.`;

        const { content: refRaw } = await callChat({
          messages: [{ role: 'user', content: 'Audit this references slide.' }],
          model: selectedModel,
          max_tokens: 1024,
          system: refSystemPrompt,
          temperature: 0,
        }, apiKey);

        let refChecks: AuditCheck[] = [];
        try {
          const cleaned = refRaw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          const parsed = JSON.parse(cleaned);
          if (parsed.checks && Array.isArray(parsed.checks)) {
            refChecks = parsed.checks.map((c: { id: number; name: string; pass: boolean; detail: string }) => ({
              id: c.id, name: c.name || 'References', pass: !!c.pass, detail: c.detail || '',
            }));
          }
        } catch (parseErr) {
          console.warn('[Audit] Failed to parse references response:', parseErr, refRaw);
          refChecks = [{ id: 7, name: 'References', pass: false, detail: 'Failed to parse references audit response.' }];
        }

        storeAuditResult(slideIndex, { slideIndex, checks: refChecks });
        return;  // skip the normal 6-check flow
      }

      const narrativeArc = presentation.getNarrativeArc();
      console.log(`[Audit] Starting audit for slide ${slideIndex} "${slide.title}" | Arc: ${narrativeArc.length} entries | Figure: ${slide.figure?.type || 'none'} (extractedId: ${slide.figure?.extractedId || 'none'})`);

      // ── Check 4: Mechanical figure ↔ plan match ──
      // Find the plan entry for this slide. The narrative arc numbers content slides
      // starting from 1, but the actual deck has a title slide auto-injected at index 0.
      // So plan slide_number N → actual slideIndex N (with 1 injected title slide).
      let planEntry: NarrativeArcEntry | undefined;
      if (narrativeArc.length > 0) {
        // Exact title match only — any title mismatch is itself a fabrication to flag
        const slideTitle = slide.title.toLowerCase().trim();
        planEntry = narrativeArc.find(e => e.title.toLowerCase().trim() === slideTitle);

        if (planEntry) {
          console.log(`[Audit] Matched slide ${slideIndex} "${slide.title}" → plan #${planEntry.slide_number} "${planEntry.title}"`);
        } else {
          console.warn(`[Audit] Title mismatch: slide ${slideIndex} "${slide.title}" not found in plan (${narrativeArc.length} entries)`);
        }
      }

      // ── All checks are LLM-based ──
      const hasFigure = !!slide.figure;
      const isSvg = slide.figure?.type === 'svg';
      const hasArc = narrativeArc.length > 0;

      // Build slide data summary for the LLM
      const slideData = {
        title: slide.title,
        bullets: slide.content || [],
        speakerNotes: slide.speakerNotes || '(none)',
        figure: hasFigure ? {
          type: slide.figure!.type,
          label: slide.figure!.label || '(none)',
          description: slide.figure!.description || '(none)',
          caption: slide.figure!.caption || '(none)',
          ...(isSvg && slide.figure!.content ? { svgSnippet: slide.figure!.content.slice(0, 2000) } : {}),
        } : null,
        layout: slide.layout || 'balanced',
      };

      const planData = planEntry ? {
        plannedTitle: planEntry.title,
        plannedPurpose: planEntry.purpose,
        plannedVisual: planEntry.visual_need || '(none specified)',
      } : null;

      // Determine which checks to request from the LLM
      const checksToRun: string[] = [];
      checksToRun.push('1: Bullets ↔ Speaker Notes — Do the speaker notes explain/expand the bullet points, or do they go off-topic?');
      if (hasFigure) {
        checksToRun.push('2: Speaker Notes ↔ Figure — Do the speaker notes describe or reference the figure on the slide?');
        checksToRun.push('3: Bullets ↔ Figure — Do the bullet points relate to the displayed figure?');
      }
      if (hasFigure && planData) {
        checksToRun.push('4: Figure ↔ Plan — Is the displayed figure the one the plan specified for this slide? Check if the figure label/description matches the planned visual.');
      }
      if (isSvg && planData) {
        checksToRun.push('5: SVG ↔ Plan — Does the synthesized SVG diagram match what the plan described for this slide\'s visual?');
      }
      if (planData) {
        checksToRun.push('6: Slide ↔ Plan — Does the slide\'s overall topic and scope match what the plan specified?');
      }

      // Build skip/fail checks for categories not sent to LLM
      const skippedChecks: AuditCheck[] = [];
      if (!hasFigure) {
        skippedChecks.push({ id: 2, name: 'Notes ↔ Figure', pass: true, detail: 'Skipped: no figure on this slide.' });
        skippedChecks.push({ id: 3, name: 'Bullets ↔ Figure', pass: true, detail: 'Skipped: no figure on this slide.' });
        skippedChecks.push({ id: 4, name: 'Figure ↔ Plan', pass: true, detail: 'Skipped: no figure on this slide.' });
      } else if (!planData) {
        if (hasArc) {
          skippedChecks.push({ id: 4, name: 'Figure ↔ Plan', pass: false, detail: `Slide title "${slide.title}" does not match any planned slide title.` });
        } else {
          skippedChecks.push({ id: 4, name: 'Figure ↔ Plan', pass: true, detail: 'Skipped: no narrative arc available.' });
        }
      }
      if (!isSvg || !planData) {
        skippedChecks.push({ id: 5, name: 'SVG ↔ Plan', pass: true, detail: !isSvg ? 'Skipped: figure is not SVG.' : 'Skipped: no plan entry found.' });
      }
      if (!planData && hasArc) {
        skippedChecks.push({ id: 6, name: 'Slide ↔ Plan', pass: false, detail: `Slide title "${slide.title}" does not match any planned slide title.` });
      }
      if (!hasArc) {
        skippedChecks.push({ id: 6, name: 'Slide ↔ Plan', pass: true, detail: 'Skipped: no narrative arc available.' });
      }

      const systemPrompt = `You are a presentation slide auditor. Analyze the given slide for consistency issues.

SLIDE DATA:
- Title: "${slideData.title}"
- Bullets: ${JSON.stringify(slideData.bullets)}
- Speaker Notes: "${slideData.speakerNotes}"
- Figure: ${slideData.figure ? JSON.stringify(slideData.figure) : 'none'}
- Layout: "${slideData.layout}"
${planData ? `
PLAN ENTRY (what this slide was supposed to be):
- Planned Title: "${planData.plannedTitle}"
- Planned Purpose: "${planData.plannedPurpose}"
- Planned Visual: "${planData.plannedVisual}"` : ''}

CHECKS TO PERFORM:
${checksToRun.map(c => `- ${c}`).join('\n')}

Return ONLY valid JSON (no markdown fences) with this structure:
{
  "checks": [
    { "id": <number>, "name": "<short name>", "pass": true/false, "detail": "<1-2 sentence explanation>" }
  ]
}

Rules:
- Only include checks listed above (skip unlisted IDs).
- "pass" means no significant mismatch. Minor wording differences are fine.
- "detail" should be specific: mention what mismatches or why it passes.
- Be strict: if notes discuss something entirely different from the bullets, that's a fail.
- For SVG checks, assess whether the SVG's apparent content matches the plan's visual description.`;

      const { content: rawResponse } = await callChat({
        messages: [{ role: 'user', content: 'Audit this slide.' }],
        model: selectedModel,
        max_tokens: 1024,
        system: systemPrompt,
        temperature: 0,
      }, apiKey);

      // Parse LLM response
      let llmChecks: AuditCheck[] = [];
      try {
        // Strip markdown fences if present
        const cleaned = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.checks && Array.isArray(parsed.checks)) {
          llmChecks = parsed.checks.map((c: { id: number; name: string; pass: boolean; detail: string }) => ({
            id: c.id,
            name: c.name || `Check ${c.id}`,
            pass: !!c.pass,
            detail: c.detail || '',
          }));
        }
      } catch (parseErr) {
        console.warn('[Audit] Failed to parse LLM response:', parseErr, rawResponse);
        llmChecks = [{ id: 0, name: 'Parse Error', pass: false, detail: 'Failed to parse audit response from the model.' }];
      }

      // Merge LLM checks + skipped checks (deduplicate by ID — LLM takes priority)
      const llmIds = new Set(llmChecks.map(c => c.id));
      const uniqueSkipped = skippedChecks.filter(c => !llmIds.has(c.id));
      const allChecks = [...llmChecks, ...uniqueSkipped].sort((a, b) => a.id - b.id);

      storeAuditResult(slideIndex, { slideIndex, checks: allChecks });
    } catch (err) {
      console.error('[Audit] Failed:', err);
      storeAuditResult(slideIndex, {
        slideIndex,
        checks: [{ id: 0, name: 'Error', pass: false, detail: `Audit failed: ${err instanceof Error ? err.message : 'Unknown error'}` }],
      });
    } finally {
      setIsAuditing(false);
    }
  }, [isAuditing, presentation, selectedModel, apiKey, storeAuditResult]);

  // ── Deep Analysis — full-deck hallucination audit ──────────
  const deepAnalysisControllerRef = useRef<AbortController | null>(null);

  const deepAnalysis = useCallback(async () => {
    if (isDeepAnalyzing || isLoading) return;

    const slides = presentation.presentationRef.current.slides;
    if (!slides || slides.length === 0) return;
    if (!pdf.pdfTextPages || pdf.pdfTextPages.length === 0) return;

    setIsDeepAnalyzing(true);
    setIsLoading(true);
    setLoadingMsg('Deep analysis: preparing...');

    // Add user message
    const userMsg: Message = { id: Date.now(), sender: 'user', text: 'Run deep analysis on this deck' };
    setMessages(prev => [...prev, userMsg]);

    // Add thinking placeholder
    const thinkingMsg: Message = { id: Date.now() + 1, sender: 'sage', text: '', isThinking: true };
    setMessages(prev => [...prev, thinkingMsg]);

    const controller = new AbortController();
    deepAnalysisControllerRef.current = controller;

    try {
      // Build paper text — only main body + references, exclude supplementary
      const { mainContentEnd } = detectMainContentEnd(pdf.pdfTextPages);
      let paperText = '';
      for (let i = 0; i < mainContentEnd && i < pdf.pdfTextPages.length; i++) {
        if (pdf.pdfTextPages[i]) {
          paperText += `--- PAGE ${i + 1} ---\n${pdf.pdfTextPages[i]}\n\n`;
        }
      }
      if (mainContentEnd < pdf.pdfTotalPages) {
        paperText += `\n(Pages ${mainContentEnd + 1}–${pdf.pdfTotalPages} are appendix/supplementary — excluded to fit context window.)\n`;
      }

      // Build system prompt
      const narrativeArc = presentation.getNarrativeArc();
      const extractedFigures = presentation.getExtractedFigures();
      const systemPrompt = buildDeepAnalysisPrompt(paperText, slides, narrativeArc, extractedFigures);

      // Estimate token count and check against model context window
      const estimatedTokens = Math.ceil(systemPrompt.length / 3.5); // ~3.5 chars/token for mixed content
      const currentModel = availableModels.find(m => m.id === selectedModel);
      const contextLimit = currentModel?.contextLength || 128000;
      const maxTokens = 16384;
      const totalEstimate = estimatedTokens + maxTokens;

      console.log(`[DeepAnalysis] Starting: ${slides.length} slides, ${mainContentEnd} body pages, prompt ~${estimatedTokens} tokens (context: ${contextLimit})`);

      if (totalEstimate > contextLimit * 0.95) {
        throw new Error(
          `Deep analysis prompt (~${Math.round(estimatedTokens / 1000)}K tokens) + output (16K) ≈ ${Math.round(totalEstimate / 1000)}K tokens, ` +
          `which exceeds ${currentModel?.name || selectedModel}'s context window (${Math.round(contextLimit / 1000)}K). ` +
          `Try a model with a larger context window, or use a shorter paper.`
        );
      }

      // Stream the response live into the chat
      const streamStart = Date.now();
      const result = await callChatStream(
        {
          messages: [{ role: 'user', content: 'Perform the deep analysis now. Be thorough — check every statement.' }],
          model: selectedModel,
          max_tokens: 16384,
          system: systemPrompt,
          temperature: 0,
          timeout: 10 * 60_000, // 10 minutes — deep analysis is a large prompt
        },
        apiKey,
        (_delta: string, fullText: string) => {
          lastActivityRef.current = Date.now(); // keep safety timeout alive
          const elapsed = Math.floor((Date.now() - streamStart) / 1000);
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          const timer = mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;

          // Stream live into the thinking message
          setMessages(prev => prev.map(m =>
            m.isThinking ? { ...m, text: fullText } : m
          ));
          setLoadingMsg(`Deep analysis in progress... (${timer})`);
        },
        controller.signal,
      );

      // Finalize: replace thinking msg with final content
      let finalText = result.content;

      // If truncated (finish_reason: 'length'), append a note
      if (result.finishReason === 'length') {
        finalText += '\n\n---\n\n> ⚠️ *Report truncated due to output length limit. The analysis above is partial.*';
      }

      setMessages(prev => prev.map(m =>
        m.isThinking ? { ...m, isThinking: false, text: finalText } : m
      ));

      if (result.usage) setLastTokenUsage(result.usage);

      console.log(`[DeepAnalysis] Complete: ${finalText.length} chars, ${result.usage?.total_tokens || '?'} tokens`);

      // Save session with the report
      const updatedMessages = messages.filter(m => !m.isThinking);
      const allMsgs = [...updatedMessages, userMsg, { ...thinkingMsg, isThinking: false, text: finalText }];
      const presSlides = presentation.presentationRef.current.slides;

      await sessions.saveSession(
        allMsgs, sessions.currentSessionId || undefined,
        uploadedFiles,
        presSlides.length > 0 ? presentation.presentationRef.current : null,
        pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel, presentation.getNarrativeArc(), auditResults,
      );
    } catch (err) {
      if (controller.signal.aborted) {
        console.log('[DeepAnalysis] Cancelled by user');
        // Keep whatever was streamed
        setMessages(prev => prev.map(m =>
          m.isThinking ? { ...m, isThinking: false, text: m.text + '\n\n---\n\n> *Deep analysis cancelled.*' } : m
        ));
      } else {
        console.error('[DeepAnalysis] Failed:', err);
        setMessages(prev => prev.map(m =>
          m.isThinking ? { ...m, isThinking: false, text: `Deep analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}` } : m
        ));
      }
    } finally {
      setIsDeepAnalyzing(false);
      setIsLoading(false);
      setLoadingMsg('');
      deepAnalysisControllerRef.current = null;
    }
  }, [isDeepAnalyzing, isLoading, presentation, pdf.pdfTextPages, pdf.pdfTotalPages, pdf.pdfPage, pdf.pdfZoom,
      selectedModel, availableModels, apiKey, messages, uploadedFiles, sessions, lastTokenUsage, auditResults]);

  return {
    // ── Chat state ──
    messages,
    input,
    setInput,
    isLoading,
    loadingMsg,
    error,
    setError,
    searchMode,
    setSearchMode,
    deepThinking,
    setDeepThinking,
    handleSend,
    cancelGeneration,
    autoSearchActive,

    // ── UI state ──
    activeTab,
    setActiveTab,
    showSidebar,
    setShowSidebar,
    showSettings,
    setShowSettings,

    // ── Settings ──
    voiceGender,
    setVoiceGender,
    apiKey,
    setApiKey,
    freeMode,
    selectedModel,
    setSelectedModel,
    availableModels,
    modelsLoading,
    maxOutputTokens,
    setMaxOutputTokens,
    extractionModel,
    setExtractionModel,
    lastTokenUsage,

    // ── Assessment (Socratic) ──
    assessmentState,
    startAssessment: () => handleSend('assess me'),

    // ── Slide Audit ──
    auditSlide,
    auditResults,
    isAuditing,
    deepAnalysis,
    isDeepAnalyzing,


    // ── TTS (flattened from useTTS) ──
    autoVoice,
    setAutoVoice,
    ttsEngine,
    setTTSEngine,
    googleApiKey,
    setGoogleApiKey,
    browserVoiceName,
    setBrowserVoiceName,
    isSpeaking: tts.isSpeaking,
    isLoadingAudio: tts.isLoadingAudio,
    speak: tts.speak,
    stopSpeaking: tts.stopSpeaking,
    ttsRate: tts.ttsRate,
    setTTSRate: tts.setTTSRate,

    // ── Sidebar / Sessions (flattened from useSessions) ──
    savedSessions: sessions.savedSessions,
    currentSessionId: sessions.currentSessionId,
    loadingSessions: sessions.loadingSessions,
    sessionBusy: sessions.sessionBusy,
    loadSession: wrappedLoadSession,
    deleteSession: wrappedDeleteSession,
    newSession: wrappedNewSession,
    clearAllSessions: wrappedClearAllSessions,

    // ── Memory (flattened from useMemory) ──
    sageMemory: memory.sageMemory,
    deleteMemoryNote: memory.deleteMemoryNote,
    clearAllMemory: memory.clearAllMemory,

    // ── Files ──
    uploadedFiles,
    removeFile,
    fileInputRef,
    handleFileUpload,

    // ── PDF (flattened from usePDF) ──
    pdfDoc: pdf.pdfDoc,
    pdfPage: pdf.pdfPage,
    setPdfPage: pdf.setPdfPage,
    pdfTotalPages: pdf.pdfTotalPages,
    pdfZoom: pdf.pdfZoom,
    setPdfZoom: pdf.setPdfZoom,
    pdfCanvasRef: pdf.pdfCanvasRef,
    pdfContainerRef: pdf.pdfContainerRef,
    removePdf: pdf.removePdf,
    renderPdfPage: pdf.renderCurrentPage,
    cropPdfFigure: pdf.cropPdfFigure,
    pdfThumbnails: pdf.pdfThumbnails,
    pdfStructuredText: pdf.pdfStructuredText,
    pdfPageHeights: pdf.pdfPageHeights,

    // ── Presentation (flattened from usePresentation) ──
    presentationState: presentation.presentationState,
    setPresentationState: presentation.setPresentationState,
    isStreamingSlides: presentation.isStreamingSlides,
    persistSession,
    narrateSlide,
    stopNarration,
    exportPresentationPPTX: doExportPPTX,
    exportPresentationHTML: doExportHTML,

    // ── Export ──
    exportHtml,
    setExportHtml,

    // ── Poster ──
    posterState,
    setPosterState,
    extractedFigures: extractedFiguresRef.current || presentation.getExtractedFigures(),

    // ── Speech-to-Text ──
    sttEngine,
    setSttEngine,
    isListening: stt.isListening,
    interimTranscript: stt.interimTranscript,
    startListening: stt.startListening,
    stopListening: stt.stopListening,
    sttError: stt.error,
    clearSttError: stt.clearError,
    browserSTTSupported: stt.browserSTTSupported,

    // ── Misc ──
    messagesEndRef,
  };
}
