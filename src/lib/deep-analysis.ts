// ==========================================================
// DOCENT — Deep Analysis Utilities
// Builds the LLM prompt for full-deck hallucination audit
// ==========================================================

import type { Slide, NarrativeArcEntry, ExtractedFigure } from '@/src/types';

/**
 * Extract semantic text content from SVG XML.
 * Returns labels and numeric values — no raw markup.
 */
export function extractSvgText(svgXml: string): string {
  const textContent: string[] = [];
  // Match <text> and <tspan> inner text
  const textRegex = /<(?:text|tspan)[^>]*>([^<]+)<\/(?:text|tspan)>/gi;
  let match;
  while ((match = textRegex.exec(svgXml)) !== null) {
    const cleaned = match[1].trim();
    if (cleaned && cleaned.length > 0) textContent.push(cleaned);
  }
  // Deduplicate (tspan content often duplicated in parent text element)
  const unique = [...new Set(textContent)];
  return unique.length > 0 ? unique.join(', ') : '(no text content found)';
}

/**
 * Classify a slide by type for the deep analysis prompt.
 */
export function classifySlide(
  title: string,
  index: number,
  totalSlides: number,
): 'title' | 'content' | 'references' | 'closing' {
  if (index === 0) return 'title';
  if (/^(references|bibliography|sources|works cited|citations)$/i.test(title.trim())) return 'references';
  // Last slide with generic closing titles
  if (index === totalSlides - 1 && /^(thank you|thanks|questions|q\s*&\s*a|the end|fin|end)$/i.test(title.trim())) return 'closing';
  return 'content';
}

/**
 * Build the full system prompt for the deep analysis call.
 * Includes: paper text, all slides, narrative arc, error taxonomy, report template.
 */
export function buildDeepAnalysisPrompt(
  paperText: string,
  slides: Slide[],
  narrativeArc: NarrativeArcEntry[],
  extractedFigures: ExtractedFigure[],
): string {
  const totalSlides = slides.length;

  // ── Build per-slide sections ──
  const slideSections: string[] = [];
  let referencesSection = '';

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const slideType = classifySlide(slide.title, i, totalSlides);
    const slideNum = i + 1;

    if (slideType === 'title') {
      slideSections.push(`SLIDE ${slideNum} [title]: "${slide.title}"\n(Title slide — skip audit)`);
      continue;
    }

    if (slideType === 'closing') {
      slideSections.push(`SLIDE ${slideNum} [closing]: "${slide.title}"\n(Closing slide — skip audit)`);
      continue;
    }

    if (slideType === 'references') {
      const refBullets = slide.content || [];
      referencesSection = `SLIDE ${slideNum} [references]: "${slide.title}"\n` +
        refBullets.map((b, j) => `  ${j + 1}. ${b}`).join('\n');
      slideSections.push(referencesSection);

      // Also gather per-slide citations for orphan/missing check
      const perSlideCitations: string[] = [];
      slides.forEach((s, si) => {
        if (s.references && s.references.length > 0 && si !== i) {
          perSlideCitations.push(`  Slide ${si + 1} "${s.title}": ${s.references.map((r, ri) => `[${ri + 1}] ${r}`).join('; ')}`);
        }
      });
      if (perSlideCitations.length > 0) {
        slideSections[slideSections.length - 1] += `\nPER-SLIDE CITATIONS (from content slides):\n${perSlideCitations.join('\n')}`;
      }
      continue;
    }

    // ── Content slide ──
    const lines: string[] = [`SLIDE ${slideNum} [content]: "${slide.title}"`];

    // Plan entry (exact title match)
    const planEntry = narrativeArc.find(e => e.title.toLowerCase().trim() === slide.title.toLowerCase().trim());
    if (planEntry) {
      lines.push(`Plan: purpose="${planEntry.purpose}" | visual="${planEntry.visual_need || 'none'}"`);
    } else if (narrativeArc.length > 0) {
      lines.push(`Plan: NO MATCHING PLAN ENTRY (title mismatch — potential fabricated slide)`);
    }

    // Bullets
    const bullets = slide.content || [];
    if (bullets.length > 0) {
      lines.push('Bullets:');
      bullets.forEach((b, j) => lines.push(`  B${j + 1}: ${b}`));
    } else {
      lines.push('Bullets: (none)');
    }

    // Speaker notes — split into sentences
    const notes = slide.speakerNotes || '';
    if (notes.trim()) {
      const sentences = notes.split(/(?<=[.!?])\s+/).filter(s => s.trim());
      lines.push('Speaker Notes (by sentence):');
      sentences.forEach((s, j) => lines.push(`  N${j + 1}: ${s}`));
    } else {
      lines.push('Speaker Notes: (none)');
    }

    // Figure info
    if (slide.figure) {
      const fig = slide.figure;
      if (fig.type === 'svg' && fig.content) {
        const svgText = extractSvgText(fig.content);
        lines.push(`Figure: SVG diagram`);
        if (fig.label) lines.push(`  Label: ${fig.label}`);
        if (fig.description) lines.push(`  Description: ${fig.description}`);
        lines.push(`  SVG text content: ${svgText}`);
      } else if (fig.type === 'pdf_crop') {
        lines.push(`Figure: PDF crop — ${fig.label || 'unlabeled'}`);
        if (fig.description) lines.push(`  Description: ${fig.description}`);
        if (fig.extractedId) {
          const ef = extractedFigures.find(f => f.id === fig.extractedId);
          if (ef) {
            lines.push(`  Extracted figure: ${ef.label || ef.id} (${ef.kind}, page ${ef.page})`);
            if (ef.description) lines.push(`  AI description: ${ef.description}`);
          }
        }
      } else {
        lines.push(`Figure: ${fig.type}${fig.label ? ` — ${fig.label}` : ''}`);
      }
    } else {
      lines.push('Figure: none');
    }

    // Per-slide footnote references
    if (slide.references && slide.references.length > 0) {
      lines.push('Footnote references:');
      slide.references.forEach((r, j) => lines.push(`  [${j + 1}] ${r}`));
    }

    slideSections.push(lines.join('\n'));
  }

  // ── Narrative arc summary ──
  let arcSection = '';
  if (narrativeArc.length > 0) {
    arcSection = '\n═══ GENERATION PLAN (NARRATIVE ARC) ═══\n' +
      narrativeArc.map(e => `Slide ${e.slide_number}: "${e.title}" — ${e.purpose}${e.visual_need ? ` [visual: ${e.visual_need}]` : ''}`).join('\n');
  }

  // ── Assemble full prompt ──
  return `You are performing a deep hallucination audit on a presentation generated from a source paper.
Your task: verify EVERY verifiable statement in the deck against the source paper.

This mirrors a manual Content Fidelity Audit protocol. You must be thorough and check ALL tiers:
- Tier 1: Quantitative claims (every number, percentage, count, measurement, ratio, threshold)
- Tier 2: Technical claims (methods, algorithms, experimental setup, dataset properties)
- Tier 3: Framing claims (motivational statements, significance, comparisons, implications, limitations)

═══ SOURCE PAPER ═══
${paperText}
${arcSection}

═══ PRESENTATION SLIDES ═══

${slideSections.join('\n\n')}

═══ AUDIT INSTRUCTIONS ═══

For each CONTENT slide:
1. LIST every verifiable statement from bullets (B1, B2...) and speaker notes (N1, N2...).
2. If SVG present, list every text label/numeric value (S1, S2...).
3. For EACH statement, find the supporting passage in the paper:
   - If found: tag ✅ VERIFIED
   - If approximately correct but imprecise: tag ⚠️ MINOR_IMPRECISION
   - If not found or contradicted: tag ❌ ERROR — quote what the paper actually says
4. FIGURE-NOTES ALIGNMENT: Do the speaker notes describe the figure shown? Flag figure_notes_mismatch if they narrate a different figure.
5. EXTERNAL KNOWLEDGE CHECK: Flag anything from general knowledge rather than this specific paper.
6. SVG FABRICATION CHECK: Verify every numeric value and category label in SVGs against the paper.

For the REFERENCES slide:
- Verify each reference against the paper's actual reference list
- Check: author (first author at minimum), title (CHARACTER BY CHARACTER — the most common error is plausible but wrong titles), venue, year
- Flag orphan references (listed but never cited) and missing references (cited but not listed)

For COVERAGE & STRUCTURE:
- Section coverage: does the deck cover all major paper sections? List any gaps.
- Structural fabrication: are any slides ungrounded in the paper? (HIGH RISK: Limitations, Future Work, Broader Impact slides)
- Plan adherence: do slides match the generation plan?
- Cross-slide consistency: contradictions or redundancies?
- Narrative arc quality: logical progression?

ERROR TAXONOMY (classify each error):
1. fabricated_threshold — Specific number where paper uses qualitative language
2. external_knowledge — Facts from training data, not from this paper
3. structural_fabrication — Unsupported content on template slides (Limitations, Future Work)
4. figure_notes_mismatch — Speaker notes describe a different figure than displayed
5. citation_fabrication — Plausible but wrong reference titles, venues, or authors
6. conjecture_upgrade — Hedged claim in paper presented as definitive
7. computational_fabrication — Invented calculation results
8. causal_injection — Invented causal explanation for observed results

═══ OUTPUT FORMAT ═══

IMPORTANT FORMATTING RULES:
- Always use UPPERCASE tags with icons: ✅ VERIFIED, ⚠️ MINOR_IMPRECISION, ❌ ERROR
- Never use lowercase for these tags (not "minor_imprecision", always "MINOR_IMPRECISION")
- Error types from the taxonomy are always lowercase_snake_case (e.g., conjecture_upgrade, causal_injection)
- The Summary section comes LAST — tally your actual findings, do NOT estimate

Produce the report in markdown. Follow this template EXACTLY:

## Deep Analysis — Quality Audit Report

### Slide-by-Slide Audit

Go through EVERY content slide. For each slide, list ALL verifiable statements with their verdict.

**Slide N: "Title"**

> **[B1 · bullet]** "what the slide says" → Paper: "supporting quote" ✅ VERIFIED

> **[N3 · notes]** "what the slide says" → Paper: "what the paper actually says"
> The slide says X but the paper says Y. Type: error_type | Severity: high/medium/low ❌ ERROR

> **[B2 · bullet]** "what the slide says" → Paper: "approximately matching quote"
> Close but simplified. Type: MINOR_IMPRECISION | Severity: low ⚠️ MINOR_IMPRECISION

If a slide is completely clean (all verified), you may abbreviate after listing all statements:
**Slide N: "Title"** — all N statements ✅ VERIFIED

---

### Errors

Collect ONLY ❌ ERROR items from above into this table. Do NOT include ⚠️ MINOR_IMPRECISION here.
Type must be one of the 8 taxonomy types (fabricated_threshold, external_knowledge, structural_fabrication, figure_notes_mismatch, citation_fabrication, conjecture_upgrade, computational_fabrication, causal_injection).

| # | Slide | ID | Type | Severity | Description |
|---|-------|----|------|----------|-------------|
| 1 | N | B2 | error_type | severity | brief description |

If no errors found, write: "No errors found."

---

### Minor Imprecisions

Collect ONLY ⚠️ MINOR_IMPRECISION items from above into this table.

| # | Slide | ID | Description |
|---|-------|----|-------------|
| 1 | N | B1 | brief description |

If none found, write: "No minor imprecisions found."

---

### Citations

N/N citations verified

For each citation with errors:
> ❌ **Author et al.** — field error
> Slide: "slide version"
> Paper: "paper version"

List any orphan references (listed but never cited) and missing references (cited but not listed).

---

### Coverage & Structure

**Section coverage:** assessment
- List any missing sections with significance

**Structural fabrication:** List any ungrounded slides

**Plan adherence:** assessment
- List any deviations

**Cross-slide consistency:** Note any contradictions or redundancies

**Narrative arc:** assessment

---

### Summary

COUNT your actual findings from the sections above. Do NOT estimate — go back and tally.

| Metric | Value |
|--------|-------|
| Slides audited | N |
| Statements checked | N |
| ✅ Verified | N (%) |
| ⚠️ Minor imprecisions | N (%) |
| ❌ Errors | N (%) |
| Citations | N/N correct |
| Coverage | assessment |

---

> ⚠️ This audit was performed by the same model that generated the deck. Known limitations:
> - External knowledge injection may not be detected (shared training data between generator and auditor)
> - Computational results cannot be independently verified
> - For highest confidence, review flagged slides against the source paper`;
}
