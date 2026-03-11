'use client';

// ==========================================================
// DOCENT — Presentation Hook
// Slide state, navigation, loading, and keyboard controls
// ==========================================================

import { useState, useRef, useCallback, useEffect, type MutableRefObject } from 'react';
import type { PresentationState, PresentationData, Slide, ImageCatalogEntry, ExtractedFigure, PresentationMode, NarrativeArcEntry } from '@/src/types';
import { decodeEntities, resolveImageRefs } from '@/src/lib/presentation';
import { resolveRegion } from '@/src/lib/pdf-utils';
import { sanitizeSvg } from '@/src/lib/svg-repair';

const INITIAL_STATE: PresentationState = {
  slides: [],
  currentSlide: 0,
  title: '',
  language: 'en',
  isPresenting: false,
  autoAdvance: false,
  speakerNotesVisible: false,
};

export interface LoadPresentationOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc?: any;
  pdfTotalPages?: number;
  cropFn?: (pageNum: number, region: number[] | string | undefined, doc?: unknown) => Promise<string | null>;
  extractedFigures?: ExtractedFigure[];
  /** Presentation mode — skip title page injection for 'author' mode */
  mode?: PresentationMode;
  /** Narrative arc from plan — used to enforce extracted_ref figure assignments */
  narrativeArc?: NarrativeArcEntry[];
}

export function usePresentation(
  imageCatalogRef: MutableRefObject<ImageCatalogEntry[]>,
) {
  const [presentationState, setPresentationState] = useState<PresentationState>(INITIAL_STATE);
  const presentationRef = useRef<PresentationState>(INITIAL_STATE);
  const [isStreamingSlides, setIsStreamingSlides] = useState(false);

  // Keep ref in sync with state for async reads
  useEffect(() => {
    presentationRef.current = presentationState;
  }, [presentationState]);

  // ── Plan-based figure enforcement ────────────────────────
  // Stored from loadPresentation options so addStreamingSlides can also use it
  const narrativeArcRef = useRef<NarrativeArcEntry[]>([]);
  const extractedFiguresCacheRef = useRef<ExtractedFigure[]>([]);

  /**
   * Validate extracted_ref figures in slides — ensure referenced IDs exist in the catalog.
   * Pass 2 now handles figure-to-slide matching (it sees the actual images), so we only
   * validate that references are valid, not force specific assignments.
   */
  function validateExtractedRefs(
    slides: Slide[],
    figures: ExtractedFigure[],
  ): Slide[] {
    if (figures.length === 0) return slides;

    return slides.map((slide) => {
      // If slide uses extracted_ref, verify the ID exists in the catalog
      if (slide.figure?.type === 'extracted_ref') {
        const refId = (slide.figure as { extractedId?: string }).extractedId;
        if (refId && !figures.find(f => f.id === refId)) {
          console.warn(`[FigureValidate] Slide "${slide.title}": extracted_ref ${refId} not found in catalog — clearing`);
          return { ...slide, figure: undefined };
        }
      }
      return slide;
    });
  }

  /**
   * Decode HTML entities in all text fields of a slide.
   */
  const decodeSlide = useCallback((slide: Slide): Slide => {
    return {
      ...slide,
      title: decodeEntities(slide.title),
      content: slide.content?.map(c => decodeEntities(c)),
      references: slide.references?.map(r => decodeEntities(r)),
      speakerNotes: slide.speakerNotes ? decodeEntities(slide.speakerNotes) : undefined,
      figure: slide.figure
        ? {
            ...slide.figure,
            label: slide.figure.label ? decodeEntities(slide.figure.label) : undefined,
            description: slide.figure.description ? decodeEntities(slide.figure.description) : undefined,
            caption: slide.figure.caption ? decodeEntities(slide.figure.caption) : undefined,
            // Sanitize SVG content for common weak-model issues (viewBox, font-size, xmlns)
            content: slide.figure.type === 'svg' && slide.figure.content
              ? sanitizeSvg(slide.figure.content)
              : slide.figure.content,
          }
        : undefined,
    };
  }, []);

  /**
   * Load a new presentation from parsed JSON data.
   * Resolves image refs, pre-crops PDF figures, and auto-injects title page snapshot.
   */
  const loadPresentation = useCallback(async (
    data: PresentationData,
    opts?: LoadPresentationOptions,
  ): Promise<void> => {
    const { pdfDoc, pdfTotalPages, cropFn, extractedFigures, mode, narrativeArc } = opts || {};

    // Cache arc + figures for streaming enforcement
    if (narrativeArc) narrativeArcRef.current = narrativeArc;
    if (extractedFigures) extractedFiguresCacheRef.current = extractedFigures;

    // 1. Decode HTML entities in all slides
    let slides = data.slides.map(decodeSlide);

    // 2. Resolve image_ref figures from the catalog
    slides = resolveImageRefs(slides, imageCatalogRef.current);

    // 2.5. Resolve extracted_ref figures from the extraction catalog → pdf_crop metadata
    // Crops are resolved lazily by SlideRenderer (no base64 embedded in slide objects)
    if (extractedFigures && extractedFigures.length > 0) {
      slides = slides.map(slide => {
        if (slide.figure?.type !== 'extracted_ref' || !slide.figure.extractedId) return slide;
        const ef = extractedFigures.find(f => f.id === slide.figure!.extractedId);
        if (!ef) {
          console.warn(`[SlideResolve:load] "${slide.title}": extractedId="${slide.figure.extractedId}" NOT FOUND`);
          return { ...slide, figure: { type: 'card' as const, label: slide.figure.label || 'Figure', description: slide.figure.description || '' } };
        }
        console.log(`[SlideResolve:load] "${slide.title}": ${slide.figure.extractedId} → page ${ef.page}, region [${ef.region.map(n => n.toFixed(2))}], label="${ef.label}", desc="${ef.description?.slice(0, 60)}"`);
        return { ...slide, figure: { type: 'pdf_crop' as const, page: ef.page, region: ef.region, extractedId: slide.figure.extractedId, label: slide.figure.label || ef.label || ef.description, description: ef.description } };
      });
    }

    // 3. Validate extracted_ref references exist in the catalog
    if (extractedFiguresCacheRef.current.length > 0) {
      slides = validateExtractedRefs(slides, extractedFiguresCacheRef.current);
    }

    // 4. Auto-inject PDF title page snapshot on the first (title) slide
    // Only store metadata — SlideRenderer lazily crops via cropFn
    // Skip for Author mode — the author wouldn't display their own paper as a figure
    if (pdfDoc && pdfTotalPages && pdfTotalPages > 0 && slides.length > 0 && mode !== 'author') {
      const titleSlide = slides[0];
      // Inject if: no figure, text_only layout, or model generated a decorative SVG (PDF crop takes priority)
      if (!titleSlide.figure || titleSlide.layout === 'text_only' ||
          (titleSlide.figure.type === 'svg' && pdfDoc)) {
        slides[0] = {
          ...titleSlide,
          layout: 'figure_focus',
          figure: {
            type: 'pdf_crop',
            page: 1,
            region: [0, 0, 1, 0.5],
            label: 'Paper title page',
          },
        };
      }
    }

    const newState: PresentationState = {
      slides,
      currentSlide: 0,
      title: decodeEntities(data.title),
      language: data.language || 'en',
      isPresenting: false,
      autoAdvance: true,
      speakerNotesVisible: true,
    };

    // Update ref immediately so callers (e.g. saveSession) can read the
    // new state synchronously before the next React render cycle.
    presentationRef.current = newState;
    setPresentationState(newState);
  }, [decodeSlide, imageCatalogRef]);

  /**
   * Cache the narrative arc and extracted figures for validation during streaming.
   * Call this before starting a streaming session when a plan is available.
   */
  const setNarrativeContext = useCallback((arc: NarrativeArcEntry[], figures: ExtractedFigure[]) => {
    narrativeArcRef.current = arc;
    extractedFiguresCacheRef.current = figures;
  }, []);

  /**
   * Start streaming slides — initialize empty presentation and enter streaming mode.
   */
  const startStreamingSlides = useCallback((title: string, language: string) => {
    const newState: PresentationState = {
      ...INITIAL_STATE,
      title: decodeEntities(title),
      language: language || 'en',
      autoAdvance: true,           // Default to auto-advance for new presentations
      speakerNotesVisible: true,
    };
    presentationRef.current = newState;
    setPresentationState(newState);
    setIsStreamingSlides(true);
  }, []);

  /**
   * Add newly arrived slides during streaming (appends to existing slides).
   * Resolves extracted_ref → pdf_crop and image_ref → image so figures render
   * immediately during streaming (not just after loadPresentation finalizes).
   */
  const addStreamingSlides = useCallback((newSlides: Slide[], extractedFigures?: ExtractedFigure[]) => {
    if (newSlides.length === 0) return;
    let decoded = newSlides.map(decodeSlide);

    // Resolve extracted_ref → pdf_crop (same logic as loadPresentation step 2.5)
    if (extractedFigures && extractedFigures.length > 0) {
      decoded = decoded.map(slide => {
        if (slide.figure?.type !== 'extracted_ref' || !slide.figure.extractedId) return slide;
        const ef = extractedFigures.find(f => f.id === slide.figure!.extractedId);
        if (!ef) {
          console.warn(`[SlideResolve] "${slide.title}": extractedId="${slide.figure.extractedId}" NOT FOUND in catalog`);
          return { ...slide, figure: { type: 'card' as const, label: slide.figure.label || 'Figure', description: slide.figure.description || '' } };
        }
        console.log(`[SlideResolve] "${slide.title}": ${slide.figure.extractedId} → page ${ef.page}, region [${ef.region.map(n => n.toFixed(2))}], label="${ef.label}", desc="${ef.description?.slice(0, 60)}"`);
        return { ...slide, figure: { type: 'pdf_crop' as const, page: ef.page, region: ef.region, extractedId: slide.figure.extractedId, label: slide.figure.label || ef.label || ef.description, description: ef.description } };
      });
    }

    // Resolve image_ref → image (same logic as loadPresentation step 2)
    decoded = resolveImageRefs(decoded, imageCatalogRef.current);

    // Enforce extracted_ref for plan-assigned figures (uses cached arc + figures)
    // Validate extracted_ref references exist in the catalog
    if (extractedFiguresCacheRef.current.length > 0) {
      decoded = validateExtractedRefs(decoded, extractedFiguresCacheRef.current);
    }

    setPresentationState(prev => {
      const updated = { ...prev, slides: [...prev.slides, ...decoded] };
      presentationRef.current = updated;
      return updated;
    });
  }, [decodeSlide, imageCatalogRef]);

  /**
   * Finalize streaming — exit read-only mode, unlock all controls.
   */
  const finalizePresentation = useCallback(() => {
    setIsStreamingSlides(false);
  }, []);

  /**
   * Clear the current presentation.
   */
  const clearPresentation = useCallback(() => {
    presentationRef.current = INITIAL_STATE;
    setPresentationState(INITIAL_STATE);
  }, []);

  /**
   * Navigate slides by direction (-1 or +1).
   */
  const navigateSlide = useCallback((direction: number) => {
    setPresentationState(prev => {
      if (prev.slides.length === 0) return prev;
      const newIdx = Math.max(0, Math.min(prev.slides.length - 1, prev.currentSlide + direction));
      if (newIdx === prev.currentSlide) return prev;
      return { ...prev, currentSlide: newIdx };
    });
  }, []);

  /**
   * Jump to a specific slide index.
   */
  const setSlide = useCallback((index: number) => {
    setPresentationState(prev => {
      const clamped = Math.max(0, Math.min(prev.slides.length - 1, index));
      return { ...prev, currentSlide: clamped };
    });
  }, []);

  /**
   * Toggle auto-advance mode.
   */
  const toggleAutoAdvance = useCallback(() => {
    setPresentationState(prev => ({
      ...prev,
      autoAdvance: !prev.autoAdvance,
    }));
  }, []);

  /**
   * Toggle speaker notes visibility.
   */
  const toggleSpeakerNotes = useCallback(() => {
    setPresentationState(prev => ({
      ...prev,
      speakerNotesVisible: !prev.speakerNotesVisible,
    }));
  }, []);

  /**
   * Keyboard navigation: ArrowLeft/Right/Home/End for slides
   */
  useEffect(() => {
    // Enable keyboard nav when slides exist (not dependent on isPresenting)
    if (presentationRef.current.slides.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          navigateSlide(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          navigateSlide(1);
          break;
        case 'Home':
          e.preventDefault();
          setSlide(0);
          break;
        case 'End':
          e.preventDefault();
          setPresentationState(prev => ({
            ...prev,
            currentSlide: Math.max(0, prev.slides.length - 1),
          }));
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [presentationState.isPresenting, navigateSlide, setSlide]);

  return {
    // State
    presentationState,
    setPresentationState,
    isStreamingSlides,

    // Ref for async reads
    presentationRef,

    // Functions
    loadPresentation,
    startStreamingSlides,
    addStreamingSlides,
    finalizePresentation,
    clearPresentation,
    setNarrativeContext,
    getNarrativeArc: useCallback(() => narrativeArcRef.current, []),
    getExtractedFigures: useCallback(() => extractedFiguresCacheRef.current, []),
    navigateSlide,
    setSlide,
    toggleAutoAdvance,
    toggleSpeakerNotes,
  };
}
