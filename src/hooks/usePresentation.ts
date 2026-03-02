'use client';

// ==========================================================
// DOCENT — Presentation Hook
// Slide state, navigation, loading, and keyboard controls
// ==========================================================

import { useState, useRef, useCallback, useEffect, type MutableRefObject } from 'react';
import type { PresentationState, PresentationData, Slide, ImageCatalogEntry } from '@/src/types';
import { decodeEntities, resolveImageRefs } from '@/src/lib/presentation';
import { resolveRegion } from '@/src/lib/pdf-utils';

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
    const { pdfDoc, pdfTotalPages, cropFn } = opts || {};

    // 1. Decode HTML entities in all slides
    let slides = data.slides.map(decodeSlide);

    // 2. Resolve image_ref figures from the catalog
    slides = resolveImageRefs(slides, imageCatalogRef.current);

    // 3. Pre-crop all PDF figures
    if (cropFn) {
      const croppedSlides: Slide[] = [];
      for (const slide of slides) {
        if (slide.figure?.type === 'pdf_crop' && slide.figure.page) {
          const region = resolveRegion(slide.figure.region);
          const dataURL = await cropFn(slide.figure.page, region, pdfDoc);
          croppedSlides.push({
            ...slide,
            figure: {
              ...slide.figure,
              croppedDataURL: dataURL || undefined,
            },
          });
        } else {
          croppedSlides.push(slide);
        }
      }
      slides = croppedSlides;
    }

    // 4. Auto-inject PDF title page snapshot on the first (title) slide
    if (pdfDoc && pdfTotalPages && pdfTotalPages > 0 && slides.length > 0 && cropFn) {
      const titleSlide = slides[0];
      // Inject if: no figure, text_only layout, or model generated a decorative SVG (PDF crop takes priority)
      if (!titleSlide.figure || titleSlide.layout === 'text_only' ||
          (titleSlide.figure.type === 'svg' && pdfDoc)) {
        const titlePageDataURL = await cropFn(1, [0, 0, 1, 0.5], pdfDoc);
        if (titlePageDataURL) {
          slides[0] = {
            ...titleSlide,
            layout: 'figure_focus',
            figure: {
              type: 'pdf_crop',
              page: 1,
              region: [0, 0, 1, 0.5],
              croppedDataURL: titlePageDataURL,
              label: 'Paper title page',
            },
          };
        }
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
   * Start streaming slides — initialize empty presentation and enter streaming mode.
   */
  const startStreamingSlides = useCallback((title: string, language: string) => {
    const newState: PresentationState = {
      ...INITIAL_STATE,
      title: decodeEntities(title),
      language: language || 'en',
      speakerNotesVisible: true,
    };
    presentationRef.current = newState;
    setPresentationState(newState);
    setIsStreamingSlides(true);
  }, []);

  /**
   * Add newly arrived slides during streaming (appends to existing slides).
   */
  const addStreamingSlides = useCallback((newSlides: Slide[]) => {
    if (newSlides.length === 0) return;
    const decoded = newSlides.map(decodeSlide);
    setPresentationState(prev => {
      const updated = { ...prev, slides: [...prev.slides, ...decoded] };
      presentationRef.current = updated;
      return updated;
    });
  }, [decodeSlide]);

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
    navigateSlide,
    setSlide,
    toggleAutoAdvance,
    toggleSpeakerNotes,
  };
}
