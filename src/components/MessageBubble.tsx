'use client';

import React, { useCallback } from 'react';
import { COLORS } from '@/src/lib/colors';
import { renderMarkdown } from '@/src/lib/markdown';
import { markdownToHtml } from '@/src/lib/markdown-export';
import type { Message } from '@/src/types';

interface MessageBubbleProps {
  message: Message;
  onSpeak: (text: string, lang?: string) => void;
  isSpeaking: boolean;
}

export default function MessageBubble({ message, onSpeak, isSpeaking }: MessageBubbleProps) {
  const { sender, text, isThinking, attachments } = message;

  // Detect deep analysis report — check for the heading anywhere in the first 200 chars
  // (handles leading whitespace, partial reports, old format with summary-first, etc.)
  const isDeepAnalysisReport = sender === 'sage' && !isThinking
    && text.length > 100 && text.slice(0, 200).includes('Deep Analysis');

  const handleExportPdf = useCallback(() => {
    const htmlDoc = markdownToHtml(text, 'Deep Analysis — Quality Audit Report');
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(htmlDoc);
    printWindow.document.close();
    // Give the browser a moment to render, then trigger print
    setTimeout(() => printWindow.print(), 400);
  }, [text]);

  // --- Thinking message (supports both loading animation and live streamed text) ---
  if (isThinking) {
    // Check if we have real streamed content (not just a loading message)
    const hasStreamedContent = text && text.length > 0
      && !text.startsWith('Sage is ')
      && !text.startsWith('Generating ')
      && text !== 'Thinking...';

    return (
      <div style={{ display: 'flex', gap: '12px' }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px',
          backgroundColor: COLORS.accentBg, border: `1px solid ${COLORS.accentBorder}`,
        }}>
          {'\uD83C\uDF3F'}
        </div>
        <div style={{
          maxWidth: '75%', padding: '12px 16px', borderRadius: '12px', backgroundColor: COLORS.surface,
          border: `1px solid ${COLORS.border}`, fontSize: '14px', fontFamily: 'system-ui, sans-serif',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{
              fontSize: '11px', color: COLORS.accent, fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.5px',
            }}>Sage</span>
          </div>
          {hasStreamedContent ? (
            <div style={{ color: COLORS.text, lineHeight: '1.6' }}>
              {renderMarkdown(text)}
            </div>
          ) : (
            <div style={{ color: COLORS.text, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ animation: 'pulse 1.2s ease-in-out infinite' }}>{text || 'Thinking...'}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Avatar ---
  const avatarBg = sender === 'sage'
    ? COLORS.accentBg
    : sender === 'system'
      ? COLORS.cyanBg
      : COLORS.border;

  const avatarBorder = sender === 'sage'
    ? COLORS.accentBorder
    : sender === 'system'
      ? COLORS.cyanBorder
      : COLORS.border;

  const avatarEmoji = sender === 'sage'
    ? '\uD83C\uDF3F'
    : sender === 'system'
      ? '\uD83D\uDCCB'
      : '\uD83D\uDC64';

  // --- Bubble ---
  const bubbleBg = sender === 'user'
    ? COLORS.userBubbleBg
    : sender === 'system'
      ? COLORS.cyanBg
      : COLORS.surface;

  const bubbleBorder = sender === 'user'
    ? COLORS.userBubbleBorder
    : sender === 'system'
      ? COLORS.cyanBg
      : COLORS.border;

  const textColor = sender === 'system' ? COLORS.cyan : COLORS.text;

  return (
    <div style={{
      display: 'flex', gap: '12px',
      flexDirection: sender === 'user' ? 'row-reverse' : 'row',
    }}>
      {/* Avatar */}
      <div style={{
        width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px',
        backgroundColor: avatarBg,
        border: `1px solid ${avatarBorder}`,
      }}>
        {avatarEmoji}
      </div>

      {/* Message bubble */}
      <div style={{
        maxWidth: '75%', padding: '12px 16px', borderRadius: '12px',
        backgroundColor: bubbleBg,
        border: `1px solid ${bubbleBorder}`,
        fontSize: '14px', lineHeight: '1.6', fontFamily: 'system-ui, sans-serif',
      }}>
        {/* Sage label + speak button + export */}
        {sender === 'sage' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{
              fontSize: '11px', color: COLORS.accent, fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.5px',
            }}>Sage</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSpeak(text, message.language);
              }}
              style={{
                padding: '1px 6px', fontSize: '11px', borderRadius: '4px',
                border: `1px solid ${COLORS.border}`, backgroundColor: 'transparent',
                color: isSpeaking ? COLORS.accent : COLORS.textDim, cursor: 'pointer',
                fontFamily: 'system-ui, sans-serif', display: 'inline-flex',
                alignItems: 'center', gap: '3px', lineHeight: '1.4',
              }}
              title={isSpeaking ? 'Stop speaking' : 'Read aloud'}
            >
              {isSpeaking ? '\u23F9' : '\uD83D\uDD0A'}
            </button>
            {isDeepAnalysisReport && (
              <button
                onClick={(e) => { e.stopPropagation(); handleExportPdf(); }}
                style={{
                  padding: '1px 6px', fontSize: '11px', borderRadius: '4px',
                  border: `1px solid ${COLORS.accentBorder}`, backgroundColor: COLORS.accentBg,
                  color: COLORS.accent, cursor: 'pointer',
                  fontFamily: 'system-ui, sans-serif', display: 'inline-flex',
                  alignItems: 'center', gap: '3px', lineHeight: '1.4',
                }}
                title="Export report as PDF"
              >
                {'\uD83D\uDCC4'} Export PDF
              </button>
            )}
          </div>
        )}

        {/* Text content */}
        <div style={{ color: textColor }}>
          {renderMarkdown(text)}
        </div>

        {/* Attachments */}
        {attachments && attachments.length > 0 && (
          <div style={{ marginTop: '6px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {attachments.map((f, i) => (
              <span key={i} style={{
                fontSize: '11px', padding: '2px 6px',
                backgroundColor: COLORS.accentBg, border: `1px solid ${COLORS.accentBorder}`,
                borderRadius: '4px', color: COLORS.accent,
              }}>
                {f.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
