// ==========================================================
// DOCENT — Socratic Assessment Engine
// Pure functions: intent detection, theta math, tier selection,
// system prompt building, response parsing, stop conditions
// ==========================================================

import type {
  AssessmentTier, AssessmentState, AssessmentAnswer,
  AssessmentQuestion, Slide,
} from '@/src/types';

// ── Intent Detection ─────────────────────────────────────

const ASSESSMENT_PATTERNS = [
  /\b(?:assess|quiz|test)\s+me\b/i,
  /\bstart\s+(?:an?\s+)?(?:assessment|quiz|test)\b/i,
  /\bcheck\s+(?:my\s+)?(?:understanding|knowledge|comprehension)\b/i,
  /\bsocratic\s+(?:assessment|mode|quiz)\b/i,
  /\bhow\s+well\s+do\s+I\s+(?:know|understand)\b/i,
  /\bevaluate\s+(?:my\s+)?(?:understanding|knowledge)\b/i,
];

const QUIT_PATTERNS = [
  /\b(?:quit|stop|cancel|exit|end)\s*(?:the\s+)?(?:assessment|quiz|test)?\b/i,
  /\bnever\s*mind\b/i,
];

export function isAssessmentIntent(text: string): boolean {
  return ASSESSMENT_PATTERNS.some(p => p.test(text));
}

export function isQuitIntent(text: string): boolean {
  return QUIT_PATTERNS.some(p => p.test(text));
}

// ── Theta & Tier Math ────────────────────────────────────

export const THETA_DELTA = 0.3;
export const THETA_MIN = -1.0;
export const THETA_MAX = 1.0;

function clampTheta(theta: number): number {
  return Math.max(THETA_MIN, Math.min(THETA_MAX, theta));
}

export function computeNextTheta(currentTheta: number, score: number): number {
  // score 1.0 → +0.3, score 0.5 → 0.0, score 0.0 → -0.3
  const delta = score === 1.0 ? THETA_DELTA : score === 0.0 ? -THETA_DELTA : 0.0;
  return clampTheta(currentTheta + delta);
}

export function selectTier(theta: number): AssessmentTier {
  if (theta < -0.33) return 1;
  if (theta > 0.33) return 3;
  return 2;
}

// ── Stop Conditions ──────────────────────────────────────

export function shouldStopAssessment(state: AssessmentState): boolean {
  if (state.answers.length >= 5) return true;
  if (state.consecutiveT3Correct >= 3) return true;
  if (state.consecutiveT1Incorrect >= 3) return true;
  return false;
}

// ── Slide Summaries (minimal context for API) ────────────

export function buildSlideSummaries(slides: Slide[]): string {
  return slides
    .map((s, i) => {
      const bullets = s.content?.join('; ') || '';
      return `Slide ${i + 1}: "${s.title}" — ${bullets}`;
    })
    .filter((_, i) => i > 0 && i < slides.length - 1) // Skip title + closing slides
    .join('\n');
}

// ── Assessment System Prompts ────────────────────────────

const TIER_DESCRIPTIONS: Record<AssessmentTier, string> = {
  1: 'Tier 1 (Recall): Ask a factual question testing whether the student remembers a specific fact, term, or finding from the slides.',
  2: 'Tier 2 (Application): Ask a question requiring the student to apply a concept to a new scenario or make a comparison.',
  3: 'Tier 3 (Synthesis): Ask a question requiring combining multiple concepts, evaluating evidence, or proposing implications not stated in the slides.',
};

export function buildAssessmentSystemPrompt(
  slideSummaries: string,
  state: AssessmentState,
  tier: AssessmentTier,
): string {
  const history = state.answers.map(a =>
    `  Q${a.questionNumber} (Tier ${a.tier}, concept: "${a.slideContext}"): score=${a.score}`
  ).join('\n') || '  (none yet)';

  const assessedConcepts = state.questions.map(q => q.slideContext).join(', ') || 'none';

  return `You are Sage, conducting a Socratic assessment on a presentation the student just studied.

SLIDE CONTENT (titles + bullets only):
${slideSummaries}

ASSESSMENT HISTORY:
${history}
Current ability estimate (theta): ${state.theta.toFixed(2)}
Already assessed concepts: ${assessedConcepts}

YOUR TASK: Ask ONE question at the specified difficulty level, targeting a concept NOT yet assessed.

DIFFICULTY: ${TIER_DESCRIPTIONS[tier]}

Respond with ONLY valid JSON (no markdown, no code fences):
{"question": "Your question text", "slideContext": "The slide title or concept being tested"}`;
}

export function buildEvaluationSystemPrompt(
  slideSummaries: string,
  question: AssessmentQuestion,
  userAnswer: string,
): string {
  return `You are Sage, evaluating a student's answer during a Socratic assessment.

SLIDE CONTENT:
${slideSummaries}

QUESTION (Tier ${question.tier}): ${question.question}
SLIDE CONTEXT: ${question.slideContext}
STUDENT'S ANSWER: ${userAnswer}

Score the answer:
- 1.0 = Correct or substantially correct
- 0.5 = Partially correct (right idea but missing key details)
- 0.0 = Incorrect or off-topic

Respond with ONLY valid JSON (no markdown, no code fences):
{"score": 0, "acknowledgment": "Brief encouraging feedback (1-2 sentences). If wrong, gently explain the key point."}`;
}

// ── Response Parsers ─────────────────────────────────────

export function parseQuestionResponse(raw: string): {
  question: string;
  slideContext: string;
} | null {
  try {
    let jsonStr = raw;
    const block = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (block) jsonStr = block[1];
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(jsonStr.substring(start, end + 1));
    if (typeof parsed.question !== 'string') return null;
    return {
      question: parsed.question,
      slideContext: parsed.slideContext || '',
    };
  } catch {
    return null;
  }
}

export function parseEvaluationResponse(raw: string): {
  score: number;
  acknowledgment: string;
} | null {
  try {
    let jsonStr = raw;
    const block = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (block) jsonStr = block[1];
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(jsonStr.substring(start, end + 1));
    const score = typeof parsed.score === 'number' ? parsed.score : null;
    if (score === null || ![0, 0.5, 1].includes(score)) return null;
    return {
      score,
      acknowledgment: parsed.acknowledgment || 'Let me check that.',
    };
  } catch {
    return null;
  }
}

// ── Gap Report Builder ───────────────────────────────────

export function buildGapReport(state: AssessmentState): string {
  const totalScore = state.answers.reduce((sum, a) => sum + a.score, 0);
  const maxScore = state.answers.length;
  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  // Dedupe concepts
  const strong = [...new Set(
    state.answers.filter(a => a.score >= 0.5).map(a => a.slideContext || `Q${a.questionNumber}`)
  )];
  const weak = [...new Set(
    state.answers.filter(a => a.score === 0).map(a => a.slideContext || `Q${a.questionNumber}`)
  )];

  // Mastery label from final theta
  let mastery: string;
  if (state.theta > 0.5) mastery = 'Strong command';
  else if (state.theta > 0) mastery = 'Solid understanding';
  else if (state.theta > -0.33) mastery = 'Developing understanding';
  else mastery = 'Needs review';

  let report = `## Assessment Complete\n\n`;
  report += `**Score:** ${totalScore}/${maxScore} (${percentage}%)  \u00B7  **Mastery:** ${mastery} (\u03B8 = ${state.theta.toFixed(2)})\n\n`;

  if (strong.length > 0) {
    report += `**Strong areas:** ${strong.join(', ')}\n\n`;
  }
  if (weak.length > 0) {
    report += `**Needs review:** ${weak.join(', ')}\n\n`;
  }

  report += `---\n\nWhat would you like to do?\n`;
  report += `1. **Full breakdown** \u2014 see each question with detailed feedback\n`;
  report += `2. **Re-explain** \u2014 have Sage re-teach the weak concepts\n`;
  report += `3. **Try again** \u2014 retake the assessment\n`;

  return report;
}

/** Build a detailed per-question breakdown for option 1 */
export function buildFullBreakdown(state: AssessmentState): string {
  let report = `## Full Assessment Breakdown\n\n`;
  const tierLabel = { 1: 'Recall', 2: 'Application', 3: 'Synthesis' };

  for (const a of state.answers) {
    const q = state.questions.find(qq => qq.questionNumber === a.questionNumber);
    const icon = a.score === 1 ? '\u2705' : a.score === 0.5 ? '\u26A0\uFE0F' : '\u274C';
    report += `### ${icon} Question ${a.questionNumber} \u2014 ${tierLabel[a.tier]} (Tier ${a.tier})\n`;
    report += `**Topic:** ${q?.slideContext || 'N/A'}\n\n`;
    report += `**Q:** ${q?.question || 'N/A'}\n\n`;
    report += `**Your answer:** ${a.userAnswer}\n\n`;
    report += `**Score:** ${a.score}/1.0 \u2014 ${a.acknowledgment}\n\n---\n\n`;
  }

  return report;
}

// ── Initial State Factory ────────────────────────────────

export function createInitialAssessmentState(): AssessmentState {
  return {
    phase: 'idle',
    theta: 0,
    currentQuestionNumber: 0,
    questions: [],
    answers: [],
    consecutiveT3Correct: 0,
    consecutiveT1Incorrect: 0,
    offeredThisPresentation: false,
  };
}
