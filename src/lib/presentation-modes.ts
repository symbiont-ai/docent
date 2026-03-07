// ==========================================================
// DOCENT — Presentation Modes
// Detects General / Author / Journal Club mode from user text,
// handles plan confirmation detection, and formats the plan
// for display in the chat panel.
// ==========================================================

import type { PresentationMode, NarrativeArcEntry, ExtractedFigure } from '@/src/types';

// ── Mode detection ──────────────────────────────────────────

const AUTHOR_PATTERNS = [
  /\b(?:my|our)\s+(?:paper|work|research|study|manuscript|findings|results|contribution|method)\b/i,
  /\bpresent\s+(?:my|our)\b/i,
  /\b(?:i|we)\s+(?:wrote|authored|published|submitted|developed|proposed|designed|built)\b/i,
  /\b(?:i|we)\s+(?:am|are)\s+(?:the|an?)\s+author/i,
  /\bauthor\s*mode\b/i,
];

const JOURNAL_CLUB_PATTERNS = [
  /\bjournal\s*club\b/i,
  /\bcritique\s+(?:this|the)\b/i,
  /\bcritical(?:ly)?\s+(?:analysis|review|assessment|evaluat|analyz)/i,
  /\breview\s+(?:this|the)\s+(?:paper|study|article|manuscript)\b/i,
  /\bstrengths?\s+and\s+(?:weaknesses?|limitations?)\b/i,
  /\bevaluate\s+(?:this|the)\s+(?:paper|study|methodology)\b/i,
  /\bjournal[\s-]*club\s*mode\b/i,
];

/**
 * Detect presentation mode from the user's message.
 * Author mode → advocacy stance; Journal Club → critical analysis; General → balanced.
 */
export function detectPresentationMode(text: string): PresentationMode {
  if (JOURNAL_CLUB_PATTERNS.some(p => p.test(text))) return 'journal_club';
  if (AUTHOR_PATTERNS.some(p => p.test(text))) return 'author';
  return 'general';
}

// ── Plan response detection ─────────────────────────────────

const CONFIRM_PATTERNS = [
  /^(?:yes|yep|yeah|ok|okay|sure|go|lgtm|perfect|great|fine|approved?|confirmed?)\b/i,
  /\bgo\s*ahead\b/i,
  /\blooks?\s*(?:good|great|fine|perfect|right)\b/i,
  /\bgenerate\s*(?:it|the|slides|presentation|them)?\s*$/i,
  /\bstart\s*(?:generating|building|creating)\b/i,
  /\bproceed\b/i,
  /\bdo\s*it\b/i,
];

const EDIT_PATTERNS = [
  /\b(?:change|move|swap|remove|add|replace|instead|rather|actually|but|modify|adjust|reorder|drop|include|exclude|skip|emphasize|focus|more|less|fewer)\b/i,
  /\bslide\s*\d+\b/i,
  /\bcan\s+you\b/i,
  /\bwhat\s+(?:about|if)\b/i,
];

/**
 * Detect whether the user's response to a surfaced plan is a confirmation
 * (proceed to Pass 2) or an edit request (revise the plan).
 * Defaults to 'edit' when ambiguous — safer to ask again than to auto-proceed.
 */
export function detectPlanResponse(text: string): 'confirm' | 'edit' {
  if (CONFIRM_PATTERNS.some(p => p.test(text))) return 'confirm';
  // Everything else (including ambiguous) → treat as edit / feedback
  return 'edit';
}

// ── Plan formatting for chat ────────────────────────────────

const MODE_LABELS: Record<PresentationMode, string> = {
  general: 'Presentation',
  author: 'Author Presentation',
  journal_club: 'Journal Club Analysis',
};

const MODE_EMOJI: Record<PresentationMode, string> = {
  general: '\uD83D\uDCCA',   // 📊
  author: '\uD83C\uDFAF',    // 🎯
  journal_club: '\uD83D\uDD2C', // 🔬
};

/**
 * Format the Pass 1 plan as a markdown chat message for Author / Journal Club modes.
 * The user can review and edit before Pass 2 proceeds.
 */
export function formatPlanForChat(
  narrativeArc: NarrativeArcEntry[],
  paperSummary: string,
  figures: ExtractedFigure[],
  mode: PresentationMode,
): string {
  const label = MODE_LABELS[mode];
  const emoji = MODE_EMOJI[mode];
  const figCount = figures.filter(f => f.kind === 'figure' || f.kind === 'diagram' || f.kind === 'chart' || f.kind === 'photo').length;
  const tableCount = figures.filter(f => f.kind === 'table').length;

  let text = `${emoji} **${label} Plan**\n\n`;
  text += `**Summary:** ${paperSummary}\n\n`;

  // Visual element counts
  const counts: string[] = [];
  if (figCount > 0) counts.push(`${figCount} figure${figCount > 1 ? 's' : ''}`);
  if (tableCount > 0) counts.push(`${tableCount} table${tableCount > 1 ? 's' : ''}`);
  if (counts.length > 0) {
    text += `\uD83D\uDCCA Visual elements found: ${counts.join(', ')}\n\n`;
  }

  text += `**Proposed slides** (${narrativeArc.length} content slides):\n\n`;

  for (const entry of narrativeArc) {
    const figRefs = entry.element_ids.length > 0
      ? ` [\uD83D\uDCF7 ${entry.element_ids.join(', ')}]`
      : '';
    text += `${entry.slide_number}. **${entry.title}**${figRefs}\n`;
    text += `   _${entry.purpose}_\n\n`;
  }

  text += `---\n`;
  if (mode === 'author') {
    text += `Mode: **Author** \u2014 advocating for your contributions\n\n`;
  } else {
    text += `Mode: **Journal Club** \u2014 critical analysis\n\n`;
  }
  text += `Does this look right? Say **"looks good"** to proceed, or tell me what to change.\n`;
  text += `You can ask me to add, remove, or reorder slides, or switch to a different mode.`;

  return text;
}
