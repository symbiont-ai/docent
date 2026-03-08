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
  ImageCatalogEntry,
  ExtractedFigure,
  NarrativeArcEntry,
  PresentationPlan,
  PresentationMode,
  AssessmentState,
  AssessmentQuestion,
  AssessmentAnswer,
} from '@/src/types';
import { callChat, callChatStream } from '@/src/lib/api';
import type { TokenUsage } from '@/src/lib/api';
import type { ModelOption } from '@/src/types';
import { PRESENTATION_PROMPT, PRESENTATION_WORKFLOW, DEFAULT_MODEL, FALLBACK_MODELS, INTENT_META_INSTRUCTION, AUTHOR_MODE_PROMPT, JOURNAL_CLUB_PROMPT } from '@/src/lib/constants';
import {
  isPresentationIntent,
  extractPresentationJson,
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
  detectSupplementaryBoundary,
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
import { useTTS } from './useTTS';
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
  general: `Frame as a balanced overview — cover background, methods, key results, and conclusions evenly. Give each aspect proportional attention.`,
  author: `Frame as advocacy — lead with the problem the authors solved, then their method and its novelty, then results that demonstrate superiority over prior work. Emphasize contribution and impact.`,
  journal_club: `Frame as critical analysis — lead with the paper's central claim, then examine methodology strengths and weaknesses, assess evidence quality, identify limitations, and end with discussion points for the group.`,
};

function buildNarrativePlanningPrompt(
  figures: ExtractedFigure[],
  textSummary: string,
  mode: PresentationMode,
): string {
  const figureCatalog = figures.map(f =>
    `  - ${f.id}: ${f.label || f.kind} (page ${f.page}) — ${f.description}`
  ).join('\n');

  return `You are planning a presentation about a research paper. Your task is to produce a structured slide plan — NOT the slides themselves.

PAPER TEXT (first ~2000 tokens):
${textSummary}

AVAILABLE VISUAL ELEMENTS (from figure extraction):
${figureCatalog || '  (no figures/tables detected)'}

NARRATIVE STANCE:
${NARRATIVE_FRAMING[mode]}

Produce a JSON object with exactly two fields:

1. "paper_summary": A 2-3 sentence summary of the paper's main contribution and key findings.

2. "narrative_arc": An ordered slide plan. Each entry:
   { "slide_number": N, "title": "Slide Title", "element_ids": ["ef_1"], "purpose": "One-line description of what this slide accomplishes" }

   Rules:
   - Plan 8-12 content slides (do NOT include title or closing slides — those are added automatically).
   - Reference element_ids from the figure catalog above (e.g. "ef_1", "ef_2") for slides that should show a visual.
   - Not every slide needs a visual — text-only overview or conclusion slides are fine (use empty element_ids: []).
   - Order slides to tell a coherent story: context → method → results → implications.

Output ONLY valid JSON:
{
  "paper_summary": "...",
  "narrative_arc": [
    { "slide_number": 1, "title": "...", "element_ids": [...], "purpose": "..." },
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
          .filter((e: { slide_number?: number; title?: string }) => e.slide_number && e.title)
          .map((e: { slide_number: number; title: string; element_ids?: string[]; purpose?: string }, i: number) => ({
            slide_number: e.slide_number || (i + 1),
            title: e.title,
            element_ids: Array.isArray(e.element_ids) ? e.element_ids : [],
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

  // ── File state ───────────────────────────────────────────
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);

  // ── UI state ─────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat');
  const [showSidebar, setShowSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // ── Voice/model state ────────────────────────────────────
  const [voiceGender, setVoiceGender] = useState<VoiceGender>('female');
  const [autoVoice, setAutoVoice] = useState(false);
  const [ttsEngine, setTTSEngine] = useState<TTSEngine>('browser');
  const [googleApiKey, setGoogleApiKey] = useState('');
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [extractionModel, setExtractionModel] = useState(EXTRACTION_MODEL);
  const [apiKey, setApiKey] = useState('');
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
  const tts = useTTS(voiceGender, ttsEngine, googleApiKey);
  const memory = useMemory();
  const pdf = usePDF({ setLoadingMsg });
  const presentation = usePresentation(imageCatalogRef);
  const sessions = useSessions();

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
  }, []);

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

  // ── Fetch models from OpenRouter when API key changes ────
  useEffect(() => {
    if (!apiKey || !apiKey.startsWith('sk-or-')) {
      setAvailableModels(FALLBACK_MODELS);
      return;
    }

    let cancelled = false;
    const fetchModels = async () => {
      setModelsLoading(true);
      try {
        const res = await fetch('/api/models', {
          headers: { 'x-api-key': apiKey },
        });
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
      // - Presentations: 3 minutes (model may pause between slides for search/thinking)
      // - Normal chat: 2 minutes
      const isPresentation = presInProgressRef.current;
      const threshold = isPresentation ? 3 * 60_000 : 2 * 60_000;

      if (silentMs > threshold) {
        console.warn(`[Timeout] Stream silent for ${Math.round(silentMs / 1000)}s — aborting`);
        abortRef.current?.abort();
        abortRef.current = null;
        setIsLoading(false);
        setLoadingMsg('');
        setMessages(prev => prev.filter(m => !m.isThinking));
        presInProgressRef.current = false;
        presentation.finalizePresentation();
        setError(`Request timed out — no data received for ${isPresentation ? 3 : 2} minutes. Please try again.`);
      }
    }, 15_000);

    return () => clearInterval(checker);
  }, [isLoading]);

  // ── Build system prompt ───────────────────────────────────
  // Accepts userText so we can conditionally include presentation rules.
  // forcePresIntent overrides the keyword check (used after model-based intent detection).
  const buildSystemPrompt = useCallback((userText: string, forcePresIntent?: boolean, plan?: PresentationPlan | null): string => {
    // Base identity — always present
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    let prompt = `You are Sage, the AI assistant powering Docent — an intelligent presentation and research tool built by Symbiont AI Cognitive Labs. You read papers, analyze topics, and create clear, engaging presentations with beautiful SVG diagrams. You speak with confidence and warmth, making complex topics accessible.

Today's date is ${today}.

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
      prompt += `\n\n${PRESENTATION_PROMPT}`;

      // Mode-specific narrative stance
      if (plan) {
        if (plan.mode === 'author') {
          prompt += `\n\n${AUTHOR_MODE_PROMPT}`;
        } else if (plan.mode === 'journal_club') {
          prompt += `\n\n${JOURNAL_CLUB_PROMPT}`;
        }

        // Inject the narrative arc as a structural guide for Pass 2
        if (plan.narrative_arc.length > 0) {
          const arcLines = plan.narrative_arc.map(e =>
            `Slide ${e.slide_number}: "${e.title}" — figures: [${e.element_ids.join(', ')}] — ${e.purpose}`
          ).join('\n');
          prompt += `\n\nSLIDE PLAN (follow this structure — you may refine titles but maintain the ordering and figure assignments):
${arcLines}

IMPORTANT: Use the element_ids above when referencing figures. Use "extracted_ref" with the extractedId matching the element_id (e.g., {"type": "extracted_ref", "extractedId": "ef_1", "label": "..."}).
Do NOT predict new crop coordinates — use only the verified figures from the catalog.`;
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

      // Build slide index with brief content for all, full details for referenced slides
      const slideIndex = presState.slides.map((s, i) => {
        const num = i + 1;
        const viewing = i === presState.currentSlide ? ' \u2190 CURRENTLY VIEWING' : '';
        const isReferenced = referencedSlideNum === num;
        const bullets = s.content?.length ? s.content.join(' | ') : '';
        const figDesc = s.figure?.label ? `[Figure: ${s.figure.label}]` : '';

        if (isReferenced) {
          // Full details for the slide the user asked about
          const notes = s.speakerNotes ? `\n    Speaker notes: ${s.speakerNotes}` : '';
          return `>>> SLIDE ${num}: "${s.title}"${viewing} <<<\n    Bullets: ${bullets}\n    ${figDesc}${notes}`;
        }
        // Brief entry for other slides
        return `  ${num}. "${s.title}"${viewing}${bullets ? ' \u2014 ' + bullets : ''}`;
      }).join('\n');

      prompt += `\n\nPRESENTATION Q&A \u2014 You presented "${presState.title}" (${presState.slides.length} slides). Answer as the presenter.

SLIDE CONTENTS (${presState.slides.length} slides, numbered 1\u2013${presState.slides.length}):
${slideIndex}

RULE: When the user says "slide N", respond about EXACTLY the slide numbered ${referencedSlideNum || 'N'} above. Slide 1 = first slide (title). Do NOT recount or skip.`;
    }

    // Image catalog
    const { catalog, prompt: catalogPrompt } = buildImageCatalog(uploadedFiles, null);
    imageCatalogRef.current = catalog;
    if (catalogPrompt) {
      prompt += catalogPrompt;
    }

    // When NOT a presentation, append intent meta-instruction so the model
    // can signal [PRESENTATION_INTENT] for non-English presentation requests.
    // This has zero overhead for chat — the model just answers normally.
    if (!isPres) {
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
    const apiMessages: Array<{
      role: 'user' | 'assistant';
      content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    }> = [];

    // 1. PDF context — smart routing: images for visual tasks, text for everything else
    const hasPdf = pdf.pdfThumbnails.length > 0 || (pdf.pdfTextPages && pdf.pdfTextPages.length > 0);
    // Detect visual need early — also used to control history size (step 2)
    const needsVisual = hasPdf && (
      isPres ||
      /\b(figure|diagram|table|chart|image|graph|plot|illustration|photo|picture|visual|layout)\b/i.test(userText.toLowerCase())
    );
    if (hasPdf) {

      // Detect page range from user message (e.g. "pages 3-5", "page 7")
      const pageRangeMatch = userText.match(/pages?\s*(\d+)\s*(?:[-–to]+\s*(\d+))?/i);

      // Check if Pass 1 extraction produced figures (set by sendMessage before calling buildApiMessages)
      const extractedFigures = extractedFiguresRef.current;

      if (isPres && pdf.pdfThumbnails.length > 0 && !thumbnailsSentRef.current) {
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

          // Include PDF text (main body only, capped at supplementary boundary)
          const suppPage = detectSupplementaryBoundary(pdf.pdfTextPages);
          const mainBodyEnd = suppPage ? suppPage - 1 : pdf.pdfTextPages.length;

          const model = availableModels.find(m => m.id === selectedModel);
          const contextBudget = (model?.contextLength || 128_000) - 22_000;
          let textContent = `\nPDF Document Text (main body, ${mainBodyEnd} of ${pdf.pdfTotalPages} pages):\n\n`;
          for (let i = 0; i < mainBodyEnd; i++) {
            if (pdf.pdfTextPages[i]) {
              const pageBlock = `--- PAGE ${i + 1} ---\n${pdf.pdfTextPages[i]}\n\n`;
              if ((textContent.length + pageBlock.length) / 4 > contextBudget) {
                textContent += `\n--- TRUNCATED at page ${i + 1} (model context limit) ---\n`;
                break;
              }
              textContent += pageBlock;
            }
          }
          if (suppPage) {
            textContent += `\n--- Pages ${suppPage}–${pdf.pdfTotalPages} are supplementary material (not included). ---\n`;
          }
          catalogBlocks.push({ type: 'text', text: textContent });

          apiMessages.push({ role: 'user' as const, content: catalogBlocks });
          apiMessages.push({
            role: 'assistant' as const,
            content: `I've received the extracted figure catalog with ${extractedFigures.length} pre-identified visual elements, their cropped images, and the full paper text. I'll use "extracted_ref" to reference these figures when building slides.`,
          });
          thumbnailsSentRef.current = true;

          const cropCount = extractedFigures.filter(f => f.apiDataURL || f.croppedDataURL).length;
          console.log(`[API] Pass 2: catalog (${extractedFigures.length} figures, ${cropCount} crops) + text (${mainBodyEnd} pages) — skipping ${pdf.pdfThumbnails.length} full-page thumbnails`);
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

      // Text mode fallback — only if no visual context was already added above
      if (apiMessages.length === 0 && pdf.pdfTextPages && pdf.pdfTextPages.length > 0) {
        const hasSlides = presentation.presentationRef.current.slides.length > 0;

        if (hasSlides && !isPres) {
          // Post-presentation Q&A: system prompt already has slide index.
          // Send only a brief paper summary (first 3 pages, ~2K tokens) instead of full text.
          const summary = pdf.pdfTextPages.slice(0, 3).join('\n').slice(0, 8000);
          apiMessages.push({ role: 'user' as const, content: `Paper context (first 3 pages of ${pdf.pdfTotalPages}):\n${summary}` });
          apiMessages.push({
            role: 'assistant' as const,
            content: `I have the presentation context and a brief paper summary. How can I help?`,
          });
          console.log(`[API] Post-pres Q&A: sending brief summary (~${Math.round(summary.length / 4)} tokens) instead of full ${pdf.pdfTotalPages}-page text`);
        } else {
          // Full text mode — send extracted text (for summarization or pre-presentation Q&A)
          // Guard: cap text to fit within the selected model's context window.
          // Reserve tokens for system prompt (~4K), output (~16K), and conversation history (~2K).
          const model = availableModels.find(m => m.id === selectedModel);
          const contextBudget = (model?.contextLength || 128_000) - 22_000; // reserve 22K for prompt + output + history
          let textContent = `PDF Document (${pdf.pdfTotalPages} pages) — Extracted Text:\n\n`;
          let includedPages = 0;
          for (let i = 0; i < pdf.pdfTextPages.length; i++) {
            if (pdf.pdfTextPages[i]) {
              const pageBlock = `--- PAGE ${i + 1} ---\n${pdf.pdfTextPages[i]}\n\n`;
              // Approximate token count: ~1 token per 4 chars
              if ((textContent.length + pageBlock.length) / 4 > contextBudget) {
                textContent += `\n--- TRUNCATED: pages ${i + 1}–${pdf.pdfTotalPages} omitted (model context limit) ---\n`;
                console.warn(`[PDF] Truncated at page ${i}/${pdf.pdfTotalPages} to fit ${model?.name || 'model'} context (${Math.round(contextBudget)} token budget)`);
                break;
              }
              textContent += pageBlock;
              includedPages++;
            }
          }
          apiMessages.push({ role: 'user' as const, content: textContent });
          const truncNote = includedPages < pdf.pdfTotalPages
            ? ` I received the first ${includedPages} of ${pdf.pdfTotalPages} pages (remaining pages exceeded the context limit).`
            : '';
          apiMessages.push({
            role: 'assistant' as const,
            content: `I've read the full text of the ${pdf.pdfTotalPages}-page PDF document.${truncNote} I can summarize, answer questions, or analyze its content. What would you like me to do?`,
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
        apiMessages.push({
          role: 'assistant' as const,
          content: msg.text,
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
          content: `⚠️ CRITICAL: The user asked for EXACTLY ${n} content slides. Your JSON array must have EXACTLY ${n + 3} slides total (1 title + ${n} content + 1 references + 1 closing). Do NOT generate more or fewer than ${n} content slides. If you find yourself exceeding ${n}, STOP and remove the extra content slides before outputting.`,
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
          pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel,
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
          pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel,
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
          const maxTokens = Math.min((slides + 3) * 4000 + 2000, modelCap);
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

          const streamResult = await callChatStream(
            chatRequest, apiKey,
            (_delta: string, fullText: string) => {
              if (gen !== requestGenRef.current || cancelledGens.current.has(gen)) return;
              lastActivityRef.current = Date.now();

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
                setLoadingMsg(`Generating slides... ${updatedState.extractedCount} received`);
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

Available figures: ${plan.figures.map(f => `${f.id}: ${f.label || f.kind} (page ${f.page})`).join(', ')}

User says: "${text}"

Output ONLY valid JSON with the revised plan:
{ "narrative_arc": [...] }
Keep the same entry format: { "slide_number": N, "title": "...", "element_ids": [...], "purpose": "..." }
Only modify what the user requested. Maintain reasonable slide count (8-12).`;

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
                updatedArc = parsed.narrative_arc.filter(
                  (e: { slide_number?: number; title?: string }) => e.slide_number && e.title
                );
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

      if (presIntent && pdf.pdfDoc && pdf.pdfThumbnails.length > 0 && !thumbnailsSentRef.current) {
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
          if (controller.signal.aborted) throw new Error('Aborted');

          setLoadingMsg(deepThinking ? 'Planning presentation (thinking deeply)...' : 'Planning presentation structure...');
          const textSummary = pdf.pdfTextPages.slice(0, 5).join('\n').slice(0, 4000);
          const planningPrompt = buildNarrativePlanningPrompt(
            extractedFiguresRef.current || extractionResult.figures,
            textSummary,
            detectedMode,
          );

          const currentModel = availableModels.find(m => m.id === selectedModel);
          const planRequest = {
            messages: [{ role: 'user' as const, content: planningPrompt }],
            model: selectedModel,
            max_tokens: 4096,
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
          }

          // ── Author / Journal Club: surface plan and wait ──
          if (detectedMode !== 'general' && activePlan && activePlan.narrative_arc.length > 0) {
            const planText = formatPlanForChat(
              activePlan.narrative_arc,
              activePlan.paper_summary,
              activePlan.figures,
              activePlan.mode,
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
            );

            setIsLoading(false);
            setLoadingMsg('');
            presInProgressRef.current = false;
            return; // ← Pipeline splits here. Pass 2 runs when user confirms.
          }
        } catch (extractErr) {
          if (controller.signal.aborted) throw extractErr;
          console.warn('[Extraction/Planning] Pass 1 failed (will use thumbnail fallback):', extractErr);
          // Continue with fallback (thumbnails) — extractedFiguresRef stays null
        }
        setLoadingMsg('Generating slides...');
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
        const presMinTokens = Math.min((slides + 3) * 4000 + 2000, modelCap);
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
        if (presIntent) {
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
          // Keywords missed — stream live, but watch for [PRESENTATION_INTENT] marker
          let intentDetected = false;
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
                if (!intentDetected && fullText.length <= 150) {
                  if (fullText.includes('[PRESENTATION_INTENT]')) {
                    intentDetected = true;
                    // Abort this stream — we'll retry with full presentation prompt
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
                  if (!controller.signal.aborted) {
                    setLoadingMsg(deepThinking ? 'Planning presentation (thinking deeply)...' : 'Planning presentation structure...');
                    const textSummary = pdf.pdfTextPages.slice(0, 5).join('\n').slice(0, 4000);
                    const planningPrompt = buildNarrativePlanningPrompt(
                      extractedFiguresRef.current || extractionResult.figures, textSummary, retryMode,
                    );
                    const planRequest = {
                      messages: [{ role: 'user' as const, content: planningPrompt }],
                      model: selectedModel,
                      max_tokens: 4096,
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
                      retryPlan.narrative_arc, retryPlan.paper_summary, retryPlan.figures, retryPlan.mode,
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
                const presMinTokens = Math.min((slides + 3) * 4000 + 2000, modelCap);
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
        setLoadingMsg(presIntent ? 'Sage is creating your presentation...' : 'Sage is composing a response...');
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

      // Finalize streaming — unlock read-only mode
      if (presIntent) {
        presentation.finalizePresentation();
      }

      // 5. Extract memory notes
      responseText = await memory.extractMemoryFromResponse(responseText, text);

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
      await sessions.saveSession(
        finalMessages,
        sessions.currentSessionId || undefined,
        uploadedFiles,
        presentation.presentationRef.current.slides.length > 0 ? presentation.presentationRef.current : null,
        pdf.pdfPage,
        pdf.pdfZoom,
        currentTokenUsage,
        selectedModel,
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

    // onAlmostDone: prefetch next slide's audio while the last chunk of this slide plays
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
    }, ps.language, onAlmostDone); // Pass language + prefetch callback
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
  }), [presentation.setPresentationState, pdf.setPdfPage, pdf.setPdfZoom, pdf.loadPdf, pdf.removePdf]);

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
    );
  }, [sessions, messages, uploadedFiles, presentation, pdf.pdfPage, pdf.pdfZoom, lastTokenUsage, selectedModel]);

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

    // ── TTS (flattened from useTTS) ──
    autoVoice,
    setAutoVoice,
    ttsEngine,
    setTTSEngine,
    googleApiKey,
    setGoogleApiKey,
    isSpeaking: tts.isSpeaking,
    isLoadingAudio: tts.isLoadingAudio,
    speak: tts.speak,
    stopSpeaking: tts.stopSpeaking,

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

    // ── Misc ──
    messagesEndRef,
  };
}
