'use client';

import React, { useState, useCallback, useRef } from 'react';
import { useChat } from '@/src/hooks/useChat';
import { COLORS } from '@/src/lib/colors';
import { buildImagePrompt, buildEditorPrompt, buildImageSearchPrompt } from '@/src/lib/presentation';
import { callChat } from '@/src/lib/api';
import { detectLanguage } from '@/src/lib/language-detect';
import TopBar from './TopBar';
import Sidebar from './Sidebar';
import ChatPanel from './ChatPanel';
import SlideViewer from './SlideViewer';
import PDFViewer from './PDFViewer';
import ExportOverlay from './ExportOverlay';
import SettingsModal from './SettingsModal';
import CropEditor from './CropEditor';
import type { PresentationState, Figure } from '@/src/types';

export default function AppShell() {
  const {
    messages, input, setInput, isLoading, loadingMsg, error, setError,
    activeTab, setActiveTab, searchMode, setSearchMode, deepThinking,
    setDeepThinking, handleSend, showSettings, setShowSettings,
    voiceGender, setVoiceGender, apiKey, setApiKey, selectedModel,
    setSelectedModel, availableModels, modelsLoading,
    maxOutputTokens, setMaxOutputTokens,
    extractionModel, setExtractionModel,
    lastTokenUsage,
    assessmentState, startAssessment,
    auditSlide, auditResults, isAuditing, deepAnalysis, isDeepAnalyzing,
    showSidebar, setShowSidebar, savedSessions,
    currentSessionId, loadingSessions, sessionBusy, sageMemory,
    loadSession, deleteSession, newSession, clearAllSessions,
    deleteMemoryNote, clearAllMemory, autoVoice, setAutoVoice,
    ttsEngine, setTTSEngine, googleApiKey, setGoogleApiKey, browserVoiceName, setBrowserVoiceName,
    isSpeaking, isLoadingAudio, speak, speakChat, stopSpeaking, uploadedFiles, removeFile,
    fileInputRef, handleFileUpload, pdfDoc, pdfPage, setPdfPage,
    pdfTotalPages, pdfZoom, setPdfZoom, pdfCanvasRef, pdfContainerRef,
    removePdf, renderPdfPage, cropPdfFigure, pdfThumbnails, presentationState, setPresentationState, persistSession,
    isStreamingSlides,
    narrateSlide, stopNarration, exportPresentationPPTX, exportPresentationHTML,
    exportHtml, setExportHtml, cancelGeneration, messagesEndRef,
    autoSearchActive,
  } = useChat();

  // --- Image generation state ---
  const [imageLoading, setImageLoading] = useState(false);

  // --- Prompt editor state ---
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [promptEditorMode, setPromptEditorMode] = useState<'generate' | 'search'>('generate');
  const [promptEditorText, setPromptEditorText] = useState('');

  // --- Crop editor state ---
  const [cropEditorOpen, setCropEditorOpen] = useState(false);

  // --- Model's max completion tokens for settings slider ---
  const modelMaxTokens = availableModels.find(m => m.id === selectedModel)?.maxCompletionTokens || 32000;

  // --- Speak handler for chat (toggle) — always uses browser TTS ---
  const handleSpeak = (text: string, lang?: string) => {
    if (isSpeaking) stopSpeaking();
    else speakChat(text, undefined, lang);
  };

  // --- Slide navigation ---
  const handleSlideNavigate = (action: 'first' | 'prev' | 'next' | 'last') => {
    // Stop narration when user manually navigates
    if (isSpeaking) stopNarration();
    setPresentationState((p: PresentationState) => {
      switch (action) {
        case 'first': return { ...p, currentSlide: 0 };
        case 'prev': return { ...p, currentSlide: Math.max(0, p.currentSlide - 1) };
        case 'next': return { ...p, currentSlide: Math.min(p.slides.length - 1, p.currentSlide + 1) };
        case 'last': return { ...p, currentSlide: p.slides.length - 1 };
        default: return p;
      }
    });
  };

  // --- Slide actions ---
  const handleClearSlides = () => {
    setPresentationState((p: PresentationState) => ({
      ...p, slides: [], currentSlide: 0, title: '',
    }));
  };

  const handleToggleAutoAdvance = () => {
    setPresentationState((p: PresentationState) => ({ ...p, autoAdvance: !p.autoAdvance }));
  };

  const handleToggleNotes = () => {
    setPresentationState((p: PresentationState) => ({
      ...p, speakerNotesVisible: !p.speakerNotesVisible,
    }));
  };

  // --- Inline speaker notes editing (debounced persist) ---
  const notesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref for presentationState — lets useCallback closures read current value
  // without listing presentationState as a dependency (prevents callback churn on every state change).
  const presentationStateRef = useRef(presentationState);
  presentationStateRef.current = presentationState;
  const handleUpdateSpeakerNotes = useCallback((notes: string) => {
    if (isStreamingSlides) return; // read-only during streaming
    const slideIdx = presentationState.currentSlide;
    setPresentationState((prev: PresentationState) => ({
      ...prev,
      slides: prev.slides.map((s, i) =>
        i === slideIdx
          ? {
              ...s,
              speakerNotes: notes,
              // Backup original notes on first edit (if not already backed up)
              originalSpeakerNotes: s.originalSpeakerNotes ?? s.speakerNotes,
            }
          : s
      ),
    }));
    // Debounce persistence — save 500ms after last keystroke
    if (notesDebounceRef.current) clearTimeout(notesDebounceRef.current);
    notesDebounceRef.current = setTimeout(() => persistSession(), 500);
  }, [presentationState.currentSlide, setPresentationState, persistSession]);

  const handleRevertSpeakerNotes = useCallback(() => {
    if (isStreamingSlides) return;
    const slideIdx = presentationState.currentSlide;
    setPresentationState((prev: PresentationState) => ({
      ...prev,
      slides: prev.slides.map((s, i) =>
        i === slideIdx && s.originalSpeakerNotes
          ? { ...s, speakerNotes: s.originalSpeakerNotes }
          : s
      ),
    }));
    setTimeout(() => persistSession(), 150);
  }, [presentationState.currentSlide, setPresentationState, persistSession]);

  const handleNarrate = () => {
    narrateSlide(presentationState.currentSlide);
  };

  const handleAskAboutSlides = () => {
    if (presentationState.isPresenting) stopNarration();
    setActiveTab('chat');
  };

  // --- Show prompt editor (builds default prompt and opens modal) ---
  // Uses presentationStateRef so the callback identity is stable across presentationState changes
  // (prevents unnecessary SlideRenderer re-renders when React.memo is used).
  const handleShowPromptEditor = useCallback((mode: 'generate' | 'search') => {
    if (isStreamingSlides) return;
    const ps = presentationStateRef.current;
    const slide = ps.slides[ps.currentSlide];
    if (!slide) return;

    // Show the user only their slide content (in their language) — no English instruction labels.
    // English instructions are added behind the scenes when sending to the AI model.
    let editorPrompt: string;
    if (slide.figure?.imagePrompt) {
      editorPrompt = slide.figure.imagePrompt;
    } else if (mode === 'generate') {
      editorPrompt = buildEditorPrompt(slide, ps.title);
    } else {
      editorPrompt = buildImageSearchPrompt(slide, ps.title, ps.language);
    }

    setPromptEditorText(editorPrompt);
    setPromptEditorMode(mode);
    setPromptEditorOpen(true);
  }, [isStreamingSlides]);

  // --- Image upgrade: Generate AI image or Find real photo ---
  const handleGenerateImage = useCallback(async (mode: 'generate' | 'search', customPrompt?: string) => {
    const slideIdx = presentationState.currentSlide;
    const slide = presentationState.slides[slideIdx];
    if (!slide || !apiKey) {
      if (!apiKey) setError('Please set your OpenRouter API key in Settings first.');
      return;
    }

    setPromptEditorOpen(false);
    setImageLoading(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let newFigure: Figure = undefined as any;
      let newSpeakerNotes: string | undefined;
      // Filter out old "Image:" references from previous Find Photo results
      let updatedRefs = (slide.references || []).filter(r => !r.startsWith('Image:'));

      if (mode === 'generate') {
        // ── AI Image Generation (Nano Banana / Gemini) ──
        // Resolve effective language (fallback to detection if language field is 'en' but content isn't)
        let effectiveLang = presentationState.language;
        if (effectiveLang === 'en' || !effectiveLang) {
          const sample = [slide.title, ...(slide.content || []), slide.speakerNotes || ''].join(' ');
          const det = detectLanguage(sample);
          if (det !== 'en') effectiveLang = det;
        }
        // When customPrompt comes from the editor, it's content-only (user's language).
        // Wrap it with English instruction labels via buildImagePrompt's customContent param.
        const prompt = customPrompt
          ? buildImagePrompt(slide, presentationState.title, effectiveLang, customPrompt)
          : buildImagePrompt(slide, presentationState.title, effectiveLang);

        console.log('[Generate] Requesting image, prompt length:', prompt.length);

        const res = await fetch('/api/generate-image', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({ prompt }),
        });

        const result = await res.json();
        console.log('[Generate] Response status:', res.status, res.ok ? 'OK' : 'FAILED');

        if (!res.ok || result.error) {
          throw new Error(result.error || `Image generation failed (${res.status})`);
        }

        newFigure = {
          type: 'image',
          src: result.dataURL,
          label: slide.figure?.label || slide.title,
          caption: 'AI-generated image',
          // Store the editor content (user's language, no English labels) so re-opening
          // the prompt editor shows the user's content, not the full English-wrapped prompt.
          imagePrompt: customPrompt || buildEditorPrompt(slide, presentationState.title),
        };

        // Capture updated speaker notes from Gemini (returned alongside the image)
        if (result.speakerNotes) {
          newSpeakerNotes = result.speakerNotes;
          console.log('[Generate] Speaker notes updated:', result.speakerNotes.substring(0, 100));
        }

      } else {
        // ── Find Real Photo (via LLM + web search + image proxy) ──
        // When customPrompt is provided (from the editor), wrap it in search instructions
        // so the LLM knows to return a URL instead of generating an image
        const baseContext = customPrompt || buildImageSearchPrompt(slide, presentationState.title, presentationState.language);

        const MAX_SEARCH_ATTEMPTS = 3;
        const failedUrls: string[] = [];
        let imageUrl = '';
        let credit = '';
        let description = '';
        let searchPrompt = '';

        for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
          // Build search prompt — on retries, tell the LLM which URLs failed
          if (customPrompt) {
            const failedNote = failedUrls.length > 0
              ? `\n\nIMPORTANT: These URLs could NOT be downloaded (hotlink-protected or blocked). Do NOT return them again:\n${failedUrls.map(u => `- ${u}`).join('\n')}\nFind a DIFFERENT image from a different source.`
              : '';
            searchPrompt = `Use web search to find ONE relevant, high-quality photo for this context: ${customPrompt}

Requirements:
- You MUST search the web to find a real, existing image — do NOT hallucinate or make up URLs
- Return a DIRECT image URL (ending in .jpg, .jpeg, .png, .gif, .webp, or a direct image link)
- ONLY use images from freely accessible sources: Wikimedia Commons (upload.wikimedia.org/wikipedia/commons/), NASA, government sites (.gov), Unsplash, Pexels, Pixabay
- NEVER use images from: wikia.nocookie.net, fandom.com, getty, shutterstock, alamy, dreamstime, 123rf, or any stock photo site
- Provide proper attribution/credit${failedNote}

Return your answer as JSON ONLY, no other text:
{"url": "https://...", "credit": "Source Name / Author", "description": "Brief description"}`;
          } else {
            const failedNote = failedUrls.length > 0
              ? `\n\nIMPORTANT: These URLs could NOT be downloaded (hotlink-protected). Do NOT return them:\n${failedUrls.map(u => `- ${u}`).join('\n')}\nFind a DIFFERENT image from a different source.`
              : '';
            searchPrompt = baseContext + failedNote;
          }

          console.log(`[Find Photo] Attempt ${attempt}/${MAX_SEARCH_ATTEMPTS}, prompt length: ${searchPrompt.length}`);

          // Use the chat API with search enabled to find a real image
          const { content: searchResult } = await callChat(
            {
              messages: [{ role: 'user', content: searchPrompt }],
              model: selectedModel || 'anthropic/claude-sonnet-4',
              max_tokens: 1024,
              options: { search: true },
            },
            apiKey,
          );

          console.log('[Find Photo] Raw LLM response:', searchResult.substring(0, 500));

          // Parse the JSON response from the LLM
          imageUrl = '';
          credit = '';
          description = '';

          try {
            // Strip markdown code fences if present
            let cleanResult = searchResult.trim();
            cleanResult = cleanResult.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

            // Extract JSON from the response
            const jsonMatch = cleanResult.match(/\{[\s\S]*?"url"\s*:\s*"[\s\S]*?\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              imageUrl = parsed.url || '';
              credit = parsed.credit || parsed.source || '';
              description = parsed.description || '';
            }
          } catch {
            // Try to extract URL directly
            const urlMatch = searchResult.match(/https?:\/\/[^\s"'<>]+\.(jpg|jpeg|png|gif|webp)[^\s"'<>]*/i);
            if (urlMatch) {
              imageUrl = urlMatch[0];
              credit = 'Web';
            }
          }

          console.log('[Find Photo] Parsed URL:', imageUrl, 'Credit:', credit);

          if (!imageUrl) {
            console.error('[Find Photo] No URL found in response:', searchResult.substring(0, 300));
            if (attempt === MAX_SEARCH_ATTEMPTS) {
              throw new Error('Could not find a suitable image URL. Try modifying your prompt or use ✨ Generate instead.');
            }
            continue;
          }

          // Try to proxy-download the image
          console.log('[Find Photo] Proxying image URL:', imageUrl);
          const proxyRes = await fetch(`/api/image-proxy?url=${encodeURIComponent(imageUrl)}`);
          const proxyResult = await proxyRes.json();

          if (!proxyRes.ok || proxyResult.error) {
            console.warn(`[Find Photo] Proxy failed (attempt ${attempt}):`, proxyResult.error);
            failedUrls.push(imageUrl);
            if (attempt === MAX_SEARCH_ATTEMPTS) {
              throw new Error(`Failed to download image after ${MAX_SEARCH_ATTEMPTS} attempts. Try ✨ Generate instead.`);
            }
            continue; // retry with a different URL
          }

          console.log('[Find Photo] Image proxied successfully, dataURL length:', proxyResult.dataURL?.length);

          // Success — break out of retry loop
          newFigure = {
            type: 'image',
            src: proxyResult.dataURL,
            label: description || slide.figure?.label || slide.title,
            caption: credit ? `Source: ${credit}` : undefined,
            imagePrompt: customPrompt || baseContext,
          };

          // Image description and credit are already stored in figure.label and figure.caption;
          // do NOT overwrite speaker notes with the image caption.

          if (credit) {
            updatedRefs = [...updatedRefs, `Image: ${credit}${imageUrl ? ` (${imageUrl})` : ''}`];
          }
          break;
        }

        // If we exhausted all attempts without setting newFigure
        if (!newFigure) {
          throw new Error('Could not find a downloadable image. Try ✨ Generate instead.');
        }
      }

      // Update the single slide (backup originals on first replacement, update notes)
      setPresentationState((prev: PresentationState) => ({
        ...prev,
        slides: prev.slides.map((s, i) =>
          i === slideIdx
            ? {
                ...s,
                figure: newFigure,
                originalFigure: s.originalFigure || s.figure,              // preserve very first original
                originalSpeakerNotes: s.originalSpeakerNotes ?? s.speakerNotes,  // backup notes on first replacement
                originalReferences: s.originalReferences ?? s.references,        // backup refs on first replacement
                speakerNotes: newSpeakerNotes || s.speakerNotes,           // update notes if available
                references: updatedRefs.length > 0 ? updatedRefs : s.references,
              }
            : s
        ),
      }));

      // Persist to IndexedDB (setTimeout lets React state flush to the ref first)
      setTimeout(() => persistSession(), 150);

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate image.';
      setError(msg);
    } finally {
      setImageLoading(false);
    }
  }, [presentationState, apiKey, selectedModel, setError, setPresentationState, persistSession]);

  // --- Revert to original figure, speaker notes, and references ---
  const handleRevertFigure = useCallback(() => {
    if (isStreamingSlides) return;
    const slideIdx = presentationState.currentSlide;
    setPresentationState((prev: PresentationState) => ({
      ...prev,
      slides: prev.slides.map((s, i) =>
        i === slideIdx && s.originalFigure
          ? {
              ...s,
              figure: s.originalFigure,
              speakerNotes: s.originalSpeakerNotes ?? s.speakerNotes,
              references: s.originalReferences ?? s.references,
              originalFigure: undefined,
              originalSpeakerNotes: undefined,
              originalReferences: undefined,
            }
          : s
      ),
    }));
    // Persist to IndexedDB
    setTimeout(() => persistSession(), 150);
  }, [presentationState.currentSlide, setPresentationState, persistSession]);

  // --- Crop editor: open ---
  const handleShowCropEditor = useCallback(() => {
    if (isStreamingSlides) return;
    setCropEditorOpen(true);
  }, [isStreamingSlides]);

  // --- Crop editor: apply new region ---
  const handleApplyCrop = useCallback((newRegion: number[]) => {
    const slideIdx = presentationStateRef.current.currentSlide;
    setPresentationState((prev: PresentationState) => ({
      ...prev,
      slides: prev.slides.map((s, i) =>
        i === slideIdx && s.figure?.type === 'pdf_crop'
          ? { ...s, figure: { ...s.figure, region: newRegion, croppedDataURL: undefined } }
          : s
      ),
    }));
    setCropEditorOpen(false);
    setTimeout(() => persistSession(), 150);
  }, [setPresentationState, persistSession]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      backgroundColor: COLORS.bg, color: COLORS.text,
      fontFamily: "'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif",
    }}>
      {/* Global keyframe animations */}
      <style>{`
        @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* Hidden file input (accessible from all tabs) */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        multiple
        accept=".pdf,.png,.jpg,.jpeg,.gif,.webp"
        style={{ display: 'none' }}
      />

      {/* ===== TOP BAR ===== */}
      <TopBar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        pdfDoc={pdfDoc}
        pdfTotalPages={pdfTotalPages}
        slidesCount={presentationState.slides.length}
        autoVoice={autoVoice}
        setAutoVoice={setAutoVoice}
        isSpeaking={isSpeaking}
        stopSpeaking={stopSpeaking}
        showSidebar={showSidebar}
        setShowSidebar={setShowSidebar}
        setShowSettings={setShowSettings}
      />

      {/* ===== LOADING STATUS BAR ===== */}
      {isLoading && (
        <div style={{
          padding: '8px 20px', backgroundColor: COLORS.surface,
          borderBottom: `1px solid ${COLORS.border}`,
          display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0,
        }}>
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            backgroundColor: COLORS.accent,
            animation: 'pulse 1.5s ease-in-out infinite',
          }} />
          <span style={{
            fontSize: '13px', color: COLORS.text, fontFamily: 'system-ui, sans-serif',
          }}>
            {loadingMsg || 'Sage is working...'}
          </span>
          {autoSearchActive && (
            <span style={{
              fontSize: '11px', color: COLORS.cyan, padding: '2px 8px',
              backgroundColor: COLORS.cyanBg, borderRadius: '4px',
              border: `1px solid ${COLORS.cyan}40`,
            }}>
              {'\uD83D\uDD0D'} search on
            </span>
          )}
          <span
            onClick={cancelGeneration}
            style={{
              fontSize: '12px', color: '#FFFFFF', textDecoration: 'underline',
              cursor: 'pointer', marginLeft: '4px',
            }}
          >
            cancel
          </span>
        </div>
      )}

      {/* ===== TOKEN USAGE BAR ===== */}
      {!isLoading && lastTokenUsage && (
        <div style={{
          padding: '6px 20px', backgroundColor: COLORS.surface,
          borderBottom: `1px solid ${COLORS.border}`,
          display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0,
        }}>
          <span style={{
            fontSize: '11px', color: COLORS.textMuted, fontFamily: 'system-ui, sans-serif',
          }}>
            Tokens: {lastTokenUsage.prompt_tokens.toLocaleString()} in · {lastTokenUsage.completion_tokens.toLocaleString()} out · {lastTokenUsage.total_tokens.toLocaleString()} total
          </span>
        </div>
      )}

      {/* ===== ERROR BAR ===== */}
      {!isLoading && error && (
        <div style={{
          padding: '8px 20px', backgroundColor: COLORS.redBg,
          borderBottom: `1px solid ${COLORS.red}40`,
          display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0,
        }}>
          <span style={{
            fontSize: '13px', color: COLORS.red,
            fontFamily: 'system-ui, sans-serif', flex: 1,
          }}>
            {'\u26A0\uFE0F'} {error}
          </span>
          <span
            onClick={() => setError(null)}
            style={{
              fontSize: '12px', color: COLORS.red, textDecoration: 'underline',
              cursor: 'pointer',
            }}
          >
            dismiss
          </span>
        </div>
      )}

      {/* ===== MAIN AREA ===== */}
      <div style={{
        flex: 1, display: 'flex', overflow: 'hidden', position: 'relative',
      }}>
        {/* ===== SIDEBAR ===== */}
        <Sidebar
          show={showSidebar}
          savedSessions={savedSessions}
          currentSessionId={currentSessionId}
          loadingSessions={loadingSessions}
          sageMemory={sageMemory}
          onLoadSession={loadSession}
          onDeleteSession={deleteSession}
          onNewSession={newSession}
          onClearAllSessions={clearAllSessions}
          onDeleteMemoryNote={deleteMemoryNote}
          onClearAllMemory={clearAllMemory}
          sessionBusy={sessionBusy}
        />

        {/* ===== SESSION BUSY INDICATOR ===== */}
        {sessionBusy && (
          <div style={{
            position: 'absolute', top: 0,
            left: showSidebar ? 280 : 0, right: 0,
            zIndex: 50, display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: '10px',
            padding: '10px', backgroundColor: COLORS.surface + 'F0',
            borderBottom: `1px solid ${COLORS.accentBorder}`,
            backdropFilter: 'blur(4px)',
          }}>
            <div style={{
              width: '16px', height: '16px',
              border: `2px solid ${COLORS.accent}`,
              borderTopColor: 'transparent',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite',
            }} />
            <span style={{
              fontSize: '13px', color: COLORS.accent, fontWeight: 500,
              fontFamily: 'system-ui, sans-serif',
            }}>
              {sessionBusy}
            </span>
          </div>
        )}

        {/* ===== TAB CONTENT ===== */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {activeTab === 'chat' && (
            <ChatPanel
              messages={messages}
              input={input}
              setInput={setInput}
              isLoading={isLoading}
              handleSend={handleSend}
              searchMode={searchMode}
              setSearchMode={setSearchMode}
              deepThinking={deepThinking}
              setDeepThinking={setDeepThinking}
              uploadedFiles={uploadedFiles}
              removeFile={removeFile}
              fileInputRef={fileInputRef}
              onSpeak={handleSpeak}
              isSpeaking={isSpeaking}
              messagesEndRef={messagesEndRef}
              loadingMsg={loadingMsg}
              autoSearchActive={autoSearchActive}
              selectedModelName={availableModels.find(m => m.id === selectedModel)?.name || selectedModel}
              assessmentPhase={assessmentState.phase}
              hasPresentation={presentationState.slides.length > 0}
            />
          )}

          {activeTab === 'slides' && (
            <SlideViewer
              presentationState={presentationState}
              isLoading={isLoading}
              loadingMsg={loadingMsg}
              isSpeaking={isSpeaking}
              onExportPPTX={exportPresentationPPTX}
              onExportHTML={exportPresentationHTML}
              onClear={handleClearSlides}
              onNavigate={handleSlideNavigate}
              onNarrate={handleNarrate}
              onStopNarration={stopNarration}
              onToggleAutoAdvance={handleToggleAutoAdvance}
              onToggleNotes={handleToggleNotes}
              onAskAboutSlides={handleAskAboutSlides}
              onAssessMe={() => { setActiveTab('chat'); startAssessment(); }}
              onShowPromptEditor={handleShowPromptEditor}
              onRevertFigure={handleRevertFigure}
              onShowCropEditor={handleShowCropEditor}
              onUpdateSpeakerNotes={handleUpdateSpeakerNotes}
              onRevertSpeakerNotes={handleRevertSpeakerNotes}
              imageLoading={imageLoading}
              isLoadingAudio={isLoadingAudio}
              isStreamingSlides={isStreamingSlides}
              cropFn={cropPdfFigure}
              onAudit={() => auditSlide(presentationState.currentSlide)}
              auditResult={auditResults[presentationState.currentSlide] || null}
              isAuditing={isAuditing}
              onDeepAnalysis={() => { setActiveTab('chat'); deepAnalysis(); }}
              isDeepAnalyzing={isDeepAnalyzing}
              hasPdf={!!pdfDoc}
            />
          )}

          {activeTab === 'pdf' && (
            <PDFViewer
              pdfDoc={pdfDoc}
              pdfPage={pdfPage}
              setPdfPage={setPdfPage}
              pdfTotalPages={pdfTotalPages}
              pdfZoom={pdfZoom}
              setPdfZoom={setPdfZoom}
              pdfCanvasRef={pdfCanvasRef}
              pdfContainerRef={pdfContainerRef}
              uploadedFiles={uploadedFiles}
              fileInputRef={fileInputRef}
              onRemovePdf={removePdf}
              onMount={renderPdfPage}
            />
          )}
        </main>
      </div>

      {/* ===== EXPORT OVERLAY ===== */}
      {exportHtml && (
        <ExportOverlay
          html={exportHtml}
          title={presentationState.title}
          slidesCount={presentationState.slides.length}
          onClose={() => setExportHtml(null)}
        />
      )}

      {/* ===== PROMPT EDITOR MODAL ===== */}
      {promptEditorOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        }}
          onClick={() => setPromptEditorOpen(false)}
        >
          <div
            style={{
              width: '520px', maxWidth: '90vw', maxHeight: '80vh',
              backgroundColor: COLORS.surface, border: `1px solid ${COLORS.border}`,
              borderRadius: '12px', padding: '20px',
              display: 'flex', flexDirection: 'column', gap: '12px',
              boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{
                fontSize: '14px', fontWeight: 600, color: COLORS.text,
                fontFamily: 'system-ui, sans-serif',
              }}>
                {'\uD83D\uDCDD'} Image Prompt
              </span>
              <button
                onClick={() => setPromptEditorOpen(false)}
                style={{
                  background: 'none', border: 'none', color: COLORS.textMuted,
                  cursor: 'pointer', fontSize: '16px', padding: '2px 6px',
                }}
              >
                {'\u2715'}
              </button>
            </div>

            {/* Textarea */}
            <textarea
              value={promptEditorText}
              onChange={(e) => setPromptEditorText(e.target.value)}
              style={{
                flex: 1, minHeight: '160px', maxHeight: '50vh',
                padding: '12px', fontSize: '13px', lineHeight: '1.5',
                fontFamily: 'system-ui, sans-serif',
                backgroundColor: COLORS.bg, color: COLORS.text,
                border: `1px solid ${COLORS.border}`, borderRadius: '8px',
                resize: 'vertical', outline: 'none',
              }}
              onFocus={(e) => {
                e.target.style.borderColor = COLORS.accent;
              }}
              onBlur={(e) => {
                e.target.style.borderColor = COLORS.border;
              }}
              spellCheck={false}
            />

            {/* Action buttons */}
            <div style={{
              display: 'flex', gap: '8px', justifyContent: 'flex-end',
            }}>
              <button
                onClick={() => setPromptEditorOpen(false)}
                style={{
                  padding: '6px 16px', fontSize: '12px', borderRadius: '6px',
                  cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                  backgroundColor: 'transparent', border: `1px solid ${COLORS.border}`,
                  color: COLORS.textMuted,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleGenerateImage('search', promptEditorText)}
                style={{
                  padding: '6px 16px', fontSize: '12px', borderRadius: '6px',
                  cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                  backgroundColor: 'transparent', border: `1px solid ${COLORS.cyan}`,
                  color: COLORS.cyan,
                }}
              >
                {'\uD83D\uDD0D'} Find Photo
              </button>
              <button
                onClick={() => handleGenerateImage('generate', promptEditorText)}
                style={{
                  padding: '6px 16px', fontSize: '12px', borderRadius: '6px',
                  cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                  backgroundColor: COLORS.accent, border: `1px solid ${COLORS.accent}`,
                  color: COLORS.bg, fontWeight: 600,
                }}
              >
                {'\u2728'} Generate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== CROP EDITOR MODAL ===== */}
      {cropEditorOpen && (() => {
        const cs = presentationState.slides[presentationState.currentSlide];
        const thumb = cs?.figure?.page ? pdfThumbnails[cs.figure.page - 1] : undefined;
        return cs?.figure?.type === 'pdf_crop' && thumb ? (
          <CropEditor
            figure={cs.figure}
            pageThumb={thumb}
            cropFn={cropPdfFigure}
            onApply={handleApplyCrop}
            onCancel={() => setCropEditorOpen(false)}
          />
        ) : null;
      })()}

      {/* ===== SETTINGS MODAL ===== */}
      <SettingsModal
        show={showSettings}
        onClose={() => setShowSettings(false)}
        voiceGender={voiceGender}
        setVoiceGender={setVoiceGender}
        ttsEngine={ttsEngine}
        setTTSEngine={setTTSEngine}
        googleApiKey={googleApiKey}
        setGoogleApiKey={setGoogleApiKey}
        browserVoiceName={browserVoiceName}
        setBrowserVoiceName={setBrowserVoiceName}
        sessionLanguage={presentationState.language}
        apiKey={apiKey}
        setApiKey={setApiKey}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
        maxOutputTokens={maxOutputTokens}
        setMaxOutputTokens={setMaxOutputTokens}
        modelMaxTokens={modelMaxTokens}
        extractionModel={extractionModel}
        setExtractionModel={setExtractionModel}
      />
    </div>
  );
}
