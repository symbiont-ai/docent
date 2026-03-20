// ==========================================================
// DOCENT — Color Palette (CSS variable–backed, theme-aware)
// ==========================================================

export const COLORS = {
  bg: 'var(--color-bg)',
  surface: 'var(--color-surface)',
  surfaceHover: 'var(--color-surface-hover)',
  border: 'var(--color-border)',
  borderLight: 'var(--color-border-light)',
  text: 'var(--color-text)',
  textMuted: 'var(--color-text-muted)',
  textDim: 'var(--color-text-dim)',
  accent: 'var(--color-accent)',           // warm gold — academic
  accentLight: 'var(--color-accent-light)',
  accentBg: 'var(--color-accent-bg)',
  accentBorder: 'var(--color-accent-border)',
  accentMedium: 'var(--color-accent-medium)',
  accentStrong: 'var(--color-accent-strong)',
  accentGlow: 'var(--color-accent-glow)',
  cyan: 'var(--color-cyan)',
  cyanBg: 'var(--color-cyan-bg)',
  cyanBorder: 'var(--color-cyan-border)',
  cyanBorderLight: 'var(--color-cyan-border-light)',
  green: 'var(--color-green)',
  greenBg: 'var(--color-green-bg)',
  greenBorder: 'var(--color-green-border)',
  red: 'var(--color-red)',
  redBg: 'var(--color-red-bg)',
  redBorder: 'var(--color-red-border)',
  redMedium: 'var(--color-red-medium)',
  purple: 'var(--color-purple)',
  purpleBg: 'var(--color-purple-bg)',
  textDimBg: 'var(--color-text-dim-bg)',
  textDimBorder: 'var(--color-text-dim-border)',
  textDimHalf: 'var(--color-text-dim-half)',
  surfaceOverlay: 'var(--color-surface-overlay)',
  bgOverlay: 'var(--color-bg-overlay)',
  userBubbleBg: 'var(--color-user-bubble-bg)',
  userBubbleBorder: 'var(--color-user-bubble-border)',
} as const;

export type ColorKey = keyof typeof COLORS;

// Raw hex palettes for contexts that cannot use CSS variables (e.g. PPTX export, canvas)
export const DARK_PALETTE = {
  bg: '#0F1419',
  surface: '#1A2332',
  surfaceHover: '#1E293B',
  border: '#2A3A4E',
  borderLight: '#3A4F66',
  text: '#E8EAED',
  textMuted: '#8B9DB6',
  textDim: '#5A6F87',
  accent: '#D4A853',
  accentLight: '#E8C97A',
  cyan: '#5BB8D4',
  green: '#6BC485',
  red: '#D46B6B',
  purple: '#A78BFA',
} as const;

export const LIGHT_PALETTE = {
  bg: '#F8F9FA',
  surface: '#FFFFFF',
  surfaceHover: '#F1F3F5',
  border: '#DEE2E6',
  borderLight: '#E9ECEF',
  text: '#1A1A2E',
  textMuted: '#6B7280',
  textDim: '#9CA3AF',
  accent: '#B8922E',
  accentLight: '#D4A853',
  cyan: '#2E8FAE',
  green: '#3D8B5E',
  red: '#C04040',
  purple: '#7C3AED',
} as const;
