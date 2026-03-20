'use client';

import React from 'react';
import { COLORS } from '@/src/lib/colors';
import MessageBubble from './MessageBubble';
import type { Message, UploadedFile, AssessmentPhase } from '@/src/types';

interface ChatPanelProps {
  messages: Message[];
  input: string;
  setInput: (v: string) => void;
  isLoading: boolean;
  handleSend: () => void;
  searchMode: boolean;
  setSearchMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  deepThinking: boolean;
  setDeepThinking: (v: boolean | ((prev: boolean) => boolean)) => void;
  uploadedFiles: UploadedFile[];
  removeFile: (index: number) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onSpeak: (text: string, lang?: string) => void;
  isSpeaking: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  loadingMsg: string;
  /** Whether auto-search is active (presentation intent + no PDF) */
  autoSearchActive?: boolean;
  /** Display name of the currently selected model */
  selectedModelName?: string;
  /** Current assessment phase for mode banner */
  assessmentPhase?: AssessmentPhase;
  /** Whether a presentation is loaded (for Q&A banner) */
  hasPresentation?: boolean;
}

const SUGGESTION_PROMPTS = [
  'Present this paper',
  'Prepare a lecture on quantum computing',
  'Make slides about climate change',
];

export default function ChatPanel({
  messages,
  input,
  setInput,
  isLoading,
  handleSend,
  searchMode,
  setSearchMode,
  deepThinking,
  setDeepThinking,
  uploadedFiles,
  removeFile,
  fileInputRef,
  onSpeak,
  isSpeaking,
  messagesEndRef,
  loadingMsg,
  autoSearchActive,
  selectedModelName,
  assessmentPhase,
  hasPresentation,
}: ChatPanelProps) {
  const effectiveSearch = searchMode || !!autoSearchActive;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Mode banner — pinned above scrollable area */}
      {messages.length > 0 && hasPresentation && (
        <div style={{
          padding: '6px 14px', margin: '8px 20px 0', borderRadius: '8px', display: 'flex',
          alignItems: 'center', gap: '8px', fontSize: '12px',
          fontFamily: 'system-ui, sans-serif', flexShrink: 0,
          ...(assessmentPhase === 'active' || assessmentPhase === 'report'
            ? { backgroundColor: COLORS.accentBg, border: `1px solid ${COLORS.accentBorder}`, color: COLORS.accent }
            : { backgroundColor: COLORS.cyanBg, border: `1px solid ${COLORS.cyanBorderLight}`, color: COLORS.cyan }
          ),
        }}>
          {assessmentPhase === 'active' ? (
            <><span style={{ fontSize: '14px' }}>{'\uD83C\uDF93'}</span> <strong>Assessment Mode</strong> — Answer Sage&apos;s questions to check your understanding</>
          ) : assessmentPhase === 'report' ? (
            <><span style={{ fontSize: '14px' }}>{'\uD83D\uDCCA'}</span> <strong>Assessment Complete</strong> — Review your results below</>
          ) : (
            <><span style={{ fontSize: '14px' }}>{'\uD83D\uDCAC'}</span> <strong>Q&amp;A Mode</strong> — Ask Sage anything about the presentation</>
          )}
        </div>
      )}

      {/* Messages area */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '20px',
        display: 'flex', flexDirection: 'column', gap: '16px',
      }}>
        {/* Welcome screen */}
        {messages.length === 0 && (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '16px',
            color: COLORS.textDim,
          }}>
            <div style={{ fontSize: '56px', opacity: 0.6 }}>{'\uD83D\uDCD6'}</div>
            <div style={{ fontSize: '20px', color: COLORS.textMuted, fontWeight: 500 }}>
              Meet Sage, your AI presenter
            </div>
            <div style={{
              fontSize: '14px', color: COLORS.textDim, textAlign: 'center',
              lineHeight: '1.6', maxWidth: '480px', fontFamily: 'system-ui, sans-serif',
            }}>
              Upload a PDF paper and ask Sage to present it, or request a presentation on any topic.
            </div>
            <div style={{
              display: 'flex', gap: '8px', flexWrap: 'wrap',
              justifyContent: 'center', marginTop: '8px',
            }}>
              {SUGGESTION_PROMPTS.map(s => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  style={{
                    padding: '8px 14px', borderRadius: '20px',
                    border: `1px solid ${COLORS.border}`,
                    backgroundColor: 'transparent', color: COLORS.textMuted,
                    cursor: 'pointer', fontSize: '13px', fontFamily: 'system-ui, sans-serif',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={e => {
                    (e.target as HTMLButtonElement).style.borderColor = COLORS.accent;
                    (e.target as HTMLButtonElement).style.color = COLORS.accent;
                  }}
                  onMouseLeave={e => {
                    (e.target as HTMLButtonElement).style.borderColor = COLORS.border;
                    (e.target as HTMLButtonElement).style.color = COLORS.textMuted;
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg.isThinking ? { ...msg, text: msg.text || loadingMsg || 'Thinking...' } : msg}
            onSpeak={onSpeak}
            isSpeaking={isSpeaking}
          />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div style={{
        padding: '12px 20px', borderTop: `1px solid ${COLORS.border}`,
        backgroundColor: COLORS.surface,
      }}>
        {/* Uploaded files badges */}
        {uploadedFiles.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
            {uploadedFiles.map((f, i) => (
              <span key={i} style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px',
                backgroundColor: COLORS.accentBg, border: `1px solid ${COLORS.accentBorder}`,
                borderRadius: '14px', fontSize: '12px', color: COLORS.accent,
                fontFamily: 'system-ui, sans-serif',
              }}>
                {f.mediaType === 'application/pdf' ? '\uD83D\uDCC4' : '\uD83D\uDDBC'} {f.name}
                <span
                  onClick={() => removeFile(i)}
                  style={{ cursor: 'pointer', opacity: 0.6 }}
                >
                  {'\u2715'}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Input row */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* File upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            style={{
              padding: '10px 12px', borderRadius: '8px',
              border: `1px solid ${COLORS.border}`,
              backgroundColor: 'transparent', color: COLORS.textMuted,
              cursor: 'pointer', fontSize: '16px',
            }}
          >
            {'\uD83D\uDCCE'}
          </button>

          {/* Search toggle */}
          <button
            onClick={() => setSearchMode((s: boolean) => !s)}
            title={autoSearchActive ? 'Auto-enabled for presentations' : 'Web search for current info'}
            style={{
              padding: '8px 10px', borderRadius: '8px',
              cursor: 'pointer', fontSize: '12px', fontFamily: 'system-ui, sans-serif', fontWeight: 500,
              border: `1px solid ${effectiveSearch ? COLORS.cyan : COLORS.border}`,
              backgroundColor: effectiveSearch ? COLORS.cyanBg : 'transparent',
              color: effectiveSearch ? COLORS.cyan : COLORS.textMuted,
            }}
          >
            {'\uD83D\uDD0D'} {effectiveSearch ? 'Search ON' : 'Search'}
          </button>

          {/* Deep thinking toggle */}
          <button
            onClick={() => setDeepThinking((d: boolean) => !d)}
            title="Extended thinking for deeper analysis"
            style={{
              padding: '8px 10px', borderRadius: '8px',
              cursor: 'pointer', fontSize: '12px', fontFamily: 'system-ui, sans-serif', fontWeight: 500,
              border: `1px solid ${deepThinking ? COLORS.purple : COLORS.border}`,
              backgroundColor: deepThinking ? COLORS.purpleBg : 'transparent',
              color: deepThinking ? COLORS.purple : COLORS.textMuted,
            }}
          >
            {'\uD83E\uDDE0'} {deepThinking ? 'Deep ON' : 'Deep'}
          </button>

          {/* Text input */}
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              isLoading
                ? 'Sage is working...'
                : uploadedFiles.length > 0
                  ? 'Ask Sage to present this paper...'
                  : 'Ask Sage anything, or request a presentation...'
            }
            disabled={isLoading}
            style={{
              flex: 1, padding: '10px 16px', borderRadius: '8px',
              border: `1px solid ${COLORS.border}`,
              backgroundColor: isLoading ? COLORS.surface : COLORS.bg,
              color: COLORS.text, fontSize: '14px', outline: 'none',
              fontFamily: 'system-ui, sans-serif',
              opacity: isLoading ? 0.5 : 1,
            }}
          />

          {/* Send button */}
          <button
            onClick={() => handleSend()}
            disabled={isLoading || !input.trim()}
            style={{
              padding: '10px 20px', borderRadius: '8px', border: 'none',
              backgroundColor: isLoading || !input.trim() ? COLORS.border : COLORS.accent,
              color: isLoading || !input.trim() ? COLORS.textDim : COLORS.bg,
              cursor: isLoading || !input.trim() ? 'not-allowed' : 'pointer',
              fontSize: '14px', fontWeight: 600, fontFamily: 'system-ui, sans-serif',
            }}
          >
            Send
          </button>
        </div>

        {/* Model indicator */}
        {selectedModelName && (
          <div style={{
            textAlign: 'right', fontSize: '13px', color: COLORS.accent,
            fontFamily: 'system-ui, sans-serif', marginTop: '4px',
          }}>
            {selectedModelName}
          </div>
        )}
      </div>
    </div>
  );
}
