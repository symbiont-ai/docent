// ==========================================================
// DOCENT — Lightweight Language Detection
// Heuristic-based detection using character/script analysis.
// No external deps, sub-millisecond, returns ISO 639-1 code.
// ==========================================================

/** Script ranges → language code (most common language for each script) */
const SCRIPT_RANGES: Array<[RegExp, string]> = [
  [/[\u3040-\u309F\u30A0-\u30FF]/g, 'ja'],  // Hiragana + Katakana → Japanese
  [/[\uAC00-\uD7AF]/g, 'ko'],                // Hangul → Korean
  [/[\u4E00-\u9FFF]/g, 'zh'],                // CJK Unified → Chinese
  [/[\u0400-\u04FF]/g, 'ru'],                // Cyrillic → Russian
  [/[\u0600-\u06FF]/g, 'ar'],                // Arabic block → Arabic
  [/[\u0900-\u097F]/g, 'hi'],                // Devanagari → Hindi
  [/[\u0E00-\u0E7F]/g, 'th'],                // Thai
  [/[\u0370-\u03FF]/g, 'el'],                // Greek
  [/[\u0590-\u05FF]/g, 'he'],                // Hebrew
];

/**
 * Latin-script language heuristics.
 * Each entry: [regex for distinctive chars, threshold count, language code]
 * Order matters — most distinctive first to avoid false positives.
 */
const LATIN_HEURISTICS: Array<[RegExp, number, string]> = [
  [/[şğıİ]/g,         2, 'tr'],  // Turkish: ş, ğ, dotless ı, dotted İ
  [/[ñ¿¡]/g,          2, 'es'],  // Spanish: ñ, inverted punctuation
  [/[ãõ]/g,           2, 'pt'],  // Portuguese: ã, õ
  [/ß/g,              1, 'de'],  // German: ß (single instance is strong signal)
  [/[èêëàùœæ]/g,      2, 'fr'],  // French: accents + ligatures
];

/**
 * Detect the language of a text string.
 *
 * @param text         The text to analyze (first ~500 chars are sampled)
 * @param sessionHint  Optional ISO 639-1 hint from presentation/session context
 * @returns            ISO 639-1 language code (defaults to 'en')
 */
export function detectLanguage(text: string, sessionHint?: string): string {
  if (!text || text.length < 5) return sessionHint || 'en';

  // Strip markdown formatting, code blocks, URLs — keep only prose
  const cleaned = text
    .replace(/```[\s\S]*?```/g, '')     // code blocks
    .replace(/`[^`]+`/g, '')            // inline code
    .replace(/https?:\/\/\S+/g, '')     // URLs
    .replace(/[#*_~>\-|[\]()]/g, '');   // markdown symbols

  const sample = cleaned.slice(0, 500).toLowerCase();
  if (sample.length < 5) return sessionHint || 'en';

  // 1. Non-Latin script detection (strong signal)
  for (const [regex, lang] of SCRIPT_RANGES) {
    const matches = sample.match(regex);
    if (matches && matches.length >= 3) return lang;
  }

  // 2. Latin-script heuristics for specific languages
  // Use original (non-lowercased) text for case-sensitive chars like İ
  const originalSample = cleaned.slice(0, 500);
  for (const [regex, threshold, lang] of LATIN_HEURISTICS) {
    const matches = originalSample.match(regex);
    if (matches && matches.length >= threshold) return lang;
  }

  // 3. Session hint fallback (e.g., presentation was in Turkish, so chat likely is too)
  if (sessionHint && sessionHint !== 'en') return sessionHint;

  return 'en';
}
