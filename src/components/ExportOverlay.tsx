'use client';

import React from 'react';
import { COLORS } from '@/src/lib/colors';

interface ExportOverlayProps {
  html: string;
  title: string;
  slidesCount: number;
  onClose: () => void;
}

export default function ExportOverlay({
  html,
  title,
  slidesCount,
  onClose,
}: ExportOverlayProps) {
  const handleDownload = () => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (title || 'docent-presentation')
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase() + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', flexDirection: 'column',
      backgroundColor: '#0F1419',
    }}>
      {/* Export toolbar */}
      <div style={{
        padding: '10px 20px', backgroundColor: '#1A2332',
        borderBottom: `2px solid ${COLORS.accent}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0,
      }}>
        <span style={{
          color: COLORS.accent, fontWeight: 600, fontSize: '14px',
          fontFamily: "'Palatino Linotype', Georgia, serif",
        }}>
          Docent Export — {slidesCount} slides
        </span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleDownload}
            style={{
              padding: '8px 20px', borderRadius: '6px', border: 'none',
              backgroundColor: COLORS.accent, color: COLORS.bg,
              cursor: 'pointer', fontSize: '13px', fontWeight: 600,
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            {'\uD83D\uDCE5'} Download HTML
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '8px 20px', borderRadius: '6px',
              border: `1px solid ${COLORS.border}`,
              backgroundColor: 'transparent', color: COLORS.text,
              cursor: 'pointer', fontSize: '13px',
              fontFamily: 'system-ui, sans-serif',
            }}
          >
            {'\u2715'} Close
          </button>
        </div>
      </div>

      {/* Preview iframe */}
      <iframe
        id="export-iframe"
        srcDoc={html}
        style={{ flex: 1, border: 'none', width: '100%' }}
        title="Presentation Export"
      />
    </div>
  );
}
