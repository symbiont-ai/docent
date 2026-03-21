// ==========================================================
// DOCENT — PDF Search Hook
// Provides Ctrl+F style text search across PDF pages
// with match navigation and per-page highlight positions
// ==========================================================

'use client';

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { PDFTextItem } from './usePDF';

// ── Types ────────────────────────────────────────────────

/** A single match location in the PDF */
interface PDFMatch {
  /** 0-based page index */
  pageIndex: number;
  /** Index of the first text item containing part of the match */
  itemIndex: number;
  /** Character offset within that item's string */
  charOffset: number;
}

/** A highlight rectangle for rendering on screen */
export interface HighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Is this the currently active (navigated-to) match? */
  isActive: boolean;
}

interface UsePDFSearchOptions {
  /** Structured text items per page from pdf.js */
  structuredText: PDFTextItem[][];
  /** Page heights in PDF points (for Y-flip) */
  pageHeights: number[];
  /** Current zoom level */
  zoom: number;
  /** Current page (1-based) */
  currentPage: number;
  /** Callback to navigate to a different page */
  setPage: (page: number) => void;
}

interface UsePDFSearchReturn {
  isSearchOpen: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  currentMatchIndex: number;
  totalMatches: number;
  /** Highlight rectangles for the current page only */
  currentPageHighlights: HighlightRect[];
  openSearch: () => void;
  closeSearch: () => void;
  goToNextMatch: () => void;
  goToPrevMatch: () => void;
}

// ── Constants ────────────────────────────────────────────

const DEBOUNCE_MS = 150;

// ── Hook ─────────────────────────────────────────────────

export function usePDFSearch({
  structuredText,
  pageHeights,
  zoom,
  currentPage,
  setPage,
}: UsePDFSearchOptions): UsePDFSearchReturn {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQueryRaw] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search query
  const setSearchQuery = useCallback((q: string) => {
    setSearchQueryRaw(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(q);
      setCurrentMatchIndex(0);
    }, DEBOUNCE_MS);
  }, []);

  // Clean up debounce timer
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Compute all matches across all pages ──────────────

  const allMatches = useMemo((): PDFMatch[] => {
    const query = debouncedQuery.toLowerCase().trim();
    if (!query || structuredText.length === 0) return [];

    const matches: PDFMatch[] = [];

    for (let pageIdx = 0; pageIdx < structuredText.length; pageIdx++) {
      const items = structuredText[pageIdx];
      if (!items.length) continue;

      // Build a concatenated string for this page to search across item boundaries
      const concat = items.map(it => it.str).join('');
      const concatLower = concat.toLowerCase();

      // Find all occurrences
      let searchFrom = 0;
      while (searchFrom < concatLower.length) {
        const idx = concatLower.indexOf(query, searchFrom);
        if (idx === -1) break;

        // Map concat offset back to item index + char offset
        let charCount = 0;
        for (let i = 0; i < items.length; i++) {
          const itemLen = items[i].str.length;
          if (charCount + itemLen > idx) {
            matches.push({
              pageIndex: pageIdx,
              itemIndex: i,
              charOffset: idx - charCount,
            });
            break;
          }
          charCount += itemLen;
        }

        searchFrom = idx + 1; // Move past to find overlapping matches
      }
    }

    return matches;
  }, [debouncedQuery, structuredText]);

  // ── Compute highlight rectangles for current page ─────

  const currentPageHighlights = useMemo((): HighlightRect[] => {
    const query = debouncedQuery.toLowerCase().trim();
    if (!query || allMatches.length === 0) return [];

    const pageIdx = currentPage - 1;
    const pageHeight = pageHeights[pageIdx] || 792;
    const items = structuredText[pageIdx];
    if (!items?.length) return [];

    const rects: HighlightRect[] = [];

    for (let mi = 0; mi < allMatches.length; mi++) {
      const match = allMatches[mi];
      if (match.pageIndex !== pageIdx) continue;

      const isActive = mi === currentMatchIndex;

      // Calculate highlight rectangle(s) for this match
      // A match may span multiple text items
      let remainingChars = query.length;
      let itemIdx = match.itemIndex;
      let charOff = match.charOffset;

      while (remainingChars > 0 && itemIdx < items.length) {
        const item = items[itemIdx];
        const strLen = item.str.length;
        const charsInThisItem = Math.min(remainingChars, strLen - charOff);

        if (strLen > 0 && item.width > 0) {
          // PDF coordinates: transform[4]=X, transform[5]=Y (bottom-left origin)
          const pdfX = item.transform[4];
          const pdfY = item.transform[5];
          const charWidth = item.width / strLen;

          const startX = pdfX + charOff * charWidth;
          const matchWidth = charsInThisItem * charWidth;

          // Convert to screen coordinates (Y-flip + zoom)
          const screenX = startX * zoom;
          const screenY = (pageHeight - pdfY - item.height) * zoom;
          const screenW = matchWidth * zoom;
          const screenH = item.height * zoom;

          rects.push({
            x: screenX,
            y: screenY,
            width: screenW,
            height: screenH,
            isActive,
          });
        }

        remainingChars -= charsInThisItem;
        itemIdx++;
        charOff = 0; // Subsequent items start from char 0
      }
    }

    return rects;
  }, [debouncedQuery, allMatches, currentMatchIndex, currentPage, pageHeights, structuredText, zoom]);

  // ── Navigation ────────────────────────────────────────

  const goToNextMatch = useCallback(() => {
    if (allMatches.length === 0) return;
    const next = (currentMatchIndex + 1) % allMatches.length;
    setCurrentMatchIndex(next);
    const targetPage = allMatches[next].pageIndex + 1;
    if (targetPage !== currentPage) {
      setPage(targetPage);
    }
  }, [allMatches, currentMatchIndex, currentPage, setPage]);

  const goToPrevMatch = useCallback(() => {
    if (allMatches.length === 0) return;
    const prev = (currentMatchIndex - 1 + allMatches.length) % allMatches.length;
    setCurrentMatchIndex(prev);
    const targetPage = allMatches[prev].pageIndex + 1;
    if (targetPage !== currentPage) {
      setPage(targetPage);
    }
  }, [allMatches, currentMatchIndex, currentPage, setPage]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQueryRaw('');
    setDebouncedQuery('');
    setCurrentMatchIndex(0);
  }, []);

  return {
    isSearchOpen,
    searchQuery,
    setSearchQuery,
    currentMatchIndex,
    totalMatches: allMatches.length,
    currentPageHighlights,
    openSearch,
    closeSearch,
    goToNextMatch,
    goToPrevMatch,
  };
}
