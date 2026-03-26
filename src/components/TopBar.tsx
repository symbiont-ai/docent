'use client';

import React from 'react';
import { COLORS } from '@/src/lib/colors';
import type { ActiveTab } from '@/src/types';

interface TopBarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc: any;
  pdfTotalPages: number;
  slidesCount: number;
  hasPoster: boolean;
  autoVoice: boolean;
  setAutoVoice: (v: boolean | ((prev: boolean) => boolean)) => void;
  isSpeaking: boolean;
  stopSpeaking: () => void;
  ttsRate: number;
  setTTSRate: (rate: number) => void;
  showSidebar: boolean;
  setShowSidebar: (v: boolean | ((prev: boolean) => boolean)) => void;
  setShowSettings: (v: boolean) => void;
}

export default function TopBar({
  activeTab,
  setActiveTab,
  pdfDoc,
  pdfTotalPages,
  slidesCount,
  hasPoster,
  autoVoice,
  setAutoVoice,
  isSpeaking,
  stopSpeaking,
  ttsRate,
  setTTSRate,
  showSidebar,
  setShowSidebar,
  setShowSettings,
}: TopBarProps) {
  const tabs: ActiveTab[] = ['chat', 'pdf', 'slides', 'poster'];

  const getTabLabel = (tab: ActiveTab): string => {
    if (tab === 'chat') return 'Chat';
    if (tab === 'pdf') return `PDF${pdfDoc ? ` (${pdfTotalPages}p)` : ''}`;
    if (tab === 'poster') return `Poster${hasPoster ? ' ✓' : ''}`;
    return `Slides${slidesCount > 0 ? ` (${slidesCount})` : ''}`;
  };

  return (
    <div className="topbar-root" style={{
      padding: '10px 20px',
      borderBottom: `1px solid ${COLORS.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: COLORS.surface, flexShrink: 0,
    }}>
      {/* Left side: hamburger + branding */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          onClick={() => setShowSidebar((s: boolean) => !s)}
          style={{
            padding: '5px 8px', borderRadius: '6px',
            border: `1px solid ${COLORS.border}`,
            backgroundColor: showSidebar ? COLORS.accentBg : 'transparent',
            color: showSidebar ? COLORS.accent : COLORS.textMuted,
            cursor: 'pointer', fontSize: '16px',
          }}
          title="Sessions & Memory"
        >
          {'\u2630'}
        </button>
        <span className="topbar-brand" style={{
          fontSize: '22px', fontWeight: 700, color: COLORS.accent,
          letterSpacing: '0.5px',
          fontFamily: "'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif",
        }}>
          Docent
        </span>
        <span className="topbar-tagline" style={{ fontSize: '14px', color: COLORS.text, fontStyle: 'italic' }}>
          Your AI Presenter
        </span>
        <span className="topbar-tagline" style={{ fontSize: '14px', color: COLORS.text, fontStyle: 'italic', marginLeft: '6px' }}>
          — Learn something new today
        </span>
        {process.env.NEXT_PUBLIC_BUILD_DATE && (
          <span style={{ fontSize: '10px', color: COLORS.textMuted, marginLeft: '8px', opacity: 0.6 }}>
            v{process.env.NEXT_PUBLIC_BUILD_DATE}
          </span>
        )}
      </div>

      {/* Right side: tabs, voice, settings */}
      <div className="topbar-right" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Tab switcher */}
        {tabs.map(tab => (
          <button
            key={tab}
            className="topbar-tab-btn"
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '5px 14px', borderRadius: '6px',
              border: `1px solid ${activeTab === tab ? COLORS.accent : COLORS.border}`,
              backgroundColor: activeTab === tab ? COLORS.accentBg : 'transparent',
              color: activeTab === tab ? COLORS.accent : COLORS.textMuted,
              cursor: 'pointer', fontSize: '13px', fontWeight: 500,
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            {getTabLabel(tab)}
          </button>
        ))}

        {/* Divider */}
        <div className="topbar-divider" style={{ width: '1px', height: '20px', backgroundColor: COLORS.border, margin: '0 4px' }} />

        {/* Auto-voice toggle */}
        <button
          onClick={() => {
            if (isSpeaking) {
              stopSpeaking();
            } else {
              setAutoVoice((v: boolean) => !v);
            }
          }}
          className="topbar-voice-btn"
          style={{
            padding: '5px 10px', borderRadius: '6px',
            border: `1px solid ${COLORS.border}`,
            backgroundColor: autoVoice ? COLORS.accentBg : 'transparent',
            color: isSpeaking ? COLORS.red : autoVoice ? COLORS.accent : COLORS.textMuted,
            cursor: 'pointer', fontSize: '13px', fontFamily: 'system-ui, sans-serif',
            width: '90px', textAlign: 'center',
          }}
          title={
            isSpeaking
              ? 'Stop speaking'
              : autoVoice
                ? 'Auto-voice ON \u2014 Sage reads every response'
                : 'Auto-voice OFF \u2014 use \uD83D\uDD0A on individual messages'
          }
        >
          {isSpeaking ? '\u23F9 Stop' : autoVoice ? '\uD83D\uDD0A Auto' : '\uD83D\uDD07 Manual'}
        </button>

        {/* Speed control — visible while speaking */}
        {isSpeaking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {[0.75, 1, 1.25, 1.5, 2].map(r => (
              <button
                key={r}
                onClick={() => setTTSRate(r)}
                style={{
                  padding: '4px 6px', borderRadius: '4px', fontSize: '11px',
                  border: `1px solid ${ttsRate === r ? COLORS.accent : COLORS.border}`,
                  backgroundColor: ttsRate === r ? COLORS.accentBg : 'transparent',
                  color: ttsRate === r ? COLORS.accent : COLORS.textMuted,
                  cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                  fontWeight: ttsRate === r ? 600 : 400,
                  minWidth: '36px', textAlign: 'center',
                }}
              >
                {r}x
              </button>
            ))}
          </div>
        )}

        {/* Settings */}
        <button
          onClick={() => setShowSettings(true)}
          style={{
            padding: '5px 10px', borderRadius: '6px',
            border: `1px solid ${COLORS.border}`,
            backgroundColor: 'transparent', color: COLORS.textMuted,
            cursor: 'pointer', fontSize: '14px',
          }}
        >
          {'\u2699'}
        </button>
      </div>
    </div>
  );
}
