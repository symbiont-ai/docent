// ==========================================================
// DOCENT — Color Palette (warm academic dark theme)
// ==========================================================

export const COLORS = {
  bg: '#0F1419',
  surface: '#1A2332',
  surfaceHover: '#1E293B',
  border: '#2A3A4E',
  borderLight: '#3A4F66',
  text: '#E8EAED',
  textMuted: '#8B9DB6',
  textDim: '#5A6F87',
  accent: '#D4A853',        // warm gold — academic
  accentLight: '#E8C97A',
  accentBg: '#D4A85315',
  accentBorder: '#D4A85340',
  cyan: '#5BB8D4',
  cyanBg: '#5BB8D410',
  green: '#6BC485',
  red: '#D46B6B',
  redBg: '#D46B6B15',
} as const;

export type ColorKey = keyof typeof COLORS;
