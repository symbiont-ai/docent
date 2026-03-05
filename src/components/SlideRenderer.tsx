'use client';

import React, { useCallback, useState, useEffect } from 'react';
import { COLORS } from '@/src/lib/colors';
import { decodeEntities } from '@/src/lib/presentation';
import type { Slide, Figure } from '@/src/types';

// Render inline citation markers [1], [2] as styled superscripts
const renderWithCitations = (text: string): React.ReactNode => {
  const parts = text.split(/(\[\d+\])/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    /^\[\d+\]$/.test(part)
      ? <sup key={i} style={{ color: COLORS.accent, fontSize: '10px', fontWeight: 600, marginLeft: '1px' }}>{part}</sup>
      : part
  );
};

interface SlideRendererProps {
  slide: Slide;
  slideNumber: number;
  totalSlides: number;
  onShowPromptEditor?: (mode: 'generate' | 'search') => void;
  onRevertFigure?: () => void;
  imageLoading?: boolean;
  isStreamingSlides?: boolean;
  /** Lazy crop function — resolves pdf_crop figures on demand instead of embedding base64 in slides */
  cropFn?: (page: number, region: number[] | string | undefined) => Promise<string | null>;
  /** Open the crop correction editor for pdf_crop figures */
  onShowCropEditor?: () => void;
}

// Corner bracket style helper
const cornerStyle = (pos: 'tl' | 'tr' | 'bl' | 'br'): React.CSSProperties => ({
  position: 'absolute',
  width: '40px',
  height: '40px',
  ...(pos.includes('t') ? { top: 0 } : { bottom: 0 }),
  ...(pos.includes('l') ? { left: 0 } : { right: 0 }),
  borderTop: pos.includes('t') ? `2px solid ${COLORS.accent}40` : 'none',
  borderBottom: pos.includes('b') ? `2px solid ${COLORS.accent}40` : 'none',
  borderLeft: pos.includes('l') ? `2px solid ${COLORS.accent}40` : 'none',
  borderRight: pos.includes('r') ? `2px solid ${COLORS.accent}40` : 'none',
  pointerEvents: 'none',
});

function SlideRenderer({ slide, slideNumber, totalSlides, onShowPromptEditor, onRevertFigure, imageLoading, isStreamingSlides, cropFn, onShowCropEditor }: SlideRendererProps) {
  if (!slide) return null;

  const hasContent = (slide.content?.length ?? 0) > 0;
  const hasFigure = !!slide.figure;

  // ── Lazy crop: resolve pdf_crop figures on demand ──
  const [lazyCrop, setLazyCrop] = useState<string | null>(null);
  const fig = slide.figure;
  const needsLazyCrop = fig?.type === 'pdf_crop' && !fig.croppedDataURL && !!fig.page && !!fig.region && !!cropFn;

  useEffect(() => {
    if (!needsLazyCrop || !fig?.page || !fig?.region || !cropFn) return;
    let cancelled = false;
    cropFn(fig.page, fig.region).then(result => {
      if (!cancelled && result) {
        setLazyCrop(result);
        // Debug: log crop info + render as clickable image object in console
        const regionStr = Array.isArray(fig.region) ? (fig.region as number[]).map((n: number) => n.toFixed(2)).join(',') : fig.region;
        console.log(
          `%c[Crop] Slide ${slideNumber} — p${fig.page} [${regionStr}] — ${Math.round(result.length / 1024)}KB`,
          'color: #5BB8D4; font-weight: bold',
        );
        // Use Image object — expandable in DevTools (Chrome blocks data: in CSS backgrounds)
        const img = new Image();
        img.onload = () => console.log(`  Slide ${slideNumber} crop (${img.width}×${img.height}):`, img);
        img.src = result;
      }
    });
    return () => { cancelled = true; };
  }, [needsLazyCrop, fig?.page, JSON.stringify(fig?.region), cropFn]);

  // Determine layout
  let layout = slide.layout
    || (!hasContent && hasFigure
      ? 'figure_only'
      : hasFigure && (slide.content?.length || 0) <= 3
        ? 'figure_focus'
        : hasFigure
          ? 'balanced'
          : 'text_only');

  // Safety: never use figure_only if slide actually has content bullets
  if (layout === 'figure_only' && hasContent) layout = 'figure_focus';

  const isVertical = layout === 'figure_only' || layout === 'text_only';
  const textFlex = layout === 'figure_focus' ? '0 0 35%' : '1';
  const figureFlex = layout === 'figure_focus' ? '1 1 60%' : '1';

  // SVG ref callback to auto-size SVGs.
  // Removes intrinsic width/height attributes (after capturing them into viewBox)
  // so they can't feed back into flex sizing on re-render and enlarge the container.
  const svgRefCallback = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      const svg = el.querySelector('svg');
      if (svg) {
        // Capture intrinsic dimensions into viewBox before removing them
        if (!svg.getAttribute('viewBox') && svg.getAttribute('width') && svg.getAttribute('height')) {
          svg.setAttribute('viewBox', `0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`);
        }
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.maxWidth = '100%';
        svg.style.maxHeight = '100%';
        svg.style.overflow = 'hidden';
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      }
    }
  }, [slide.figure]);

  // --- Image upgrade overlay buttons (shared by title + regular slides) ---
  const renderImageOverlay = () => {
    if (isStreamingSlides) return null;
    if (imageLoading) return null;
    if (!onShowPromptEditor) return null;

    return (
      <div style={{
        position: 'absolute', bottom: 8, right: 8,
        display: 'flex', gap: 4, zIndex: 2,
      }}>
        {/* Revert to original figure (only shown if backup exists) */}
        {slide.originalFigure && onRevertFigure && (
          <button
            onClick={onRevertFigure}
            title="Revert to original figure"
            style={{
              padding: '3px 8px', fontSize: '11px', borderRadius: '4px',
              cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
              backgroundColor: `${COLORS.surface}E0`, border: `1px solid ${COLORS.red}60`,
              color: COLORS.red, whiteSpace: 'nowrap',
              backdropFilter: 'blur(4px)',
            }}
          >
            {'\u21A9'} Revert
          </button>
        )}
        {/* Crop editor — adjust bounding box for pdf_crop figures */}
        {slide.figure?.type === 'pdf_crop' && onShowCropEditor && (
          <button
            onClick={onShowCropEditor}
            title="Adjust crop region"
            style={{
              padding: '3px 8px', fontSize: '11px', borderRadius: '4px',
              cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
              backgroundColor: `${COLORS.surface}E0`, border: `1px solid ${COLORS.accent}60`,
              color: COLORS.accent, whiteSpace: 'nowrap',
              backdropFilter: 'blur(4px)',
            }}
          >
            {'\u2702\uFE0F'} Crop
          </button>
        )}
        {/* Prompt editor — view/edit prompt, then generate or search */}
        <button
          onClick={() => onShowPromptEditor('generate')}
          title="View / edit image prompt"
          style={{
            padding: '3px 8px', fontSize: '11px', borderRadius: '4px',
            cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
            backgroundColor: `${COLORS.surface}E0`, border: `1px solid ${COLORS.accent}60`,
            color: COLORS.accent, whiteSpace: 'nowrap',
            backdropFilter: 'blur(4px)',
          }}
        >
          {'\uD83D\uDCDD'} Prompt
        </button>
      </div>
    );
  };

  // --- Image loading spinner overlay ---
  const renderImageLoadingOverlay = () => {
    if (!imageLoading) return null;
    return (
      <div style={{
        position: 'absolute', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: `${COLORS.bg}80`, zIndex: 3,
        backdropFilter: 'blur(2px)', borderRadius: '8px',
      }}>
        <div style={{
          width: '24px', height: '24px',
          border: `2px solid ${COLORS.accent}`,
          borderTopColor: 'transparent',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
        }} />
      </div>
    );
  };

  // --- Caption rendering ---
  const renderCaption = () => {
    if (!slide.figure?.caption) return null;
    return (
      <div style={{
        fontSize: '9px', color: COLORS.textMuted,
        textAlign: 'center', marginTop: 4,
        fontStyle: 'italic', lineHeight: '1.3',
        maxWidth: '100%', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {slide.figure.caption}
      </div>
    );
  };

  // ── TITLE SLIDE (slide 1) — premium centered layout ───────────────
  if (slideNumber === 1) {
    const hasDecorativeSvg = hasFigure && slide.figure?.type === 'svg';
    const hasAiBackground = hasFigure && slide.figure?.type === 'image' && slide.figure?.src;
    const hasPdfFigure = hasFigure && slide.figure?.type === 'pdf_crop';

    // PDF title page: render with figure_focus but enhanced title
    if (hasPdfFigure) {
      return (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          gap: '12px', minHeight: 0, overflow: 'hidden', position: 'relative',
        }}>
          {/* Enhanced title bar — larger, centered */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            paddingBottom: '8px', flexShrink: 0,
          }}>
            <h1 style={{
              margin: 0, fontSize: '32px', fontWeight: 700,
              color: COLORS.text, textAlign: 'center',
            }}>
              {decodeEntities(slide.title)}
            </h1>
            <div style={{
              width: '120px', height: '3px', marginTop: '10px',
              background: `linear-gradient(90deg, transparent, ${COLORS.accent}, transparent)`,
              borderRadius: '2px',
            }} />
          </div>
          {/* Body: text left, PDF crop right */}
          <div style={{
            flex: 1, display: 'flex', gap: '24px',
            flexDirection: 'row', minHeight: 0, overflow: 'hidden',
          }}>
            {hasContent && (
              <div style={{
                flex: '0 0 35%', display: 'flex', flexDirection: 'column',
                gap: '10px', justifyContent: 'center',
              }}>
                {slide.content!.map((item, i) => {
                  const decoded = decodeEntities(item);
                  const isByline = decoded.toLowerCase().includes('presented by');
                  const isDate = /^\d{4}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(decoded);
                  return (
                    <p key={i} style={{
                      margin: 0, textAlign: 'center',
                      fontSize: isByline ? '14px' : isDate ? '13px' : '16px',
                      color: isByline ? COLORS.accent : isDate ? COLORS.textMuted : COLORS.text,
                      fontWeight: isByline ? 600 : 400,
                      fontStyle: isDate ? 'italic' : 'normal',
                    }}>
                      {decoded}
                    </p>
                  );
                })}
              </div>
            )}
            {(slide.figure?.croppedDataURL || lazyCrop) && (
              <div style={{
                flex: '1 1 60%', display: 'flex', alignItems: 'center',
                justifyContent: 'center', minHeight: 0, overflow: 'hidden',
              }}>
                <img
                  src={slide.figure?.croppedDataURL || lazyCrop || ''}
                  alt={slide.figure?.label || ''}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }}
                />
              </div>
            )}
          </div>
          {/* Overlay buttons for PDF title */}
          {renderImageOverlay()}
          {renderImageLoadingOverlay()}
        </div>
      );
    }

    // Enhanced title slide — centered with decorative elements
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        minHeight: 0, overflow: 'hidden', position: 'relative',
      }}>
        {/* Radial gradient background overlay */}
        <div style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse at center, ${COLORS.accent}0A 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />

        {/* Background: AI-generated image (covers full slide) */}
        {hasAiBackground && (
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `url(${slide.figure!.src})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            opacity: 0.75, pointerEvents: 'none',
          }} />
        )}

        {/* Subtle gradient overlay for text readability */}
        {hasAiBackground && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.4) 100%)',
            pointerEvents: 'none',
          }} />
        )}

        {/* Decorative SVG watermark (if present and no AI image) */}
        {hasDecorativeSvg && !hasAiBackground && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: 0.12, pointerEvents: 'none',
          }}>
            <div
              ref={svgRefCallback}
              dangerouslySetInnerHTML={{ __html: slide.figure!.content || '' }}
              style={{ width: '85%', height: '85%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
            />
          </div>
        )}

        {/* Corner brackets */}
        <div style={cornerStyle('tl')} />
        <div style={cornerStyle('tr')} />
        <div style={cornerStyle('bl')} />
        <div style={cornerStyle('br')} />

        {/* Centered content */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: '16px', zIndex: 1, textAlign: 'center',
          padding: '40px',
        }}>
          {/* Title */}
          <h1 style={{
            margin: 0, fontSize: '36px', fontWeight: 700,
            color: COLORS.text, letterSpacing: '0.5px', lineHeight: 1.3,
          }}>
            {decodeEntities(slide.title)}
          </h1>

          {/* Decorative gold gradient line */}
          <div style={{
            width: '120px', height: '3px',
            background: `linear-gradient(90deg, transparent, ${COLORS.accent}, transparent)`,
            borderRadius: '2px',
          }} />

          {/* Content items as centered lines (no chevrons) */}
          {hasContent && slide.content!.map((item, i) => {
            const decoded = decodeEntities(item);
            const isByline = decoded.toLowerCase().includes('presented by');
            const isDate = /^\d{4}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(decoded);
            return (
              <p key={i} style={{
                margin: 0,
                fontSize: isByline ? '15px' : isDate ? '14px' : '18px',
                color: isByline ? COLORS.accent : isDate ? COLORS.textMuted : COLORS.text,
                fontWeight: isByline ? 600 : 400,
                fontStyle: isDate ? 'italic' : 'normal',
                letterSpacing: isByline ? '1px' : '0',
              }}>
                {decoded}
              </p>
            );
          })}
        </div>

        {/* Caption for AI-generated background */}
        {hasAiBackground && slide.figure?.caption && (
          <div style={{
            position: 'absolute', bottom: 28, left: 0, right: 0,
            textAlign: 'center', zIndex: 1,
          }}>
            <span style={{
              fontSize: '9px', color: COLORS.textMuted, fontStyle: 'italic',
              backgroundColor: `${COLORS.bg}80`, padding: '2px 8px', borderRadius: '4px',
            }}>
              {slide.figure.caption}
            </span>
          </div>
        )}

        {/* Overlay buttons */}
        {renderImageOverlay()}
        {renderImageLoadingOverlay()}
      </div>
    );
  }

  // ── REGULAR SLIDES (2+) — standard layout ─────────────────────────

  // --- Figure rendering ---
  const renderFigure = () => {
    if (!hasFigure || !slide.figure) return null;
    const fig: Figure = slide.figure;

    // Wrap figure content in a positioned container with overlay buttons + caption
    const wrapWithOverlay = (content: React.ReactNode) => (
      <div style={{
        flex: figureFlex, display: 'flex', flexDirection: 'column',
        minHeight: 0, minWidth: 0, overflow: 'hidden',
      }}>
        <div style={{
          flex: 1, position: 'relative',
          minHeight: 0, minWidth: 0, overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden',
          }}>
            {content}
          </div>
          {renderImageOverlay()}
          {renderImageLoadingOverlay()}
        </div>
        {renderCaption()}
      </div>
    );

    if (fig.type === 'card') {
      return wrapWithOverlay(
        <div style={{
          width: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: COLORS.surface, border: `1px solid ${COLORS.border}`,
          borderRadius: '12px', padding: '24px', minHeight: 0,
        }}>
          <div style={{ color: COLORS.accent, fontWeight: 600, fontSize: '18px', marginBottom: '8px' }}>
            {fig.label}
          </div>
          <div style={{ color: COLORS.textMuted, fontSize: '14px', textAlign: 'center', lineHeight: '1.5' }}>
            {fig.description}
          </div>
        </div>
      );
    }

    if (fig.type === 'pdf_crop') {
      const cropSrc = fig.croppedDataURL || lazyCrop;
      if (cropSrc) {
        return wrapWithOverlay(
          <img
            src={cropSrc}
            alt={fig.label || ''}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }}
          />
        );
      }
      // Crop pending or failed -- show placeholder
      return wrapWithOverlay(
        <div style={{
          padding: '20px', borderRadius: '12px',
          border: `2px dashed ${COLORS.border}`, textAlign: 'center',
        }}>
          <div style={{ fontSize: '32px', marginBottom: '8px', opacity: 0.5 }}>{'\uD83D\uDCC4'}</div>
          <div style={{ color: COLORS.textMuted, fontSize: '13px' }}>
            Figure from page {fig.page || '?'}
          </div>
          {fig.label && (
            <div style={{ color: COLORS.textDim, fontSize: '12px', marginTop: '4px' }}>
              {fig.label}
            </div>
          )}
        </div>
      );
    }

    if (fig.type === 'svg') {
      return (
        <div style={{
          flex: figureFlex, position: 'relative',
          minHeight: 0, minWidth: 0, maxHeight: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}>
          <div
            style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden',
            }}
            ref={svgRefCallback}
            dangerouslySetInnerHTML={{ __html: fig.content || '' }}
          />
          {renderImageOverlay()}
          {renderImageLoadingOverlay()}
        </div>
      );
    }

    if (fig.type === 'image' && fig.src) {
      return wrapWithOverlay(
        <img
          src={fig.src}
          alt={fig.label || ''}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }}
        />
      );
    }

    return null;
  };

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      gap: '12px', minHeight: 0, minWidth: 0, overflow: 'hidden',
    }}>
      {/* Title bar with slide number */}
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: '12px',
        borderBottom: `2px solid ${COLORS.accent}`, paddingBottom: '8px', flexShrink: 0,
      }}>
        {slideNumber != null && (
          <span style={{
            fontSize: '12px', color: COLORS.accent, fontWeight: 600,
            opacity: 0.7, whiteSpace: 'nowrap', fontFamily: 'system-ui, sans-serif',
          }}>
            {slideNumber}/{totalSlides}
          </span>
        )}
        <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: COLORS.text, flex: 1 }}>
          {decodeEntities(slide.title)}
        </h2>
      </div>

      {/* Body: text + figure */}
      <div style={{
        flex: 1, display: 'flex',
        gap: isVertical ? '12px' : '24px',
        flexDirection: isVertical ? 'column' : 'row',
        minHeight: 0, minWidth: 0, overflow: 'hidden',
      }}>
        {/* Bullets */}
        {hasContent && (
          <div style={{
            flex: isVertical && hasFigure ? '0 0 auto' : textFlex,
            display: 'flex', flexDirection: 'column', gap: '8px',
            overflow: 'auto', minHeight: 0,
            maxHeight: isVertical && hasFigure ? '40%' : undefined,
          }}>
            {slide.content!.map((item, i) => (
              <div key={i} style={{
                display: 'flex', gap: '10px', alignItems: 'flex-start',
                fontSize: '15px', color: COLORS.text, lineHeight: '1.6',
              }}>
                <span style={{ color: COLORS.accent, fontWeight: 700, flexShrink: 0 }}>{'\u203A'}</span>
                <span>{renderWithCitations(decodeEntities(item))}</span>
              </div>
            ))}
          </div>
        )}
        {renderFigure()}
      </div>

      {/* Per-slide footnote references */}
      {slide.references && slide.references.length > 0 && (
        <div style={{
          flexShrink: 0,
          borderTop: `1px solid ${COLORS.border}`,
          padding: '6px 32px 4px',
          maxHeight: '70px',
          overflow: 'hidden',
        }}>
          {slide.references.map((ref, i) => (
            <div key={i} style={{
              fontSize: '10px',
              color: COLORS.textMuted,
              lineHeight: '1.4',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              <span style={{
                color: COLORS.accent,
                fontWeight: 600,
                fontSize: '9px',
                marginRight: '4px',
              }}>
                [{i + 1}]
              </span>
              {ref}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default React.memo(SlideRenderer);
