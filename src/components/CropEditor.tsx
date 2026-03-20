'use client';

// ==========================================================
// DOCENT — Crop Editor Modal
// Visual bounding box correction for pdf_crop figures.
// User draws a new rectangle on the PDF page thumbnail.
// ==========================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { COLORS } from '@/src/lib/colors';
import { resolveRegion } from '@/src/lib/pdf-utils';
import type { Figure } from '@/src/types';

interface CropEditorProps {
  figure: Figure;
  pageThumb: string;
  cropFn: (page: number, region: number[] | string | undefined) => Promise<string | null>;
  onApply: (newRegion: number[]) => void;
  onCancel: () => void;
}

export default function CropEditor({ figure, pageThumb, cropFn, onApply, onCancel }: CropEditorProps) {
  // Resolve string presets (e.g. "top_half") to numeric coords
  const originalRegion = resolveRegion(figure.region) || [0, 0, 1, 1];

  // ── Drawing state ──
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);

  // ── Finalized new region ──
  const [newRegion, setNewRegion] = useState<number[] | null>(null);

  // ── Preview ──
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ── Refs ──
  const overlayRef = useRef<HTMLDivElement>(null);

  // ── Escape to close ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  // ── Generate preview when newRegion changes ──
  const generatePreview = useCallback(async (region: number[]) => {
    if (!figure.page) return;
    setPreviewLoading(true);
    try {
      const result = await cropFn(figure.page, region);
      setPreviewUrl(result);
    } finally {
      setPreviewLoading(false);
    }
  }, [figure.page, cropFn]);

  // Load initial preview (current crop)
  useEffect(() => {
    generatePreview(originalRegion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mouse handlers for draw-to-select ──
  const getNormalizedCoords = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const coords = getNormalizedCoords(e);
    setIsDragging(true);
    setDragStart(coords);
    setDragCurrent(coords);
    setNewRegion(null);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    e.preventDefault();
    setDragCurrent(getNormalizedCoords(e));
  };

  const handleMouseUp = () => {
    if (!isDragging || !dragStart || !dragCurrent) return;
    setIsDragging(false);

    const left = Math.min(dragStart.x, dragCurrent.x);
    const top = Math.min(dragStart.y, dragCurrent.y);
    const right = Math.max(dragStart.x, dragCurrent.x);
    const bottom = Math.max(dragStart.y, dragCurrent.y);

    // Ignore tiny rectangles (accidental clicks)
    if (right - left < 0.02 || bottom - top < 0.02) {
      setDragStart(null);
      setDragCurrent(null);
      return;
    }

    const region = [left, top, right, bottom];
    setNewRegion(region);
    setDragStart(null);
    setDragCurrent(null);
    generatePreview(region);
  };

  // Also handle mouse leaving the overlay while dragging
  const handleMouseLeave = () => {
    if (isDragging) handleMouseUp();
  };

  // ── Region to CSS style ──
  const regionToStyle = (r: number[], color: string, borderStyle = 'solid'): React.CSSProperties => ({
    position: 'absolute',
    left: `${r[0] * 100}%`,
    top: `${r[1] * 100}%`,
    width: `${(r[2] - r[0]) * 100}%`,
    height: `${(r[3] - r[1]) * 100}%`,
    border: `2px ${borderStyle} ${color}`,
    pointerEvents: 'none',
    boxSizing: 'border-box',
  });

  // ── Active selection rectangle (during drag) ──
  const selectionRect = isDragging && dragStart && dragCurrent ? (() => {
    const left = Math.min(dragStart.x, dragCurrent.x);
    const top = Math.min(dragStart.y, dragCurrent.y);
    const right = Math.max(dragStart.x, dragCurrent.x);
    const bottom = Math.max(dragStart.y, dragCurrent.y);
    return [left, top, right, bottom];
  })() : null;

  // The region to highlight (new selection, or original if no new one)
  const activeRegion = newRegion || originalRegion;

  // ── Dim overlay strips (area outside the active crop region) ──
  const renderDimOverlay = (r: number[]) => {
    const dimColor = 'rgba(0,0,0,0.55)';
    return (
      <>
        {/* Top strip */}
        <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: `${r[1] * 100}%`, backgroundColor: dimColor, pointerEvents: 'none' }} />
        {/* Bottom strip */}
        <div style={{ position: 'absolute', left: 0, top: `${r[3] * 100}%`, right: 0, bottom: 0, backgroundColor: dimColor, pointerEvents: 'none' }} />
        {/* Left strip */}
        <div style={{ position: 'absolute', left: 0, top: `${r[1] * 100}%`, width: `${r[0] * 100}%`, height: `${(r[3] - r[1]) * 100}%`, backgroundColor: dimColor, pointerEvents: 'none' }} />
        {/* Right strip */}
        <div style={{ position: 'absolute', left: `${r[2] * 100}%`, top: `${r[1] * 100}%`, right: 0, height: `${(r[3] - r[1]) * 100}%`, backgroundColor: dimColor, pointerEvents: 'none' }} />
      </>
    );
  };

  const handleReset = () => {
    setNewRegion(null);
    setDragStart(null);
    setDragCurrent(null);
    generatePreview(originalRegion);
  };

  const handleApply = () => {
    if (newRegion) {
      onApply(newRegion);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: '900px', maxWidth: '95vw', maxHeight: '90vh',
          backgroundColor: COLORS.surface, border: `1px solid ${COLORS.border}`,
          borderRadius: '12px', padding: '20px',
          display: 'flex', flexDirection: 'column', gap: '16px',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '16px', color: COLORS.text, fontWeight: 600 }}>
              Adjust Crop Region
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: COLORS.textMuted }}>
              Draw a rectangle on the page to select the figure region. Page {figure.page}.
            </p>
          </div>
          <button
            onClick={onCancel}
            style={{
              background: 'none', border: 'none', color: COLORS.textMuted,
              fontSize: '20px', cursor: 'pointer', padding: '4px 8px',
              lineHeight: 1,
            }}
            title="Close"
          >
            {'\u2715'}
          </button>
        </div>

        {/* ── Body: Thumbnail + Preview ── */}
        <div style={{
          flex: 1, display: 'flex', gap: '16px',
          minHeight: 0, overflow: 'hidden',
        }}>
          {/* Left: PDF page thumbnail with interactive overlay */}
          <div style={{
            flex: '1 1 60%', display: 'flex', flexDirection: 'column',
            minHeight: 0, overflow: 'hidden',
          }}>
            <div style={{
              fontSize: '11px', color: COLORS.textMuted, marginBottom: '6px',
              fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
            }}>
              PDF Page {figure.page}
            </div>
            <div style={{
              flex: 1, position: 'relative', display: 'flex',
              alignItems: 'flex-start', justifyContent: 'center',
              overflow: 'auto', minHeight: 0,
              backgroundColor: COLORS.bg, borderRadius: '8px',
              border: `1px solid ${COLORS.border}`,
            }}>
              {/* The page thumbnail */}
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <img
                  src={pageThumb}
                  alt={`Page ${figure.page}`}
                  style={{
                    display: 'block',
                    maxWidth: '100%', maxHeight: '65vh',
                    objectFit: 'contain',
                  }}
                  draggable={false}
                />

                {/* Interactive overlay — captures mouse events */}
                <div
                  ref={overlayRef}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                  style={{
                    position: 'absolute', inset: 0,
                    cursor: isDragging ? 'crosshair' : 'crosshair',
                  }}
                >
                  {/* Dim area outside current/active region */}
                  {!isDragging && renderDimOverlay(activeRegion)}

                  {/* Current region border (dashed if no new selection, solid if active) */}
                  {!newRegion && !isDragging && (
                    <div style={regionToStyle(originalRegion, COLORS.accentStrong, 'dashed')} />
                  )}

                  {/* New region border (solid accent) */}
                  {newRegion && !isDragging && (
                    <div style={regionToStyle(newRegion, COLORS.accent, 'solid')} />
                  )}

                  {/* Active drawing rectangle */}
                  {selectionRect && (
                    <div style={{
                      ...regionToStyle(selectionRect, COLORS.accent, 'solid'),
                      backgroundColor: COLORS.accentBg,
                    }} />
                  )}

                  {/* Dim during drag */}
                  {isDragging && selectionRect && renderDimOverlay(selectionRect)}
                </div>
              </div>
            </div>
          </div>

          {/* Right: Preview panel */}
          <div style={{
            flex: '1 1 40%', display: 'flex', flexDirection: 'column',
            minHeight: 0, overflow: 'hidden',
          }}>
            <div style={{
              fontSize: '11px', color: COLORS.textMuted, marginBottom: '6px',
              fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
            }}>
              Preview
            </div>
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              backgroundColor: COLORS.bg, borderRadius: '8px',
              border: `1px solid ${COLORS.border}`,
              overflow: 'hidden', minHeight: 0,
              padding: '8px',
            }}>
              {previewLoading ? (
                <div style={{
                  width: '28px', height: '28px',
                  border: `2px solid ${COLORS.accent}`,
                  borderTopColor: 'transparent',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
              ) : previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Crop preview"
                  style={{
                    maxWidth: '100%', maxHeight: '100%',
                    objectFit: 'contain', borderRadius: '6px',
                  }}
                />
              ) : (
                <div style={{ color: COLORS.textMuted, fontSize: '13px', textAlign: 'center' }}>
                  Draw a rectangle on the page to preview the crop
                </div>
              )}
            </div>

            {/* Region coordinates display */}
            {newRegion && (
              <div style={{
                marginTop: '8px', fontSize: '11px', color: COLORS.textMuted,
                fontFamily: 'monospace', padding: '6px 8px',
                backgroundColor: COLORS.bg, borderRadius: '6px',
                border: `1px solid ${COLORS.border}`,
              }}>
                [{newRegion.map(n => n.toFixed(2)).join(', ')}]
              </div>
            )}
          </div>
        </div>

        {/* ── Footer: Action buttons ── */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexShrink: 0, paddingTop: '4px',
        }}>
          <button
            onClick={handleReset}
            disabled={!newRegion}
            style={{
              padding: '6px 14px', fontSize: '12px', borderRadius: '6px',
              cursor: newRegion ? 'pointer' : 'default',
              backgroundColor: 'transparent',
              border: `1px solid ${COLORS.border}`,
              color: newRegion ? COLORS.textMuted : COLORS.textDimHalf,
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            Reset
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={onCancel}
              style={{
                padding: '6px 14px', fontSize: '12px', borderRadius: '6px',
                cursor: 'pointer', backgroundColor: 'transparent',
                border: `1px solid ${COLORS.border}`,
                color: COLORS.textMuted, fontFamily: 'system-ui, sans-serif',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={!newRegion}
              style={{
                padding: '6px 18px', fontSize: '12px', borderRadius: '6px',
                cursor: newRegion ? 'pointer' : 'default',
                backgroundColor: newRegion ? COLORS.accent : COLORS.accentBorder,
                border: 'none',
                color: newRegion ? COLORS.bg : COLORS.bgOverlay,
                fontWeight: 600, fontFamily: 'system-ui, sans-serif',
              }}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
