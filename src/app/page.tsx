'use client';

import dynamic from 'next/dynamic';

// Dynamic import with SSR disabled — AppShell uses browser APIs (speech, IndexedDB, canvas)
const AppShell = dynamic(() => import('@/src/components/AppShell'), {
  ssr: false,
  loading: () => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      backgroundColor: '#0F1419',
      color: '#E8EAED',
      gap: '16px',
    }}>
      <span style={{ fontSize: '48px' }}>🌿</span>
      <span style={{
        fontSize: '28px',
        fontWeight: 700,
        color: '#D4A853',
        fontFamily: "'Palatino Linotype', Georgia, serif",
      }}>
        Docent
      </span>
      <span style={{
        fontSize: '14px',
        color: '#8B9DB6',
        fontFamily: 'system-ui, sans-serif',
      }}>
        Loading your AI Presenter...
      </span>
    </div>
  ),
});

export default function Home() {
  return <AppShell />;
}
