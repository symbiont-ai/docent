// ==========================================================
// DOCENT — Figure Extraction (Pass 1)
// Cheap vision model analyzes PDF thumbnails to locate figures,
// tables, equations, and diagrams with bounding boxes.
// ==========================================================

import { callChat } from '@/src/lib/api';
import { cropPdfFigure, resolveRegion, extractPageXObjects, xobjectToDataURL } from '@/src/lib/pdf-utils';
import type { NativeXObject } from '@/src/lib/pdf-utils';
import type { ExtractedFigure, ExtractionResult } from '@/src/types';

// ── Constants ────────────────────────────────────────────────

/** Cheap, fast vision model for figure extraction */
export const EXTRACTION_MODEL = 'google/gemini-2.5-flash';

/** Max output tokens for the extraction response (structured JSON) */
export const EXTRACTION_MAX_TOKENS = 8192;

/** Hard cap on pages to send to extraction (even if no supplementary detected) */
const MAX_EXTRACTION_PAGES = 30;

// ── Supplementary boundary detection ─────────────────────────

const SUPPLEMENTARY_MARKERS = [
  /\bsupplementary\s+(information|materials?|data|methods|figures|tables)\b/i,
  /\bsupporting\s+information\b/i,
  // NOTE: "Appendix" is intentionally NOT included here. Many ML/CS papers use "Appendix"
  // for essential content (proofs, detailed methods, ablation studies). Only explicitly
  // labeled "Supplementary" material should be excluded.
  /\bsi\s+materials?\b/i,
  /\bsupplemental\s+(materials?|data|methods|figures)\b/i,
  /\bonline\s+methods\b/i,
  /\bextended\s+data\b/i,
];

/**
 * Detect where supplementary/appendix material begins in the PDF.
 * Returns the 1-indexed page number of the first supplementary page, or null.
 */
export function detectSupplementaryBoundary(textPages: string[]): number | null {
  for (let i = 0; i < textPages.length; i++) {
    const text = textPages[i];
    if (!text) continue;

    // Check first 500 chars of each page for supplementary markers
    // (these typically appear as section headers near the top of a page)
    const header = text.slice(0, 500);
    for (const pattern of SUPPLEMENTARY_MARKERS) {
      if (pattern.test(header)) {
        // Verify this isn't just a mention — it should be near the start of the page
        // (a standalone section, not "see Supplementary Figure 1" in body text)
        const match = header.match(pattern);
        if (match && match.index !== undefined && match.index < 200) {
          console.log(`[Extraction] Supplementary boundary detected at page ${i + 1}: "${match[0]}"`);
          return i + 1; // 1-indexed
        }
      }
    }
  }
  return null;
}

const REFERENCES_MARKERS = [
  /^\s*References?\s*$/im,
  /^\s*Bibliography\s*$/im,
  /^\s*Works?\s+Cited\s*$/im,
  /^\s*Literature\s+Cited\s*$/im,
];

// Markers for sections that come AFTER references (appendix, supplementary, checklist, etc.)
// Split into two groups based on where they can safely be detected:
//
// HEADER markers: must appear near the top of a page (first 500 chars, position < 200).
// These terms can appear inside reference titles ("...Appendix of...", "Supplementary Table 3"),
// so we only match them as section headers.
const POST_REFERENCES_HEADER_MARKERS = [
  /^\s*[A-Z]\s+(?:Appendix|Supplementary|Additional|Extended)/im, // "A Appendix-A", "B Supplementary Results", etc.
  /^\s*[A-Z]\.\d/m,                                                // Lettered subsections: "A.1", "B.2", "G.3", etc.
  /^\s*Appendix/im,                                                // "Appendix A", "Appendix"
  /^\s*Supplementary/im,                                           // "Supplementary Results/Materials"
  /^\s*Supporting\s+Information/im,                                // "Supporting Information"
  /^\s*Dataset\s+(?:Documentation|Card)/im,                        // Dataset documentation/cards
  /^\s*(?:Online|Extended)\s+(?:Methods|Data)/im,                  // Online Methods, Extended Data
];

// FULL-PAGE markers: can appear anywhere on a page (including mid-page after references).
// These are distinctive enough to not appear in reference text accidentally.
// IMPORTANT: Only include markers that are ALWAYS post-references content.
// Do NOT include "Ethics Statement" or "Broader Impact" — those can be part of main body.
const POST_REFERENCES_FULLPAGE_MARKERS = [
  /^\s*Checklist\s*$/im,                                            // "Checklist" alone on a line — handles top-of-page
                                                                    // (no preceding \n) and mid-page (^ matches after \n with /m)
  /^\s*(?:\w+\s+)+Checklist\b/im,                                  // "[Word(s)] Checklist" at start of line — generic pattern
                                                                    // matches: "Paper Checklist", "Author Checklist",
                                                                    // "Reproducibility Checklist", "Submission Checklist", etc.
];

/**
 * Detect where the References/Bibliography section begins in the PDF.
 * Scans backwards from the end (references are always near the end of the main body).
 * Returns the 1-indexed page number, or null if not found.
 */
export function detectReferencesSection(textPages: string[]): number | null {
  // Scan backwards from the end to find the references header.
  // No arbitrary page limit — papers with very long appendices may have
  // references far from the end. The regex patterns are specific enough
  // (standalone "References" on its own line) to avoid false positives.
  // Scan the ENTIRE page text — references can start mid-page (e.g., after
  // the conclusion ends on the same page).
  for (let i = textPages.length - 1; i >= 0; i--) {
    const text = textPages[i];
    if (!text) continue;
    for (const pattern of REFERENCES_MARKERS) {
      const match = text.match(pattern);
      if (match) {
        console.log(`[Extraction] References section detected at page ${i + 1}: "${match[0]}"`);
        return i + 1; // 1-indexed
      }
    }
  }
  return null;
}

/**
 * Detect the end of the main content (main body + references).
 * Returns the last 1-indexed page to include for slide generation.
 *
 * Strategy:
 * 1. Find where references start
 * 2. Scan pages after references for post-reference markers (appendix, supplementary, checklist)
 * 3. Return the page before the first post-reference marker
 * 4. If no markers found, return total page count (include everything)
 */
export function detectMainContentEnd(textPages: string[]): {
  mainContentEnd: number;
  referencesPage: number | null;
  postReferencesPage: number | null;
  totalPages: number;
} {
  const totalPages = textPages.length;
  const referencesPage = detectReferencesSection(textPages);

  // If no references section found, fall back to supplementary boundary or full length
  if (!referencesPage) {
    const suppPage = detectSupplementaryBoundary(textPages);
    return {
      mainContentEnd: suppPage ? suppPage - 1 : totalPages,
      referencesPage: null,
      postReferencesPage: suppPage || null,
      totalPages,
    };
  }

  // Scan pages after references start for post-reference content.
  // Two scan modes: HEADER markers must be near the top of a page (to avoid false positives
  // from reference titles mentioning "Appendix" etc.), while FULLPAGE markers (like "Checklist")
  // are distinctive enough to detect anywhere — including mid-page after the last reference.
  for (let i = referencesPage; i < totalPages; i++) {
    const text = textPages[i];
    if (!text) continue;

    // 1. Header markers — check only first 500 chars, position < 200
    const header = text.slice(0, 500);
    for (const pattern of POST_REFERENCES_HEADER_MARKERS) {
      const match = header.match(pattern);
      if (match && match.index !== undefined && match.index < 200) {
        console.log(`[Extraction] Post-references header detected at page ${i + 1}: "${match[0]}" — main content ends at page ${i}`);
        return {
          mainContentEnd: i,
          referencesPage,
          postReferencesPage: i + 1,
          totalPages,
        };
      }
    }

    // 2. Full-page markers — scan entire page (e.g., checklist starting mid-page)
    for (const pattern of POST_REFERENCES_FULLPAGE_MARKERS) {
      const match = text.match(pattern);
      if (match) {
        console.log(`[Extraction] Post-references content detected mid-page ${i + 1}: "${match[0].trim()}" — main content ends at page ${i}`);
        return {
          mainContentEnd: i,
          referencesPage,
          postReferencesPage: i + 1,
          totalPages,
        };
      }
    }
  }

  // No post-reference markers found — include everything
  console.log(`[Extraction] No post-references markers found — including all ${totalPages} pages`);
  return {
    mainContentEnd: totalPages,
    referencesPage,
    postReferencesPage: null,
    totalPages,
  };
}

// ── Thumbnail resizing for extraction ────────────────────────

/** Max dimension (px) for thumbnails sent to Gemini bbox detection.
 *  Google AI Studio internally resizes to 640px — sending larger images
 *  degrades bounding box coordinate accuracy. */
const EXTRACTION_MAX_DIM = 640;

/**
 * Resize a data URL image to max EXTRACTION_MAX_DIM on its longest side.
 * Returns the resized JPEG data URL, or the original if already small enough.
 */
function resizeForExtraction(dataURL: string, maxDim = EXTRACTION_MAX_DIM): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (Math.max(w, h) <= maxDim) {
        resolve(dataURL); // Already small enough
        return;
      }
      const scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataURL); // fallback to original
    img.src = dataURL;
  });
}

// ── Extraction system prompt ─────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `Detect the 2D bounding boxes of all figures, tables, charts, diagrams, and visual elements in these PDF page images.

PRIMARY OBJECTIVE — MANDATORY:
The user provides a CHECKLIST of labeled visual elements confirmed to exist in the document. You MUST locate EVERY checklist item. Missing a checklist item is the worst possible error.

SECONDARY OBJECTIVE:
After locating all checklist items, detect any ADDITIONAL visual elements not in the checklist.

For EACH element, output box_2d as [y_min, x_min, y_max, x_max] where coordinates are integers normalized to a 0–1000 scale (0 = top/left edge, 1000 = bottom/right edge).

TABLE DETECTION — MOST COMMONLY MISSED:
- Detect ALL tables regardless of visual style: bordered, horizontal-rules-only, borderless columnar, shaded rows
- Tables use full page width: x_min ≈ 0, x_max ≈ 1000
- Start from the "Table N" title, end at last data row — do NOT extend into body text below
- If the checklist says "Table N → page P", you MUST find it

FIGURE DETECTION:
- A figure is a VISUAL/GRAPHICAL element (graph, chart, plot, diagram, photo)
- Body text MENTIONING a figure ("Fig. 3 shows...") is NOT the figure — do NOT box text paragraphs
- Crop tightly around actual visual content
- Multi-panel figures (A, B, C subplots) → ONE bounding box covering all panels
- Exclude captions below the figure

COMMON MISTAKES:
- Boxing a text paragraph that references a figure instead of the actual visual — #1 error
- y_max too large (capturing caption or body text below)
- Missing borderless tables
- Individual elements typically span 200–450 units vertically — boxes above 600 are suspicious

COMPLETENESS CHECK:
Cross-reference your output against the checklist before responding. Every item MUST appear.

Output ONLY valid JSON:
{
  "figures": [
    {
      "kind": "figure",
      "page": 1,
      "box_2d": [200, 50, 550, 950],
      "label": "Figure 1",
      "description": "Bar chart comparing model accuracy across datasets"
    },
    {
      "kind": "table",
      "page": 3,
      "box_2d": [300, 0, 580, 1000],
      "label": "Table 1",
      "description": "Classification of pooling methods by attention type"
    }
  ]
}

Sort by page number, then top-to-bottom.`;

// ── Core extraction function ─────────────────────────────────

export async function extractFiguresFromPdf(
  thumbnails: string[],
  textPages: string[],
  apiKey: string,
  signal?: AbortSignal,
  model?: string,
): Promise<ExtractionResult> {
  const extractedAt = Date.now();

  // Detect document structure: main body + references boundary
  // Only extract figures from main content pages (not appendix/supplementary)
  const { mainContentEnd, referencesPage, postReferencesPage, totalPages } =
    detectMainContentEnd(textPages);
  const mainBodyEnd = Math.min(mainContentEnd, MAX_EXTRACTION_PAGES);

  const structureParts: string[] = [`pages 1-${mainBodyEnd}`];
  if (referencesPage) structureParts.push(`references from page ${referencesPage}`);
  if (postReferencesPage) structureParts.push(`post-references from page ${postReferencesPage} (excluded)`);
  console.log(`[Extraction] Document structure: ${structureParts.join(', ')} (${totalPages} total pages)`);

  // Parse label hints: structured data for recovery, formatted string for prompt
  const structuredHints = parseLabelHintsStructured(textPages, mainBodyEnd);
  const labelHints = extractLabelHints(textPages, mainBodyEnd);

  // Resize thumbnails to 640px max for better Gemini bbox accuracy
  const extractionThumbs = await Promise.all(
    thumbnails.slice(0, mainBodyEnd).map(t => t ? resizeForExtraction(t) : Promise.resolve('')),
  );

  // Build multi-image message — put checklist FIRST to prime the model
  const contentBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  if (labelHints) {
    contentBlocks.push({
      type: 'text',
      text: `REQUIRED ELEMENT CHECKLIST — You MUST find ALL of these:\n${labelHints}\n\nEvery item above is confirmed to exist in the document. Your output MUST include each one.`,
    });
  }

  contentBlocks.push({
    type: 'text',
    text: `Analyze these ${mainBodyEnd} PDF page images. Find every checklist item above AND any additional visual elements. Output JSON only.`,
  });

  for (let i = 0; i < mainBodyEnd; i++) {
    if (extractionThumbs[i]) {
      contentBlocks.push({
        type: 'text',
        text: `--- Page ${i + 1} ---`,
      });
      contentBlocks.push({
        type: 'image_url',
        image_url: { url: extractionThumbs[i] },
      });
    }
  }

  if (labelHints) {
    contentBlocks.push({
      type: 'text',
      text: `REMINDER: Cross-check your output against the checklist. Every Figure and Table from the checklist MUST appear in your JSON output.`,
    });
  }

  const effectiveModel = model || EXTRACTION_MODEL;

  const request = {
    messages: [{
      role: 'user' as const,
      content: contentBlocks,
    }],
    model: effectiveModel,
    max_tokens: EXTRACTION_MAX_TOKENS,
    system: EXTRACTION_SYSTEM_PROMPT,
    temperature: 0,
  };

  const { content: raw } = await callChat(request, apiKey, signal);
  let figures = parseExtractionResponse(raw);

  console.log(`[Extraction] Found ${figures.length} visual elements across ${mainBodyEnd} pages (model: ${effectiveModel})`);
  // Log each extracted figure for debugging bbox issues
  for (const fig of figures) {
    const r = fig.region;
    console.log(`[Extraction]   ${fig.id} ${fig.label || fig.kind} → page ${fig.page}, region [${r.map((n: number) => n.toFixed(2)).join(', ')}] (${fig.description?.slice(0, 60)})`);
  }

  // Same-page label order validation: when multiple figures of the same kind share a page,
  // their vertical positions (region[1] = top) should match their label number order.
  // e.g., Table 1 should be above Table 2. If Gemini returned swapped bboxes, fix them.
  const pageGroups = new Map<string, typeof figures>();
  for (const fig of figures) {
    if (!fig.label) continue;
    const key = `${fig.page}-${fig.kind}`;
    if (!pageGroups.has(key)) pageGroups.set(key, []);
    pageGroups.get(key)!.push(fig);
  }
  for (const [key, group] of pageGroups) {
    if (group.length < 2) continue;
    // Extract label numbers and sort by number
    const withNums = group
      .map(fig => ({ fig, num: parseInt((fig.label || '').replace(/\D/g, '') || '0') }))
      .filter(e => e.num > 0);
    if (withNums.length < 2) continue;

    withNums.sort((a, b) => a.num - b.num);
    // Check if vertical order matches label order
    for (let k = 0; k < withNums.length - 1; k++) {
      const upper = withNums[k];
      const lower = withNums[k + 1];
      if (upper.fig.region[1] > lower.fig.region[1] + 0.02) {
        // Label N is below label N+1 — swap their regions
        console.warn(
          `[Extraction] ⚠️ Same-page label order fix: ${upper.fig.label} (top=${upper.fig.region[1].toFixed(2)}) is below ${lower.fig.label} (top=${lower.fig.region[1].toFixed(2)}) on page ${upper.fig.page} — swapping regions`,
        );
        const tmpRegion = upper.fig.region;
        upper.fig.region = lower.fig.region;
        lower.fig.region = tmpRegion;
      }
    }
  }

  // NOTE: We do NOT correct Gemini's labels here — swapping labels without swapping
  // bboxes breaks the label↔bbox pairing and causes wrong images on slides.
  // However, Gemini's DESCRIPTIONS at 640px are often wrong (e.g., two different
  // figures both described as "CDF of download speed"). We fix this by overriding
  // descriptions with text-parsed captions, matched via Gemini's ORIGINAL labels.
  // This preserves bbox↔label consistency while giving the planner accurate descriptions.
  if (structuredHints.length > 0) {
    for (const fig of figures) {
      if (!fig.label) continue;
      const norm = normalizeLabel(fig.label);
      const hint = structuredHints.find(h => h.normalizedLabel === norm);
      if (hint?.captionText && hint.captionText.length > 5) {
        console.log(`[Extraction] Override description for ${fig.label}: "${fig.description}" → "${hint.captionText}"`);
        fig.description = hint.captionText;
      }
    }
  }

  // Duplicate bbox detection: when two figures on the same page have nearly identical
  // bounding boxes, Gemini failed to distinguish them visually. Remove the duplicate
  // so the recovery pass can re-extract it with a targeted single-figure prompt.
  for (let i = figures.length - 1; i >= 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      if (figures[i].page !== figures[j].page) continue;
      const ri = figures[i].region;
      const rj = figures[j].region;
      const close = Math.abs(ri[0] - rj[0]) < 0.03 && Math.abs(ri[1] - rj[1]) < 0.03 &&
                    Math.abs(ri[2] - rj[2]) < 0.03 && Math.abs(ri[3] - rj[3]) < 0.03;
      if (close) {
        // Keep the one whose label has a LOWER number (more likely correct for its position),
        // remove the other so recovery can re-extract it on the right page
        const numI = parseInt((figures[i].label || '').replace(/\D/g, '') || '999');
        const numJ = parseInt((figures[j].label || '').replace(/\D/g, '') || '999');
        const removeIdx = numI > numJ ? i : j;
        console.warn(`[Extraction] ⚠️ Duplicate bbox on page ${figures[i].page}: ${figures[i].id}(${figures[i].label}) and ${figures[j].id}(${figures[j].label}) — removing ${figures[removeIdx].id}(${figures[removeIdx].label}) for re-extraction`);
        figures.splice(removeIdx, 1);
        break; // restart outer loop since indices shifted
      }
    }
  }

  // Page correction: trust caption-detected pages over vision model pages.
  // If the vision model says "Figure 3 → page 3" but the caption says page 4,
  // the bounding box was estimated for the wrong page. Remove the figure so
  // recovery re-extracts it on the correct page with a correct bounding box.
  if (structuredHints.length > 0) {
    for (let i = figures.length - 1; i >= 0; i--) {
      const fig = figures[i];
      if (!fig.label) continue;
      const norm = normalizeLabel(fig.label);
      const hint = structuredHints.find(h => h.normalizedLabel === norm);
      if (hint && hint.page !== fig.page) {
        console.warn(
          `[Extraction] Page mismatch: ${fig.label} — vision says page ${fig.page}, caption says page ${hint.page} — removing for re-extraction`,
        );
        figures.splice(i, 1);
      }
    }
  }

  // Completeness check + recovery for missing elements
  if (structuredHints.length > 0) {
    const foundLabels = new Set(
      figures.filter(f => f.label).map(f => normalizeLabel(f.label!)),
    );
    const missing = structuredHints.filter(h => !foundLabels.has(h.normalizedLabel));

    if (missing.length > 0) {
      const missingTables = missing.filter(m => m.kind === 'table');
      const missingOther = missing.filter(m => m.kind !== 'table');
      if (missingTables.length > 0) {
        console.warn(`[Extraction] ⚠️ MISSING ${missingTables.length} TABLE(S): ${missingTables.map(m => m.label).join(', ')}`);
      }
      if (missingOther.length > 0) {
        console.warn(`[Extraction] ⚠️ MISSING ${missingOther.length} FIGURE(S): ${missingOther.map(m => m.label).join(', ')}`);
      }

      // Recovery pass: targeted extraction for missing elements
      figures = await recoverMissingElements(
        missing, thumbnails, figures, apiKey, effectiveModel, signal,
      );
    }

    // Filter out unlabeled extras when all hinted labels are covered
    const finalLabels = new Set(
      figures.filter(f => f.label).map(f => normalizeLabel(f.label!)),
    );
    const allHintsCovered = structuredHints.every(h => finalLabels.has(h.normalizedLabel));
    if (allHintsCovered && figures.length > structuredHints.length) {
      const before = figures.length;
      figures = figures.filter(f => f.label);
      // Re-assign IDs after filtering
      figures.forEach((f, i) => { f.id = `ef_${i + 1}`; });
      if (figures.length < before) {
        console.log(`[Extraction] Removed ${before - figures.length} unlabeled element(s) — all ${structuredHints.length} hinted labels are covered`);
      }
    }
  }

  return {
    figures,
    model: effectiveModel,
    extractedAt,
    mainBodyPages: mainBodyEnd,
    supplementaryStartPage: postReferencesPage || undefined,
  };
}

// ── JSON parsing with repair ─────────────────────────────────

export function parseExtractionResponse(raw: string): ExtractedFigure[] {
  // Extract JSON from markdown code blocks if present
  let jsonStr = raw;
  const jsonBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlock) jsonStr = jsonBlock[1];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;

  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    // Attempt repair: try bare array [...] first
    const arrStart = jsonStr.indexOf('[');
    const arrEnd = jsonStr.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
      try {
        const arr = JSON.parse(jsonStr.substring(arrStart, arrEnd + 1));
        if (Array.isArray(arr)) {
          console.warn('[Extraction] Parsed response as bare JSON array');
          parsed = { figures: arr };
        }
      } catch { /* continue to brace-based repair */ }
    }

    if (!parsed) {
      // Attempt repair: find first { to last }
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start === -1 || end === -1) {
        console.error('[Extraction] No valid JSON found in response. Raw (first 500 chars):', jsonStr.slice(0, 500));
        return [];
      }
      try {
        parsed = JSON.parse(jsonStr.substring(start, end + 1));
      } catch {
        console.error('[Extraction] Failed to parse JSON response. Raw (first 500 chars):', jsonStr.slice(0, 500));
        return [];
      }
    }
  }

  // Recovery: check for alternative response shapes from weak/free models
  if (!parsed?.figures || !Array.isArray(parsed.figures)) {
    // 1. Model used a different top-level key name
    const altKeys = ['results', 'elements', 'data', 'images', 'items', 'visual_elements', 'extractions'];
    for (const key of altKeys) {
      if (Array.isArray(parsed?.[key])) {
        console.warn(`[Extraction] Response used "${key}" instead of "figures" — adapting`);
        parsed = { figures: parsed[key] };
        break;
      }
    }

    // 2. Model returned a bare JSON array (no wrapping object)
    if ((!parsed?.figures || !Array.isArray(parsed.figures)) && Array.isArray(parsed)) {
      console.warn('[Extraction] Response is a bare array — wrapping as figures');
      parsed = { figures: parsed };
    }

    // 3. Model returned a single figure object without array wrapping
    if ((!parsed?.figures || !Array.isArray(parsed.figures)) && parsed?.page && (Array.isArray(parsed?.region) || Array.isArray(parsed?.box_2d))) {
      console.warn('[Extraction] Response is a single figure object — wrapping');
      parsed = { figures: [parsed] };
    }
  }

  if (!parsed?.figures || !Array.isArray(parsed.figures)) {
    console.error('[Extraction] Response missing "figures" array');
    return [];
  }

  // Validate, clamp, sanity-check, and assign IDs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const figures = parsed.figures as Array<any>;
  return figures
    .filter(f => {
      if (!f.page || f.page <= 0) return false;
      // Accept either box_2d (new Gemini native) or region (legacy)
      const hasBox2d = Array.isArray(f.box_2d) && f.box_2d.length === 4;
      const hasRegion = Array.isArray(f.region) && f.region.length === 4;
      return hasBox2d || hasRegion;
    })
    .map((f, i) => {
      let region: number[];

      if (Array.isArray(f.box_2d) && f.box_2d.length === 4) {
        // Convert Gemini native box_2d [y_min, x_min, y_max, x_max] @ 0-1000
        // → internal region [left, top, right, bottom] @ 0-1
        const [yMin, xMin, yMax, xMax] = f.box_2d;
        region = [xMin / 1000, yMin / 1000, xMax / 1000, yMax / 1000];
      } else {
        // Legacy format: region [left, top, right, bottom] @ 0-1
        region = f.region;
      }

      const clamped = clampRegion(region);

      // Sanity check: warn about suspiciously tall regions (likely includes body text)
      const regionHeight = clamped[3] - clamped[1];
      if (regionHeight > 0.60) {
        console.warn(`[Extraction] ⚠️ ${f.label || f.kind} on page ${f.page}: region height ${(regionHeight * 100).toFixed(0)}% is suspiciously large — trimming bottom`);
        // Trim from bottom to cap at 55% of page height
        clamped[3] = Math.min(clamped[3], clamped[1] + 0.55);
      }

      return {
        id: `ef_${i + 1}`,
        kind: validateKind(f.kind),
        page: f.page,
        region: clamped,
        label: f.label || undefined,
        description: f.description || `${f.kind} on page ${f.page}`,
      };
    });
}

function validateKind(kind: string): ExtractedFigure['kind'] {
  const valid: ExtractedFigure['kind'][] = ['figure', 'table', 'equation', 'diagram', 'chart', 'photo', 'algorithm'];
  return valid.includes(kind as ExtractedFigure['kind']) ? kind as ExtractedFigure['kind'] : 'figure';
}

/** Padding added to each side of detected regions (fraction of page dimension).
 *  Asymmetric: bottom gets ZERO padding because the extraction model consistently
 *  over-estimates the bottom coordinate (includes captions, body text). */
const REGION_PAD = 0.01;  // ~10px padding for top/left/right
const REGION_PAD_BOTTOM = 0.0;  // no extra padding on bottom — model already over-estimates

function clampRegion(region: number[]): [number, number, number, number] {
  return [
    Math.max(0, Math.min(1, region[0] - REGION_PAD)),        // left  — expand left
    Math.max(0, Math.min(1, region[1] - REGION_PAD)),        // top   — expand up
    Math.max(0, Math.min(1, region[2] + REGION_PAD)),        // right — expand right
    Math.max(0, Math.min(1, region[3] + REGION_PAD_BOTTOM)), // bottom — no extra padding
  ];
}

// ── Compress crop for API use ─────────────────────────────────

/** Max figures to send to the presentation LLM */
export const MAX_API_FIGURES = 20;

/**
 * Compress a high-res crop data URL to a smaller JPEG for API transmission.
 * Resizes to max 800px on longest side and uses JPEG 70% quality.
 */
function compressCropForApi(dataURL: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX_DIM = 800;
      let w = img.width;
      let h = img.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        const scale = MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.70));
    };
    img.onerror = () => resolve(dataURL); // fallback to original
    img.src = dataURL;
  });
}

// ── Native XObject matching ───────────────────────────────────

/** Figure kinds eligible for native XObject matching (raster images).
 *  Tables, equations, and algorithms are drawn with paths/text — not XObjects. */
const XOBJECT_ELIGIBLE_KINDS = new Set(['figure', 'diagram', 'chart', 'photo']);

const IOU_THRESHOLD = 0.30;
const CONTAINMENT_THRESHOLD = 0.70;

/** Intersection over Union of two normalized bounding boxes */
function computeIoU(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const interLeft = Math.max(a[0], b[0]);
  const interTop = Math.max(a[1], b[1]);
  const interRight = Math.min(a[2], b[2]);
  const interBottom = Math.min(a[3], b[3]);

  if (interRight <= interLeft || interBottom <= interTop) return 0;

  const interArea = (interRight - interLeft) * (interBottom - interTop);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);

  return interArea / (areaA + areaB - interArea);
}

/** What fraction of the XObject's area falls inside the figure region */
function xobjectContainedRatio(
  xobj: [number, number, number, number],
  figRegion: [number, number, number, number],
): number {
  const interLeft = Math.max(xobj[0], figRegion[0]);
  const interTop = Math.max(xobj[1], figRegion[1]);
  const interRight = Math.min(xobj[2], figRegion[2]);
  const interBottom = Math.min(xobj[3], figRegion[3]);

  if (interRight <= interLeft || interBottom <= interTop) return 0;

  const interArea = (interRight - interLeft) * (interBottom - interTop);
  const xobjArea = (xobj[2] - xobj[0]) * (xobj[3] - xobj[1]);

  return xobjArea > 0 ? interArea / xobjArea : 0;
}

/** Find the best-matching native XObject for a figure's bounding box */
function findBestXObjectMatch(
  figRegion: [number, number, number, number],
  xobjects: NativeXObject[],
): NativeXObject | null {
  let bestMatch: NativeXObject | null = null;
  let bestScore = 0;

  for (const xobj of xobjects) {
    const iou = computeIoU(figRegion, xobj.normalizedBBox);
    const containment = xobjectContainedRatio(xobj.normalizedBBox, figRegion);

    // Score: prefer IoU, but accept high containment
    const score = Math.max(iou, containment * 0.8);

    if (score > bestScore && (iou >= IOU_THRESHOLD || containment >= CONTAINMENT_THRESHOLD)) {
      bestScore = score;
      bestMatch = xobj;
    }
  }

  return bestMatch;
}

// ── Pre-crop extracted figures (hybrid: native XObject + canvas fallback) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function preCropExtractedFigures(
  figures: ExtractedFigure[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc: any,
  cache: Record<string, string>,
): Promise<ExtractedFigure[]> {
  // Cap at MAX_API_FIGURES to keep payload reasonable
  const capped = figures.slice(0, MAX_API_FIGURES);
  if (figures.length > MAX_API_FIGURES) {
    console.log(`[Extraction] Capping figures from ${figures.length} to ${MAX_API_FIGURES}`);
  }

  // Cache XObjects per page to avoid redundant getOperatorList() calls
  const xobjCache = new Map<number, NativeXObject[]>();
  const results: ExtractedFigure[] = [];
  let nativeCount = 0;
  let canvasCount = 0;

  for (const fig of capped) {
    let croppedDataURL: string | null = null;

    // ── Try native XObject extraction for eligible kinds ──
    if (XOBJECT_ELIGIBLE_KINDS.has(fig.kind)) {
      // Extract XObjects for this page (cached)
      if (!xobjCache.has(fig.page)) {
        try {
          const page = await pdfDoc.getPage(fig.page);
          const xobjects = await extractPageXObjects(page);
          xobjCache.set(fig.page, xobjects);
        } catch (e) {
          console.warn(`[Extraction] XObject extraction failed for page ${fig.page}:`, e);
          xobjCache.set(fig.page, []);
        }
      }

      const pageXObjects = xobjCache.get(fig.page) || [];
      const match = findBestXObjectMatch(
        fig.region as [number, number, number, number],
        pageXObjects,
      );

      if (match) {
        try {
          const page = await pdfDoc.getPage(fig.page);
          // Resolve image data from page objects
          const imgData = await new Promise((resolve, reject) => {
            page.objs.get(match.objId, resolve);
            // Timeout fallback — some objects may not resolve
            setTimeout(() => reject(new Error('timeout')), 3000);
          });
          if (imgData) {
            const dataURL = xobjectToDataURL(imgData);
            if (dataURL) {
              croppedDataURL = dataURL;
              nativeCount++;
              console.log(
                `[Extraction] ✓ Native XObject for ${fig.id} (${fig.label || fig.kind}) — ` +
                `${match.width}×${match.height}px (IoU with Gemini box: ${computeIoU(fig.region as [number,number,number,number], match.normalizedBBox).toFixed(2)})`,
              );
            }
          }
        } catch (e) {
          console.warn(`[Extraction] Failed to resolve XObject ${match.objId} for ${fig.id}:`, e);
        }
      }
    }

    // ── Fallback: canvas crop ──
    if (!croppedDataURL) {
      const resolved = resolveRegion(fig.region);
      croppedDataURL = await cropPdfFigure(pdfDoc, fig.page, resolved, cache);
      if (croppedDataURL) canvasCount++;
    }

    let apiDataURL: string | undefined;
    if (croppedDataURL) {
      apiDataURL = await compressCropForApi(croppedDataURL);
    }

    results.push({
      ...fig,
      croppedDataURL: croppedDataURL || undefined,
      apiDataURL,
    });
  }

  console.log(`[Extraction] Pre-crop complete: ${nativeCount} native XObject, ${canvasCount} canvas crop, ${results.length - nativeCount - canvasCount} failed`);
  return results;
}

// ── Catalog builder (for Pass 2 system prompt) ───────────────

export function buildExtractedFigureCatalog(figures: ExtractedFigure[]): string {
  if (figures.length === 0) return '';

  const lines = figures.map(f => {
    const regionStr = f.region.map(n => n.toFixed(2)).join(', ');
    return `  - ${f.id}: ${f.label || f.kind} (page ${f.page}, [${regionStr}]) — ${f.description}`;
  });

  return `EXTRACTED FIGURE CATALOG (${figures.length} visual elements pre-identified):
${lines.join('\n')}

To use these in slides: {"type": "extracted_ref", "extractedId": "ef_1", "label": "Your description"}
You may also use "pdf_crop" with manual coordinates for regions not in the catalog, or "svg" for custom diagrams.`;
}

// ── Label hints (correlates text labels with pages) ──────────

function extractLabelHints(textPages: string[], maxPage: number): string | null {
  const hints = parseLabelHintsStructured(textPages, maxPage);
  if (hints.length === 0) return null;
  return hints.map(h => `${h.label} → page ${h.page}`).join('\n');
}

// ── Structured label hint parsing ─────────────────────────────

interface ParsedLabelHint {
  label: string;
  normalizedLabel: string;
  kind: ExtractedFigure['kind'];
  page: number;
  captionText?: string;  // Full caption text extracted from PDF (e.g., "The average fraction of unconnectable peers...")
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/^fig\.\s*/i, 'figure ')
    .replace(/^eq\.\s*/i, 'equation ')
    .replace(/\s+/g, ' ')
    .trim();
}

function kindFromLabelType(type: string): ExtractedFigure['kind'] {
  const t = type.toLowerCase();
  if (t.startsWith('table')) return 'table';
  if (t.startsWith('eq')) return 'equation';
  if (t.startsWith('scheme') || t.startsWith('chart')) return 'chart';
  if (t.startsWith('algorithm') || t.startsWith('box')) return 'algorithm';
  return 'figure';
}

/**
 * Parse text pages to find labeled visual elements (Figure N, Table N, etc.)
 * with their page numbers. Prefers caption occurrences over forward references.
 */
function parseLabelHintsStructured(textPages: string[], maxPage: number): ParsedLabelHint[] {
  const hintMap = new Map<string, ParsedLabelHint & { isCaption: boolean; isStrongCaption: boolean }>();
  const labelPattern = /\b((?:Supplementary\s+)?(?:Figure|Fig\.|Table|Equation|Eq\.|Scheme|Chart|Plate|Box|Algorithm))\s*\.?\s*(\d+[a-zA-Z]?(?:\.\d+)?|[IVXLC]+)/gi;
  const refPreamble = /\b(?:see|in|from|shown|cf\.?|refer|as|the|and|of)\s*$/i;

  const limit = Math.min(textPages.length, maxPage);
  for (let i = 0; i < limit; i++) {
    if (!textPages[i]) continue;
    for (const m of textPages[i].matchAll(labelPattern)) {
      const rawType = m[1].replace(/\.$/, '');
      const label = `${rawType} ${m[2]}`;
      const nLabel = normalizeLabel(label);
      const preCtx = textPages[i].slice(Math.max(0, (m.index || 0) - 30), m.index || 0);
      const postCtx = textPages[i].slice((m.index || 0) + m[0].length, (m.index || 0) + m[0].length + 20);
      const isRef = refPreamble.test(preCtx);
      // A true caption has punctuation after the label: "Figure 3." / "Figure 3:" / "Figure 3 —"
      // Body text references have verbs: "Figure 3 shows" / "Figure 3 depicts" / "Figure 3 is"
      const hasCaptionPunctuation = /^[\s]*[.:\-—]/.test(postCtx);
      const hasVerbAfter = /^[\s]+(shows?|depicts?|illustrates?|presents?|plots?|displays?|compares?|gives?|provides?|is|are|was|were|has|have|can|will|demonstrate)\b/i.test(postCtx);
      // Strong caption: has punctuation after label (like "Figure 3. ...")
      // Weak caption: not a reference, not followed by a verb (could be either)
      const isStrongCaption = !isRef && hasCaptionPunctuation;
      const isCaption = !isRef && !hasVerbAfter;
      // Extract caption text when this is a caption occurrence (not a forward reference)
      let captionText: string | undefined;
      if (isCaption) {
        const labelEnd = (m.index || 0) + m[0].length;
        const after = textPages[i].slice(labelEnd, labelEnd + 300);
        // Strip leading punctuation: . : — - and whitespace
        const stripped = after.replace(/^[\s.:\-—]+/, '');
        // Take the first sentence (up to ~200 chars, ending at period + whitespace or double newline)
        const firstSentence = stripped.match(/^([\s\S]{10,200}?)(?:\.\s|\.\n|\n\n)/);
        captionText = firstSentence ? firstSentence[1].trim() : stripped.slice(0, 150).trim();
        // Clean up: remove trailing period
        if (captionText.endsWith('.')) captionText = captionText.slice(0, -1);
        // Skip if it looks like body text (too short or starts with lowercase after stripping)
        if (captionText.length < 5) captionText = undefined;
      }

      const existing = hintMap.get(nLabel);
      // Priority: strong caption (has .:— after label) > weak caption > reference
      // This ensures "Figure 3. The average fraction..." on page 4 beats
      // "Figure 3 shows the average..." on page 3
      const dominated = !existing
        || (isCaption && !existing.isCaption)                            // caption beats reference
        || (isStrongCaption && existing.isCaption && !existing.isStrongCaption)  // strong beats weak
        || (isStrongCaption && existing.isStrongCaption && captionText && !existing.captionText); // both strong: prefer one with text
      if (dominated) {
        hintMap.set(nLabel, {
          label,
          normalizedLabel: nLabel,
          kind: kindFromLabelType(rawType),
          page: i + 1,
          isCaption,
          isStrongCaption,
          captionText,
        });
      }
    }
  }

  const results = Array.from(hintMap.values()).map(({ label, normalizedLabel, kind, page, isStrongCaption, captionText }) => {
    console.log(`[LabelHint] ${label} → page ${page} (${isStrongCaption ? 'strong caption' : 'weak caption/ref'}${captionText ? ', text: "' + captionText.slice(0, 50) + '..."' : ''})`);
    return { label, normalizedLabel, kind, page, captionText };
  });

  // Remove sub-labels (e.g., "Table 1a", "Figure 2b") when parent label exists (e.g., "Table 1", "Figure 2").
  // Sub-tables/sub-figures are visually part of the parent element — extracting them separately
  // leads to degenerate bboxes and wastes a recovery pass.
  const allNormLabels = new Set(results.map(h => h.normalizedLabel));
  const filtered = results.filter(hint => {
    const subMatch = hint.normalizedLabel.match(/^(.+\s+\d+)[a-z]$/);
    if (subMatch) {
      const parentNorm = subMatch[1];
      if (allNormLabels.has(parentNorm)) {
        console.log(`[LabelHint] Skipping sub-label "${hint.label}" — parent "${parentNorm}" exists`);
        return false;
      }
    }
    return true;
  });

  return filtered;
}

// ── Recovery pass for missing elements ────────────────────────

const RECOVERY_PROMPT = `Detect the 2D bounding boxes of the specific visual elements described below.

CRITICAL: A "figure" is a VISUAL/GRAPHICAL element (graph, chart, plot, diagram, photo). Do NOT select body text paragraphs that merely mention or discuss the figure.

Output box_2d as [y_min, x_min, y_max, x_max] where coordinates are integers normalized to 0–1000 scale.

For TABLES:
- Full page width: x_min ≈ 0, x_max ≈ 1000
- Include the table title at top, end at last data row
- Tables may have NO visible borders — detect by columnar alignment and horizontal rules

For FIGURES/CHARTS/DIAGRAMS:
- Crop tightly around visual content
- Exclude captions below

Output ONLY valid JSON:
{"figures": [{"kind": "...", "page": N, "box_2d": [y_min, x_min, y_max, x_max], "label": "...", "description": "..."}]}`;

/**
 * Targeted recovery pass: for each missing labeled element, send just its page
 * to Gemini with a focused prompt. If that also fails, synthesize a fallback
 * entry with a default region (canvas crop + auto-trim will clean it up).
 */
async function recoverMissingElements(
  missingHints: ParsedLabelHint[],
  thumbnails: string[],
  existingFigures: ExtractedFigure[],
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<ExtractedFigure[]> {
  if (missingHints.length === 0) return existingFigures;

  console.log(
    `[Extraction] Recovery pass: attempting to find ${missingHints.length} missing element(s) — ` +
    missingHints.map(m => m.label).join(', '),
  );

  // Build a single batched recovery call with only the pages that have missing items
  const byPage = new Map<number, ParsedLabelHint[]>();
  for (const hint of missingHints) {
    const list = byPage.get(hint.page) || [];
    list.push(hint);
    byPage.set(hint.page, list);
  }

  const recovered: ExtractedFigure[] = [];

  // Build checklist + multi-page message (single API call)
  const recoveryBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  const checklist = missingHints.map(h => `- ${h.label} (type: ${h.kind}) → page ${h.page}`).join('\n');
  recoveryBlocks.push({
    type: 'text',
    text: `Find these specific elements:\n${checklist}\n\nThese are CONFIRMED to exist based on text analysis. Look carefully — tables may have no visible borders, only horizontal rules or columnar alignment.`,
  });

  const sortedPages = [...byPage.keys()].sort((a, b) => a - b);
  // Resize thumbnails to 640px max for better bbox accuracy
  const recoveryThumbs = await Promise.all(
    sortedPages.map(async (pageNum) => {
      if (pageNum < 1 || pageNum > thumbnails.length || !thumbnails[pageNum - 1]) return { pageNum, thumb: '' };
      const thumb = await resizeForExtraction(thumbnails[pageNum - 1]);
      return { pageNum, thumb };
    }),
  );
  for (const { pageNum, thumb } of recoveryThumbs) {
    if (!thumb) continue;
    recoveryBlocks.push({ type: 'text', text: `--- Page ${pageNum} ---` });
    recoveryBlocks.push({ type: 'image_url', image_url: { url: thumb } });
  }

  try {
    const { content: raw } = await callChat({
      messages: [{ role: 'user' as const, content: recoveryBlocks }],
      model,
      max_tokens: 4096,
      system: RECOVERY_PROMPT,
      temperature: 0,
    }, apiKey, signal);

    const parsed = parseExtractionResponse(raw);
    for (const fig of parsed) {
      // If model returned a page not in our set, find closest match
      if (!byPage.has(fig.page)) {
        const hintForLabel = fig.label
          ? missingHints.find(h => normalizeLabel(h.label) === normalizeLabel(fig.label!))
          : null;
        if (hintForLabel) fig.page = hintForLabel.page;
      }

      // Validate region has reasonable dimensions (at least 5% of page each way)
      const regionW = fig.region[2] - fig.region[0];
      const regionH = fig.region[3] - fig.region[1];
      if (regionW < 0.05 || regionH < 0.05) {
        console.warn(
          `[Extraction] ✗ Recovered ${fig.label || fig.kind} has degenerate region ` +
          `[${fig.region.map(n => n.toFixed(2)).join(', ')}] (${(regionW * 100).toFixed(0)}%×${(regionH * 100).toFixed(0)}%) — discarding, will use fallback`,
        );
        continue;
      }

      recovered.push(fig);
      console.log(`[Extraction] ✓ Recovered ${fig.label || fig.kind} on page ${fig.page} region=[${fig.region.map(n => n.toFixed(2)).join(', ')}]`);
    }
  } catch (e) {
    console.warn(`[Extraction] Recovery API call failed:`, e);
  }

  // Check if any hints are STILL missing after recovery pass
  const allFoundLabels = new Set([
    ...existingFigures.filter(f => f.label).map(f => normalizeLabel(f.label!)),
    ...recovered.filter(f => f.label).map(f => normalizeLabel(f.label!)),
  ]);

  for (const hint of missingHints) {
    if (allFoundLabels.has(hint.normalizedLabel)) continue;

    // Synthesize a fallback entry with a default region
    const defaultRegion: [number, number, number, number] = hint.kind === 'table'
      ? [0.0, 0.15, 1.0, 0.85]    // full-width, generous vertical range
      : [0.05, 0.10, 0.95, 0.85]; // padded margins

    recovered.push({
      id: '', // will be reassigned below
      kind: hint.kind,
      page: hint.page,
      region: defaultRegion,
      label: hint.label,
      description: `${hint.label} (auto-recovered — not detected by vision model)`,
    });
    console.warn(
      `[Extraction] ⚠ Synthesized fallback for ${hint.label} on page ${hint.page} with default region`,
    );
  }

  if (recovered.length > 0) {
    console.log(`[Extraction] Recovery complete: ${recovered.length} element(s) recovered`);
  }

  // Merge, sort by page then vertical position, and reassign IDs
  const merged = [...existingFigures, ...recovered];
  merged.sort((a, b) => a.page - b.page || a.region[1] - b.region[1]);
  merged.forEach((f, i) => { f.id = `ef_${i + 1}`; });

  return merged;
}
