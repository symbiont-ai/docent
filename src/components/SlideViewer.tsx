'use client';

import React, { useState } from 'react';
import { COLORS } from '@/src/lib/colors';
import SlideRenderer from './SlideRenderer';
import type { PresentationState, AuditResult } from '@/src/types';

interface SlideViewerProps {
  presentationState: PresentationState;
  isLoading: boolean;
  loadingMsg: string;
  isSpeaking: boolean;
  onExportPPTX: () => void;
  onExportHTML: () => void;
  onClear: () => void;
  onNavigate: (action: 'first' | 'prev' | 'next' | 'last') => void;
  onNarrate: () => void;
  onStopNarration: () => void;
  onToggleAutoAdvance: () => void;
  onToggleNotes: () => void;
  onAskAboutSlides: () => void;
  onAssessMe?: () => void;
  onShowPromptEditor?: (mode: 'generate' | 'search') => void;
  onRevertFigure?: () => void;
  onUpdateSpeakerNotes?: (notes: string) => void;
  onRevertSpeakerNotes?: () => void;
  onShowCropEditor?: () => void;
  imageLoading?: boolean;
  isLoadingAudio?: boolean;
  isStreamingSlides?: boolean;
  /** Lazy crop function passed to SlideRenderer for on-demand PDF figure cropping */
  cropFn?: (page: number, region: number[] | string | undefined) => Promise<string | null>;
  /** Slide audit (PDF workflows only) */
  onAudit?: () => void;
  auditResult?: AuditResult | null;
  isAuditing?: boolean;
  /** Deep analysis — full-deck hallucination audit (PDF workflows only) */
  onDeepAnalysis?: () => void;
  isDeepAnalyzing?: boolean;
  hasPdf?: boolean;
}

export default function SlideViewer({
  presentationState,
  isLoading,
  loadingMsg,
  isSpeaking,
  onExportPPTX,
  onExportHTML,
  onClear,
  onNavigate,
  onNarrate,
  onStopNarration,
  onToggleAutoAdvance,
  onToggleNotes,
  onAskAboutSlides,
  onAssessMe,
  onShowPromptEditor,
  onRevertFigure,
  onUpdateSpeakerNotes,
  onRevertSpeakerNotes,
  onShowCropEditor,
  imageLoading,
  isLoadingAudio,
  isStreamingSlides,
  cropFn,
  onAudit,
  auditResult,
  isAuditing,
  onDeepAnalysis,
  isDeepAnalyzing,
  hasPdf,
}: SlideViewerProps) {
  const [auditCollapsed, setAuditCollapsed] = useState(false);
  const { slides, currentSlide, title, isPresenting, autoAdvance, speakerNotesVisible } = presentationState;
  const currentSlideData = slides[currentSlide];
  const isFirst = currentSlide === 0;
  const isLast = currentSlide >= slides.length - 1;

  // Disabled styling helper for streaming mode
  const streamingDisabled = isStreamingSlides
    ? { opacity: 0.4, pointerEvents: 'none' as const, cursor: 'not-allowed' as const }
    : {};

  // --- Empty state ---
  if (slides.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '16px',
        color: COLORS.textDim,
      }}>
        {isLoading ? (
          <>
            <span style={{ fontSize: '56px', opacity: 0.5 }}>{'\uD83C\uDF3F'}</span>
            <p style={{ margin: 0, fontSize: '16px', color: COLORS.text }}>
              {loadingMsg || 'Preparing presentation...'}
            </p>
          </>
        ) : (
          <>
            <span style={{ fontSize: '56px', opacity: 0.5 }}>{'\uD83C\uDFAC'}</span>
            <p style={{ margin: 0, fontSize: '16px', color: COLORS.textMuted }}>
              No presentation loaded
            </p>
            <p style={{
              margin: 0, fontSize: '13px', color: COLORS.textDim,
              fontFamily: 'system-ui, sans-serif',
            }}>
              Ask Sage to prepare a presentation in the Chat tab
            </p>
          </>
        )}
      </div>
    );
  }

  // --- Slide controls + content ---
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
      {/* Controls bar */}
      <div style={{
        padding: '8px 16px', borderBottom: `1px solid ${COLORS.border}`,
        display: 'flex', gap: '8px', alignItems: 'center',
        backgroundColor: COLORS.surface, overflow: 'hidden',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '13px', color: COLORS.text, fontWeight: 600, flex: 1 }}>
          {title}
          {isStreamingSlides && (
            <span style={{
              marginLeft: '8px', fontSize: '11px', color: COLORS.accent,
              fontWeight: 400, fontStyle: 'italic',
            }}>
              {'\u23F3'} Generating...
            </span>
          )}
        </span>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          {/* Auto advance */}
          <button
            onClick={onToggleAutoAdvance}
            disabled={!!isStreamingSlides}
            style={{
              padding: '3px 10px', fontSize: '12px', borderRadius: '4px',
              cursor: isStreamingSlides ? 'not-allowed' : 'pointer', fontFamily: 'system-ui, sans-serif',
              backgroundColor: autoAdvance ? COLORS.accentBg : 'transparent',
              border: `1px solid ${COLORS.border}`,
              color: autoAdvance ? COLORS.accent : COLORS.textMuted,
              ...streamingDisabled,
            }}
          >
            {autoAdvance ? '\u23E9 Auto' : '\u23F8 Manual'}
          </button>

          {/* Notes toggle — keep enabled during streaming (view-only) */}
          <button
            onClick={onToggleNotes}
            style={{
              padding: '3px 10px', fontSize: '12px', borderRadius: '4px',
              cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
              backgroundColor: speakerNotesVisible ? COLORS.accentBg : 'transparent',
              border: `1px solid ${COLORS.border}`,
              color: speakerNotesVisible ? COLORS.accent : COLORS.textMuted,
              minWidth: '70px', textAlign: 'center',
            }}
          >
            {'\uD83D\uDCDD'} Notes
          </button>

          {/* PPTX export */}
          <button
            onClick={onExportPPTX}
            disabled={!!isStreamingSlides}
            style={{
              padding: '3px 10px', fontSize: '12px', borderRadius: '4px',
              cursor: isStreamingSlides ? 'not-allowed' : 'pointer', fontFamily: 'system-ui, sans-serif',
              backgroundColor: 'transparent',
              border: `1px solid ${COLORS.accent}`, color: COLORS.accent,
              ...streamingDisabled,
            }}
            title="Download as PowerPoint file"
          >
            {'\uD83D\uDCE5'} PPTX
          </button>

          {/* HTML export */}
          <button
            onClick={onExportHTML}
            disabled={!!isStreamingSlides}
            style={{
              padding: '3px 10px', fontSize: '12px', borderRadius: '4px',
              cursor: isStreamingSlides ? 'not-allowed' : 'pointer', fontFamily: 'system-ui, sans-serif',
              backgroundColor: 'transparent',
              border: `1px solid ${COLORS.border}`, color: COLORS.textMuted,
              ...streamingDisabled,
            }}
            title="Export as HTML for printing to PDF"
          >
            {'\uD83D\uDCC4'} HTML
          </button>

          {/* Clear */}
          <button
            onClick={onClear}
            disabled={!!isStreamingSlides}
            style={{
              padding: '3px 10px', fontSize: '12px', borderRadius: '4px',
              cursor: isStreamingSlides ? 'not-allowed' : 'pointer', fontFamily: 'system-ui, sans-serif',
              backgroundColor: 'transparent',
              border: `1px solid ${COLORS.red}`, color: COLORS.red,
              ...streamingDisabled,
            }}
          >
            {'\u2715'} Clear
          </button>
        </div>
      </div>

      {/* Slide content */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', padding: '20px 32px', minHeight: 0, minWidth: 0,
      }}>
        {currentSlideData && (
          <SlideRenderer
            key={currentSlide}
            slide={currentSlideData}
            slideNumber={currentSlide + 1}
            totalSlides={slides.length}
            onShowPromptEditor={isStreamingSlides ? undefined : onShowPromptEditor}
            onRevertFigure={isStreamingSlides ? undefined : onRevertFigure}
            onShowCropEditor={isStreamingSlides ? undefined : onShowCropEditor}
            imageLoading={imageLoading}
            isStreamingSlides={isStreamingSlides}
            cropFn={cropFn}
          />
        )}
      </div>

      {/* Speaker notes (read-only during streaming) */}
      {speakerNotesVisible && currentSlideData?.speakerNotes && (
        <div style={{
          padding: '10px 32px', borderTop: `1px solid ${COLORS.border}`,
          backgroundColor: COLORS.surface, maxHeight: '120px', overflow: 'auto', flexShrink: 0,
        }}>
          <textarea
            value={currentSlideData.speakerNotes}
            onChange={(e) => onUpdateSpeakerNotes?.(e.target.value)}
            readOnly={!!isStreamingSlides}
            style={{
              width: '100%', border: 'none', outline: 'none', resize: 'none',
              background: 'transparent', fontSize: '13px', color: COLORS.textMuted,
              fontStyle: 'italic', lineHeight: '1.5', fontFamily: 'system-ui, sans-serif',
              minHeight: '40px',
              ...(isStreamingSlides ? { cursor: 'default' } : {}),
            }}
            rows={3}
          />
          {!isStreamingSlides &&
           currentSlideData.originalSpeakerNotes &&
           currentSlideData.originalSpeakerNotes !== currentSlideData.speakerNotes &&
           onRevertSpeakerNotes && (
            <button
              onClick={onRevertSpeakerNotes}
              style={{
                padding: '2px 8px', fontSize: '11px', borderRadius: '4px',
                cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                backgroundColor: 'transparent', border: `1px solid ${COLORS.redMedium}`,
                color: COLORS.red, marginTop: '4px',
              }}
            >
              {'\u21A9'} Revert notes
            </button>
          )}
        </div>
      )}

      {/* Navigation bar — flexShrink:0 prevents flex redistribution from affecting slide content area */}
      <div style={{
        padding: '10px 16px', borderTop: `1px solid ${COLORS.border}`,
        display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'center',
        backgroundColor: COLORS.surface, flexShrink: 0,
      }}>
        {/* First */}
        <button
          onClick={() => onNavigate('first')}
          disabled={isFirst}
          title="First slide"
          style={{
            padding: '6px 10px', fontSize: '13px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '6px',
            color: isFirst ? COLORS.textDim : COLORS.textMuted,
            cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
          }}
        >
          {'\u23EE'}
        </button>

        {/* Prev */}
        <button
          onClick={() => onNavigate('prev')}
          disabled={isFirst}
          style={{
            padding: '6px 14px', fontSize: '13px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '6px',
            color: isFirst ? COLORS.textDim : COLORS.textMuted,
            cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
          }}
        >
          {'\u2190'} Prev
        </button>

        {/* Counter — show "3 / ..." during streaming */}
        <span style={{
          fontSize: '13px', color: COLORS.textMuted, minWidth: '80px',
          textAlign: 'center', fontFamily: 'system-ui, sans-serif',
        }}>
          {currentSlide + 1} / {isStreamingSlides ? `${slides.length}...` : slides.length}
        </span>

        {/* Next */}
        <button
          onClick={() => onNavigate('next')}
          disabled={isLast}
          style={{
            padding: '6px 14px', fontSize: '13px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '6px',
            color: isLast ? COLORS.textDim : COLORS.textMuted,
            cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
          }}
        >
          Next {'\u2192'}
        </button>

        {/* Last */}
        <button
          onClick={() => onNavigate('last')}
          disabled={isLast}
          title="Last slide"
          style={{
            padding: '6px 10px', fontSize: '13px', backgroundColor: 'transparent',
            border: `1px solid ${COLORS.border}`, borderRadius: '6px',
            color: isLast ? COLORS.textDim : COLORS.textMuted,
            cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
          }}
        >
          {'\u23ED'}
        </button>

        {/* Divider */}
        <div style={{ width: '1px', height: '20px', backgroundColor: COLORS.border, margin: '0 8px' }} />

        {/* Narrate / Stop — fixed minWidth prevents controls bar reflow that causes SVG twitching */}
        <button
          onClick={() => {
            if (isStreamingSlides) return;
            if (isSpeaking) onStopNarration();
            else onNarrate();
          }}
          disabled={!!isStreamingSlides}
          style={{
            padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
            cursor: isStreamingSlides ? 'not-allowed' : 'pointer',
            border: 'none', fontFamily: 'system-ui, sans-serif',
            backgroundColor: isSpeaking ? COLORS.red : COLORS.accent,
            color: isSpeaking ? 'white' : COLORS.bg,
            fontWeight: 600,
            minWidth: '115px', textAlign: 'center',
            ...(isStreamingSlides ? { opacity: 0.4 } : {}),
          }}
        >
          {isSpeaking && isLoadingAudio ? '\u23F3 Loading...' : isSpeaking ? '\u23F9 Stop' : '\u25B6 Narrate'}
        </button>

        {/* Ask button */}
        <button
          onClick={onAskAboutSlides}
          disabled={!!isStreamingSlides}
          style={{
            padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
            cursor: isStreamingSlides ? 'not-allowed' : 'pointer',
            fontFamily: 'system-ui, sans-serif',
            backgroundColor: 'transparent',
            border: `1px solid ${COLORS.cyan}`, color: COLORS.cyan,
            ...(isStreamingSlides ? { opacity: 0.4 } : {}),
          }}
          title="Ask Sage questions about this presentation"
        >
          {'\uD83D\uDCAC'} Ask
        </button>

        {/* Assess Me button */}
        {onAssessMe && (
          <button
            onClick={onAssessMe}
            disabled={!!isStreamingSlides}
            style={{
              padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
              cursor: isStreamingSlides ? 'not-allowed' : 'pointer',
              fontFamily: 'system-ui, sans-serif',
              backgroundColor: 'transparent',
              border: `1px solid ${COLORS.accent}`, color: COLORS.accent,
              ...(isStreamingSlides ? { opacity: 0.4 } : {}),
            }}
            title="Start a Socratic assessment on this presentation"
          >
            {'\uD83C\uDF93'} Assess Me
          </button>
        )}

        {/* Audit button — PDF-to-slide workflows only */}
        {hasPdf && onAudit && (
          <button
            onClick={onAudit}
            disabled={!!isAuditing || !!isStreamingSlides}
            style={{
              padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
              cursor: (isAuditing || isStreamingSlides) ? 'not-allowed' : 'pointer',
              fontFamily: 'system-ui, sans-serif',
              backgroundColor: 'transparent',
              border: `1px solid ${COLORS.accentLight}`,
              color: COLORS.accentLight,
              ...((isAuditing || isStreamingSlides) ? { opacity: 0.4 } : {}),
            }}
            title="Audit this slide for consistency issues"
          >
            {isAuditing ? '\u23F3 Auditing...' : '\uD83D\uDD0D Audit'}
          </button>
        )}
        {/* Deep Analysis button — full-deck hallucination audit, PDF-only */}
        {hasPdf && onDeepAnalysis && (
          <button
            onClick={onDeepAnalysis}
            disabled={!!isDeepAnalyzing || !!isAuditing || !!isStreamingSlides}
            style={{
              padding: '6px 14px', fontSize: '13px', borderRadius: '6px',
              cursor: (isDeepAnalyzing || isAuditing || isStreamingSlides) ? 'not-allowed' : 'pointer',
              fontFamily: 'system-ui, sans-serif',
              backgroundColor: 'transparent',
              border: `1px solid ${COLORS.cyan}`,
              color: COLORS.cyan,
              ...((isDeepAnalyzing || isAuditing || isStreamingSlides) ? { opacity: 0.4 } : {}),
            }}
            title="Run a deep hallucination audit on the entire deck against the source paper"
          >
            {isDeepAnalyzing ? '\u23F3 Analyzing...' : '\uD83D\uDD2C Deep Analysis'}
          </button>
        )}
        {/* Audit collapse/expand chevron — shown when results exist */}
        {auditResult && (
          <button
            onClick={() => setAuditCollapsed(c => !c)}
            style={{
              padding: '4px 6px', fontSize: '11px', borderRadius: '4px',
              cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
              backgroundColor: 'transparent', border: `1px solid ${COLORS.border}`,
              color: COLORS.textMuted, lineHeight: 1, transition: 'color 0.15s',
            }}
            title={auditCollapsed ? 'Show audit results' : 'Hide audit results'}
          >
            <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: auditCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>{'\u25BC'}</span>
          </button>
        )}
      </div>

      {/* Audit results panel — hidden when collapsed */}
      {auditResult && !auditCollapsed && (
        <div style={{
          padding: '8px 16px', borderTop: `1px solid ${COLORS.border}`,
          backgroundColor: COLORS.surface, flexShrink: 0,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: COLORS.text, fontFamily: 'system-ui, sans-serif' }}>
              Audit:
            </span>
            {auditResult.checks.map((check) => {
              const isSkipped = check.detail.startsWith('Skipped:');
              return (
                <span
                  key={check.id}
                  title={check.detail}
                  style={{
                    fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
                    fontFamily: 'system-ui, sans-serif', cursor: 'help',
                    backgroundColor: isSkipped ? COLORS.textDimBg : check.pass ? COLORS.greenBg : COLORS.redBg,
                    color: isSkipped ? COLORS.textDim : check.pass ? COLORS.green : COLORS.red,
                    border: `1px solid ${isSkipped ? COLORS.textDimBorder : check.pass ? COLORS.greenBorder : COLORS.redBorder}`,
                  }}
                >
                  {isSkipped ? '\u2796' : check.pass ? '\u2705' : '\u274C'} {check.name}
                </span>
              );
            })}
          </div>
          {/* Expanded details for failing checks */}
          {auditResult.checks.some(c => !c.pass) && (
            <div style={{ marginTop: '6px', fontSize: '12px', color: COLORS.textMuted, fontFamily: 'system-ui, sans-serif', lineHeight: '1.5' }}>
              {auditResult.checks.filter(c => !c.pass).map(c => (
                <div key={c.id} style={{ marginBottom: '2px' }}>
                  <span style={{ color: COLORS.red }}>{'\u274C'} {c.name}:</span> {c.detail}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
