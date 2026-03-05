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
  UploadedFile,
  ActiveTab,
  VoiceGender,
  TTSEngine,
  ImageCatalogEntry,
} from '@/src/types';
import { callChat, callChatStream } from '@/src/lib/api';
import type { TokenUsage } from '@/src/lib/api';
import type { ModelOption } from '@/src/types';
import { PRESENTATION_PROMPT, PRESENTATION_WORKFLOW, DEFAULT_MODEL, FALLBACK_MODELS, INTENT_META_INSTRUCTION } from '@/src/lib/constants';
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
import { useTTS } from './useTTS';
import { useMemory } from './useMemory';
import { usePDF } from './usePDF';
import { usePresentation } from './usePresentation';
import { useSessions } from './useSessions';

export function useChat() {
  // ── Core chat state ──────────────────────────────────────
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState(false);
  const [deepThinking, setDeepThinking] = useState(false);

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
  const buildSystemPrompt = useCallback((userText: string, forcePresIntent?: boolean): string => {
    // Base identity — always present
    let prompt = `You are Sage, the AI assistant powering Docent — an intelligent presentation and research tool built by Symbiont AI Cognitive Labs. You read papers, analyze topics, and create clear, engaging presentations with beautiful SVG diagrams. You speak with confidence and warmth, making complex topics accessible.

You can save important observations, user preferences, and key findings using [NOTE: your observation] tags. These will persist across conversations.`;

    // Detect if the user is requesting a presentation
    const isPres = forcePresIntent ?? isPresentationIntent(userText, messages);

    if (isPres) {
      // Presentation mode: include workflow + generation rules
      prompt += `\n\n${PRESENTATION_WORKFLOW}`;
      prompt += `\n\n${PRESENTATION_PROMPT}`;
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

      if (isPres && pdf.pdfThumbnails.length > 0 && !thumbnailsSentRef.current) {
        // Presentation generation — send all thumbnails (needed for crop coordinates)
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
      } else if (pdf.pdfTextPages && pdf.pdfTextPages.length > 0) {
        // Text mode — send extracted text (10x more efficient for summarization/Q&A)
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

    // Only treat as presentation intent if the *current* message asks for one.
    // Checking history caused follow-up questions to show "creating presentation..." loading.
    let presIntent = isPresentationIntent(text);
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
      // Build initial system prompt and messages.
      // If keywords didn't detect presentation intent, the system prompt includes
      // INTENT_META_INSTRUCTION so the model can signal [PRESENTATION_INTENT].
      let systemPrompt = buildSystemPrompt(text, presIntent);
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
                presentation.addStreamingSlides(newSlides);
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
              setLoadingMsg('Sage is creating your presentation...');

              // Rebuild with full presentation system prompt
              systemPrompt = buildSystemPrompt(text, true);
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
                    presentation.addStreamingSlides(newSlides);
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
        response = await callChat(chatRequest, apiKey, controller.signal);
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

  // ── Export presentation as PPTX ────────────────────────
  const doExportPPTX = useCallback(async () => {
    setIsLoading(true);
    try {
      await exportPPTX(presentation.presentationRef.current, (msg) => {
        setLoadingMsg(msg);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PPTX export failed');
    } finally {
      setIsLoading(false);
      setLoadingMsg('');
    }
  }, [presentation]);

  // ── Export presentation as HTML ────────────────────────
  const doExportHTML = useCallback(() => {
    const ps = presentation.presentationRef.current;
    if (ps.slides.length === 0) return;
    const html = generateExportHTML(ps.slides, ps.title, ps.speakerNotesVisible);
    setExportHtml(html);
  }, [presentation]);

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
    lastTokenUsage,

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
