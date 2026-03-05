'use client';

// ==========================================================
// DOCENT — PDF Hook
// PDF loading, rendering to canvas, thumbnail generation, and figure cropping
// ==========================================================

import { useState, useRef, useCallback, useEffect } from 'react';
import { resolveRegion, cropPdfFigure } from '@/src/lib/pdf-utils';

// pdfjs-dist types (dynamic import)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PDFDocumentProxy = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PDFPageProxy = any;

export interface UsePDFOptions {
  setLoadingMsg?: (msg: string) => void;
}

export function usePDF(options?: UsePDFOptions) {
  const { setLoadingMsg } = options || {};

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfTotalPages, setPdfTotalPages] = useState(0);
  const [pdfZoom, setPdfZoom] = useState(1.0);
  const [pdfThumbnails, setPdfThumbnails] = useState<string[]>([]);
  const [pdfTextPages, setPdfTextPages] = useState<string[]>([]);

  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const figureCacheRef = useRef<Record<string, string>>({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeRenderTaskRef = useRef<any>(null);

  /**
   * Load a PDF from a data URL.
   * Dynamically imports pdfjs-dist, generates thumbnails, returns the doc.
   */
  const loadPdf = useCallback(async (
    dataURL: string,
    opts?: { skipThumbnails?: boolean },
  ): Promise<PDFDocumentProxy | null> => {
    try {
      setLoadingMsg?.('Loading PDF library...');

      // Dynamic import of pdfjs-dist
      const pdfjsLib = await import('pdfjs-dist');

      // Set worker source
      if (typeof window !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.mjs',
          import.meta.url,
        ).toString();
      }

      setLoadingMsg?.('Parsing PDF...');

      // Extract base64 data from data URL
      const base64 = dataURL.split(',')[1];
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
      const totalPages = doc.numPages;

      setPdfDoc(doc);
      setPdfTotalPages(totalPages);
      setPdfPage(1);
      figureCacheRef.current = {};

      // Generate thumbnails (up to 30 pages, 1600px wide for high-quality AI vision)
      if (!opts?.skipThumbnails) {
        setLoadingMsg?.('Generating thumbnails...');
        const thumbnails: string[] = [];
        const maxPages = Math.min(totalPages, 30);

        for (let i = 1; i <= maxPages; i++) {
          setLoadingMsg?.(`Generating thumbnail ${i}/${maxPages}...`);
          try {
            const page = await doc.getPage(i);
            // Scale to 1600px wide for sharper AI crop-coordinate detection
            const baseVp = page.getViewport({ scale: 1 });
            const thumbScale = 1600 / baseVp.width;
            const vp = page.getViewport({ scale: thumbScale });
            const canvas = document.createElement('canvas');
            canvas.width = vp.width;
            canvas.height = vp.height;
            const ctx = canvas.getContext('2d')!;
            await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
            thumbnails.push(canvas.toDataURL('image/jpeg', 0.85));
          } catch (e) {
            console.warn(`Thumbnail gen failed for page ${i}:`, e);
            thumbnails.push('');
          }
        }

        setPdfThumbnails(thumbnails);
      }

      // Extract text content from all pages (for summarization/Q&A)
      setLoadingMsg?.('Extracting text...');
      const textPages: string[] = [];
      for (let i = 1; i <= totalPages; i++) {
        if (i % 5 === 0 || i === 1) {
          setLoadingMsg?.(`Extracting text ${i}/${totalPages}...`);
        }
        try {
          const page = await doc.getPage(i);
          const textContent = await page.getTextContent();
          let pageText = '';
          let lastY: number | null = null;
          for (const item of textContent.items) {
            if ('str' in item) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const y = (item as any).transform?.[5];
              // New line when Y position changes significantly
              if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
                pageText += '\n';
              }
              pageText += item.str;
              if (y !== undefined) lastY = y;
            }
          }
          textPages.push(pageText.trim());
        } catch (e) {
          console.warn(`Text extraction failed for page ${i}:`, e);
          textPages.push('');
        }
      }
      setPdfTextPages(textPages);

      setLoadingMsg?.('');
      return doc;
    } catch (e) {
      console.error('PDF load failed:', e);
      setLoadingMsg?.('');
      return null;
    }
  }, [setLoadingMsg]);

  /**
   * Remove the current PDF and clean up state.
   */
  const removePdf = useCallback(() => {
    setPdfDoc(null);
    setPdfPage(1);
    setPdfTotalPages(0);
    setPdfZoom(1.0);
    setPdfThumbnails([]);
    setPdfTextPages([]);
    figureCacheRef.current = {};
  }, []);

  /**
   * Crop a figure from a specific PDF page region.
   * Uses the cache to avoid re-rendering the same crop.
   */
  const cropFigure = useCallback(async (
    pageNum: number,
    region: number[] | string | undefined,
    optionalDoc?: PDFDocumentProxy,
  ): Promise<string | null> => {
    const doc = optionalDoc || pdfDoc;
    if (!doc) return null;

    const resolved = resolveRegion(region);
    return cropPdfFigure(doc, pageNum, resolved, figureCacheRef.current);
  }, [pdfDoc]);

  /**
   * Render the current page to the canvas ref.
   * Exposed so PDFViewer can call it on mount (tab switch).
   */
  const renderCurrentPage = useCallback(async () => {
    if (!pdfDoc || !pdfCanvasRef.current) return;

    // Cancel any in-progress render to avoid "Cannot use the same canvas during multiple render()" errors
    if (activeRenderTaskRef.current) {
      try { activeRenderTaskRef.current.cancel(); } catch { /* already done */ }
      activeRenderTaskRef.current = null;
    }

    try {
      const page: PDFPageProxy = await pdfDoc.getPage(pdfPage);
      const canvas = pdfCanvasRef.current;
      if (!canvas) return;

      const scale = pdfZoom * 2.0; // Base 2x for retina
      const viewport = page.getViewport({ scale });

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      // Set CSS size (display size) to half of actual for retina sharpness
      canvas.style.width = `${viewport.width / 2}px`;
      canvas.style.height = `${viewport.height / 2}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const renderTask = page.render({ canvas, canvasContext: ctx, viewport });
      activeRenderTaskRef.current = renderTask;
      await renderTask.promise;
      activeRenderTaskRef.current = null;
    } catch (e: unknown) {
      // Ignore cancellation errors — they're expected when zoom changes rapidly
      if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'RenderingCancelledException') return;
      console.error('PDF render error:', e);
    }
  }, [pdfDoc, pdfPage, pdfZoom]);

  /**
   * Rendering effect: when pdfDoc, pdfPage, or pdfZoom changes,
   * render the current page to the canvas ref.
   */
  useEffect(() => {
    if (!pdfDoc || !pdfCanvasRef.current) return;

    let cancelled = false;

    const doRender = async () => {
      if (!cancelled) await renderCurrentPage();
    };

    doRender();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pdfPage, pdfZoom, renderCurrentPage]);

  return {
    // State
    pdfDoc,
    pdfPage,
    pdfTotalPages,
    pdfZoom,
    pdfThumbnails,
    pdfTextPages,

    // Setters
    setPdfDoc,
    setPdfPage,
    setPdfTotalPages,
    setPdfZoom,
    setPdfThumbnails,
    setPdfTextPages,

    // Refs
    pdfCanvasRef,
    pdfContainerRef,
    figureCacheRef,

    // Functions
    loadPdf,
    removePdf,
    cropPdfFigure: cropFigure,
    renderCurrentPage,
  };
}
