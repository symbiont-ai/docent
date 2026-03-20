// ==========================================================
// DOCENT — Theme utilities (localStorage + DOM)
// ==========================================================

export type ThemeChoice = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const STORAGE_KEY = 'docent-theme';

export function getStoredTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'system') return v;
  } catch { /* SSR / private mode */ }
  return 'dark';
}

export function setStoredTheme(choice: ThemeChoice): void {
  try { localStorage.setItem(STORAGE_KEY, choice); } catch { /* noop */ }
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== 'system') return choice;
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(choice: ThemeChoice): void {
  const resolved = resolveTheme(choice);
  document.documentElement.setAttribute('data-theme', resolved);
  setStoredTheme(choice);
}

/** Subscribe to OS theme changes; returns cleanup function. */
export function onSystemThemeChange(cb: (resolved: ResolvedTheme) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => cb(mq.matches ? 'light' : 'dark');
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
