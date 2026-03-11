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
  autoVoice: boolean;
  setAutoVoice: (v: boolean | ((prev: boolean) => boolean)) => void;
  isSpeaking: boolean;
  stopSpeaking: () => void;
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
  autoVoice,
  setAutoVoice,
  isSpeaking,
  stopSpeaking,
  showSidebar,
  setShowSidebar,
  setShowSettings,
}: TopBarProps) {
  const tabs: ActiveTab[] = ['chat', 'pdf', 'slides'];

  const getTabLabel = (tab: ActiveTab): string => {
    if (tab === 'chat') return 'Chat';
    if (tab === 'pdf') return `PDF${pdfDoc ? ` (${pdfTotalPages}p)` : ''}`;
    return `Slides${slidesCount > 0 ? ` (${slidesCount})` : ''}`;
  };

  return (
    <div style={{
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
        <span style={{
          fontSize: '22px', fontWeight: 700, color: COLORS.accent,
          letterSpacing: '0.5px',
          fontFamily: "'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif",
        }}>
          Docent
        </span>
        <span style={{ fontSize: '14px', color: COLORS.text, fontStyle: 'italic' }}>
          Your AI Presenter
        </span>
        <span style={{ fontSize: '14px', color: COLORS.text, fontStyle: 'italic', marginLeft: '6px' }}>
          — Learn something new today
        </span>
      </div>

      {/* Right side: tabs, voice, settings */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Tab switcher */}
        {tabs.map(tab => (
          <button
            key={tab}
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
        <div style={{ width: '1px', height: '20px', backgroundColor: COLORS.border, margin: '0 4px' }} />

        {/* Auto-voice toggle */}
        <button
          onClick={() => {
            if (isSpeaking) {
              stopSpeaking();
            } else {
              setAutoVoice((v: boolean) => !v);
            }
          }}
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
