'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import { COLORS } from '@/src/lib/colors';
import { usePDFSearch } from '@/src/hooks/usePDFSearch';
import type { PDFTextItem } from '@/src/hooks/usePDF';
import type { UploadedFile } from '@/src/types';

interface PDFViewerProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc: any;
  pdfPage: number;
  setPdfPage: (v: number | ((prev: number) => number)) => void;
  pdfTotalPages: number;
  pdfZoom: number;
  setPdfZoom: (v: number | ((prev: number) => number)) => void;
  pdfCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  pdfContainerRef: React.RefObject<HTMLDivElement | null>;
  uploadedFiles: UploadedFile[];
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onRemovePdf: () => void;
  /** Called on mount to trigger PDF canvas render (fixes blank canvas on tab switch) */
  onMount?: () => void;
  /** Structured text items per page for search highlighting */
  pdfStructuredText?: PDFTextItem[][];
  /** Page heights in PDF points for coordinate Y-flip */
  pdfPageHeights?: number[];
}

export default function PDFViewer({
  pdfDoc,
  pdfPage,
  setPdfPage,
  pdfTotalPages,
  pdfZoom,
  setPdfZoom,
  pdfCanvasRef,
  pdfContainerRef,
  uploadedFiles,
  fileInputRef,
  onRemovePdf,
  onMount,
  pdfStructuredText = [],
  pdfPageHeights = [],
}: PDFViewerProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  // PDF search hook
  const search = usePDFSearch({
    structuredText: pdfStructuredText,
    pageHeights: pdfPageHeights,
    zoom: pdfZoom,
    currentPage: pdfPage,
    setPage: setPdfPage,
  });

  // Focus search input when opened
  useEffect(() => {
    if (search.isSearchOpen) {
      // Small delay to ensure the input is rendered
      const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [search.isSearchOpen]);

  // Keyboard handler for Ctrl+F and ESC
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      search.openSearch();
    }
    if (e.key === 'Escape' && search.isSearchOpen) {
      e.preventDefault();
      search.closeSearch();
    }
  }, [search]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Re-render the PDF canvas when this component mounts (tab switch)
  useEffect(() => {
    if (pdfDoc && onMount) {
      // Small delay to ensure canvas ref is attached
      const timer = setTimeout(onMount, 50);
      return () => clearTimeout(timer);
    }
  }, [pdfDoc, onMount]);
  const isFirstPage = pdfPage <= 1;
  const isLastPage = pdfPage >= pdfTotalPages;
  const pdfFileName = uploadedFiles.find(f => f.mediaType === 'application/pdf')?.name || 'Document';

  // --- Empty state ---
  if (!pdfDoc) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '16px',
        color: COLORS.textDim,
      }}>
        <span style={{ fontSize: '56px', opacity: 0.5 }}>{'\uD83D\uDCC4'}</span>
        <p style={{ margin: 0, fontSize: '16px', color: COLORS.textMuted }}>
          No PDF loaded
        </p>
        <p style={{
          margin: 0, fontSize: '13px', color: COLORS.textDim,
          fontFamily: 'system-ui, sans-serif',
        }}>
          Upload a PDF using the {'\uD83D\uDCCE'} button in the Chat tab
        </p>
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: '10px 20px', borderRadius: '8px',
            border: `1px solid ${COLORS.accent}`,
            backgroundColor: COLORS.accentBg, color: COLORS.accent,
            cursor: 'pointer', fontSize: '14px', fontWeight: 500,
            fontFamily: 'system-ui, sans-serif', marginTop: '8px',
          }}
        >
          {'\uD83D\uDCCE'} Upload PDF
        </button>
      </div>
    );
  }

  // --- PDF viewer ---
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{
        padding: '8px 12px', borderBottom: `1px solid ${COLORS.border}`,
        display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'center',
        backgroundColor: COLORS.surface,
      }}>
        {/* Page navigation */}
        <button
          onClick={() => setPdfPage(1)}
          disabled={isFirstPage}
          title="First page"
          style={{
            padding: '4px 8px', fontSize: '12px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '4px',
            color: isFirstPage ? COLORS.textDim : COLORS.textMuted,
            cursor: isFirstPage ? 'not-allowed' : 'pointer',
          }}
        >
          {'\u23EE'}
        </button>
        <button
          onClick={() => setPdfPage((p: number) => Math.max(1, p - 1))}
          disabled={isFirstPage}
          style={{
            padding: '4px 10px', fontSize: '14px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '4px',
            color: isFirstPage ? COLORS.textDim : COLORS.textMuted,
            cursor: isFirstPage ? 'not-allowed' : 'pointer',
          }}
        >
          {'\u25C0'}
        </button>
        <span style={{
          fontSize: '13px', color: COLORS.textMuted, fontFamily: 'system-ui, sans-serif',
        }}>
          Page {pdfPage} of {pdfTotalPages}
        </span>
        <button
          onClick={() => setPdfPage((p: number) => Math.min(pdfTotalPages, p + 1))}
          disabled={isLastPage}
          style={{
            padding: '4px 10px', fontSize: '14px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '4px',
            color: isLastPage ? COLORS.textDim : COLORS.textMuted,
            cursor: isLastPage ? 'not-allowed' : 'pointer',
          }}
        >
          {'\u25B6'}
        </button>
        <button
          onClick={() => setPdfPage(pdfTotalPages)}
          disabled={isLastPage}
          title="Last page"
          style={{
            padding: '4px 8px', fontSize: '12px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '4px',
            color: isLastPage ? COLORS.textDim : COLORS.textMuted,
            cursor: isLastPage ? 'not-allowed' : 'pointer',
          }}
        >
          {'\u23ED'}
        </button>

        {/* Divider */}
        <div style={{ width: '1px', height: '20px', backgroundColor: COLORS.border }} />

        {/* Zoom controls */}
        <button
          onClick={() => setPdfZoom((z: number) => Math.max(0.5, z - 0.25))}
          style={{
            padding: '4px 10px', fontSize: '14px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '4px',
            color: COLORS.textMuted, cursor: 'pointer',
          }}
        >
          {'\uD83D\uDD0D\u2212'}
        </button>
        <button
          onClick={() => setPdfZoom(1.0)}
          style={{
            padding: '4px 10px', fontSize: '11px',
            backgroundColor: pdfZoom === 1.0 ? COLORS.accentBg : 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '4px',
            color: pdfZoom === 1.0 ? COLORS.accent : COLORS.textMuted,
            cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
          }}
          title="Fit to width"
        >
          Fit
        </button>
        <span style={{
          fontSize: '12px', color: COLORS.textDim, minWidth: '50px',
          textAlign: 'center', fontFamily: 'system-ui, sans-serif',
        }}>
          {Math.round(pdfZoom * 100)}%
        </span>
        <button
          onClick={() => setPdfZoom((z: number) => Math.min(4, z + 0.25))}
          style={{
            padding: '4px 10px', fontSize: '14px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '4px',
            color: COLORS.textMuted, cursor: 'pointer',
          }}
        >
          {'\uD83D\uDD0D+'}
        </button>

        {/* Search button */}
        <button
          onClick={() => search.isSearchOpen ? search.closeSearch() : search.openSearch()}
          title="Search in PDF (Ctrl+F)"
          style={{
            padding: '4px 10px', fontSize: '14px',
            backgroundColor: search.isSearchOpen ? COLORS.accentBg : 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '4px',
            color: search.isSearchOpen ? COLORS.accent : COLORS.textMuted,
            cursor: 'pointer',
          }}
        >
          {'\uD83D\uDD0D'}
        </button>

        {/* Divider */}
        <div style={{ width: '1px', height: '20px', backgroundColor: COLORS.border }} />

        {/* Document name + remove */}
        <span style={{
          fontSize: '12px', color: COLORS.textDim, fontFamily: 'system-ui, sans-serif',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px',
        }}>
          {pdfFileName}
        </span>
        <button
          onClick={onRemovePdf}
          style={{
            padding: '4px 10px', fontSize: '13px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.red}`, borderRadius: '4px',
            color: COLORS.red, cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
          }}
        >
          {'\u2715'}
        </button>
      </div>

      {/* Search bar */}
      {search.isSearchOpen && (
        <div style={{
          padding: '6px 12px',
          borderBottom: `1px solid ${COLORS.border}`,
          backgroundColor: COLORS.surface,
          display: 'flex', gap: '8px', alignItems: 'center',
        }}>
          <input
            ref={searchInputRef}
            type="text"
            value={search.searchQuery}
            onChange={(e) => search.setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) {
                  search.goToPrevMatch();
                } else {
                  search.goToNextMatch();
                }
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                search.closeSearch();
              }
            }}
            placeholder="Search in PDF..."
            style={{
              flex: 1, maxWidth: '300px', padding: '5px 10px',
              fontSize: '13px', fontFamily: 'system-ui, sans-serif',
              backgroundColor: COLORS.bg, color: COLORS.text,
              border: `1px solid ${COLORS.border}`, borderRadius: '4px',
              outline: 'none',
            }}
          />
          <span style={{
            fontSize: '12px', color: COLORS.textDim,
            fontFamily: 'system-ui, sans-serif', minWidth: '60px',
          }}>
            {search.searchQuery.trim()
              ? search.totalMatches > 0
                ? `${search.currentMatchIndex + 1} of ${search.totalMatches}`
                : 'No matches'
              : ''}
          </span>
          <button
            onClick={search.goToPrevMatch}
            disabled={search.totalMatches === 0}
            title="Previous match (Shift+Enter)"
            style={{
              padding: '3px 8px', fontSize: '12px', backgroundColor: 'transparent',
              border: `1px solid ${COLORS.border}`, borderRadius: '4px',
              color: search.totalMatches === 0 ? COLORS.textDim : COLORS.textMuted,
              cursor: search.totalMatches === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {'\u25B2'}
          </button>
          <button
            onClick={search.goToNextMatch}
            disabled={search.totalMatches === 0}
            title="Next match (Enter)"
            style={{
              padding: '3px 8px', fontSize: '12px', backgroundColor: 'transparent',
              border: `1px solid ${COLORS.border}`, borderRadius: '4px',
              color: search.totalMatches === 0 ? COLORS.textDim : COLORS.textMuted,
              cursor: search.totalMatches === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {'\u25BC'}
          </button>
          <button
            onClick={search.closeSearch}
            title="Close search (Esc)"
            style={{
              padding: '3px 8px', fontSize: '13px', backgroundColor: 'transparent',
              border: `1px solid ${COLORS.border}`, borderRadius: '4px',
              color: COLORS.textMuted, cursor: 'pointer',
            }}
          >
            {'\u2715'}
          </button>
        </div>
      )}

      {/* Canvas area */}
      <div
        ref={pdfContainerRef}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setPdfZoom((z: number) => Math.min(4, Math.max(0.5, z + (e.deltaY < 0 ? 0.25 : -0.25))));
          }
        }}
        style={{
          flex: 1, overflow: 'auto', display: 'flex',
          padding: '16px',
          backgroundColor: COLORS.surfaceHover,
        }}
      >
        {/* Relative wrapper for canvas + highlight overlay */}
        <div style={{ position: 'relative', flexShrink: 0, margin: 'auto' }}>
          <canvas
            ref={pdfCanvasRef}
            style={{ display: 'block', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}
          />
          {/* Search highlight overlay */}
          {search.isSearchOpen && search.currentPageHighlights.length > 0 && (
            <div style={{
              position: 'absolute', top: 0, left: 0,
              width: '100%', height: '100%',
              pointerEvents: 'none',
            }}>
              {search.currentPageHighlights.map((rect, i) => (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: `${rect.x}px`,
                    top: `${rect.y}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                    backgroundColor: rect.isActive
                      ? 'rgba(255, 165, 0, 0.6)'   // Active: bright orange
                      : 'rgba(255, 215, 0, 0.3)',   // Others: light gold
                    borderRadius: '1px',
                    transition: 'background-color 0.15s ease',
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
