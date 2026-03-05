// ==========================================================
// DOCENT — Figure Extraction (Pass 1)
// Cheap vision model analyzes PDF thumbnails to locate figures,
// tables, equations, and diagrams with bounding boxes.
// ==========================================================

import { callChat } from '@/src/lib/api';
import { cropPdfFigure, resolveRegion } from '@/src/lib/pdf-utils';
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
  /\bsupplementary\s+(information|material|data|methods|figures|tables)\b/i,
  /\bsupporting\s+information\b/i,
  /\bappendix\b/i,
  /\bsi\s+materials?\b/i,
  /\bsupplemental\s+(material|data|methods|figures)\b/i,
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

// ── Extraction system prompt ─────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a precision document layout analyst. Examine the provided PDF page images and identify ALL visual elements: figures, tables, algorithms, equations, diagrams, charts, and photographs.

For EACH visual element, output its location as a normalized bounding box [left, top, right, bottom] where each value is 0.0 to 1.0 representing the fraction of page width/height.

BOUNDING BOX PRECISION — THIS IS THE MOST IMPORTANT PART:
- Each coordinate must be estimated to 2 decimal places (e.g. 0.32, not 0.3)
- The region MUST tightly wrap ONLY the visual element — nothing else
- NEVER include body text paragraphs, captions, or section headers in the region
- The bottom coordinate is consistently the biggest source of errors — estimate it CONSERVATIVELY (higher up on the page than you think)

COMMON MISTAKES TO AVOID:
❌ Including the "Fig. 1. Description..." caption below a figure — WRONG, stop ABOVE the caption
❌ Including body text paragraphs that appear below a table — WRONG, stop at the last row
❌ Including "IV. MEASUREMENT RESULTS" or any section header — WRONG, those are not figures
❌ Combining two separate figures/tables into one bounding box — WRONG, list each separately
❌ Region spanning 60%+ of page height — almost always WRONG (individual figures/tables are typically 20-45% of page height)

TABLE DETECTION:
- TABLES ARE CRITICAL: detect even borderless tables with columnar data, header rows, horizontal rules
- For tables: start from the "Table N" title line, end at the last data row
- Use full page width for tables (left=0.0, right=1.0)
- The bottom coordinate must stop at the last row of data — do NOT include any text below the table

FIGURE DETECTION:
- For figures/charts/diagrams: crop tightly around the visual content only
- Multi-panel figures (A, B, C, D subplots) → ONE bounding box covering all panels
- Exclude the "Fig. N." caption that appears below

- Include the figure/table label if visible (e.g. "Figure 1", "Table 2")
- Write a brief 5-15 word description of what each visual shows

Output ONLY valid JSON:
{
  "figures": [
    {
      "kind": "figure",
      "page": 1,
      "region": [0.05, 0.20, 0.95, 0.55],
      "label": "Figure 1",
      "description": "Bar chart comparing model accuracy across datasets"
    },
    {
      "kind": "table",
      "page": 3,
      "region": [0.0, 0.30, 1.0, 0.58],
      "label": "Table 1",
      "description": "Classification of pooling methods by attention type"
    }
  ]
}

If a page has no visual elements, skip it. Sort by page number, then top-to-bottom.`;

// ── Core extraction function ─────────────────────────────────

export async function extractFiguresFromPdf(
  thumbnails: string[],
  textPages: string[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const extractedAt = Date.now();

  // Detect supplementary boundary
  const suppPage = detectSupplementaryBoundary(textPages);
  const mainBodyEnd = suppPage
    ? Math.min(suppPage - 1, MAX_EXTRACTION_PAGES)
    : Math.min(thumbnails.length, MAX_EXTRACTION_PAGES);

  if (suppPage) {
    console.log(`[Extraction] Main body: pages 1-${mainBodyEnd}, supplementary starts at page ${suppPage}`);
  }

  // Build multi-image message with only main-body pages
  const contentBlocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  contentBlocks.push({
    type: 'text',
    text: `Analyze these ${mainBodyEnd} PDF page images (main body of the paper). Identify ALL figures, tables, equations, diagrams, charts, and photographs. Output JSON only.`,
  });

  for (let i = 0; i < mainBodyEnd; i++) {
    if (thumbnails[i]) {
      contentBlocks.push({
        type: 'text',
        text: `--- Page ${i + 1} ---`,
      });
      contentBlocks.push({
        type: 'image_url',
        image_url: { url: thumbnails[i] },
      });
    }
  }

  // Append text-based label hints for cross-referencing
  const labelHints = extractLabelHints(textPages, mainBodyEnd);
  if (labelHints) {
    contentBlocks.push({
      type: 'text',
      text: `Text-based figure/table labels found in the document:\n${labelHints}\nUse these to verify your label assignments.`,
    });
  }

  const request = {
    messages: [{
      role: 'user' as const,
      content: contentBlocks,
    }],
    model: EXTRACTION_MODEL,
    max_tokens: EXTRACTION_MAX_TOKENS,
    system: EXTRACTION_SYSTEM_PROMPT,
  };

  const raw = await callChat(request, apiKey, signal);
  const figures = parseExtractionResponse(raw);

  console.log(`[Extraction] Found ${figures.length} visual elements across ${mainBodyEnd} pages`);

  return {
    figures,
    model: EXTRACTION_MODEL,
    extractedAt,
    mainBodyPages: mainBodyEnd,
    supplementaryStartPage: suppPage || undefined,
  };
}

// ── JSON parsing with repair ─────────────────────────────────

export function parseExtractionResponse(raw: string): ExtractedFigure[] {
  // Extract JSON from markdown code blocks if present
  let jsonStr = raw;
  const jsonBlock = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlock) jsonStr = jsonBlock[1];

  let parsed: { figures: Array<{
    kind: string; page: number; region: number[]; label?: string; description: string;
  }> };

  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    // Attempt repair: find first { to last }
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[Extraction] No valid JSON found in response');
      return [];
    }
    try {
      parsed = JSON.parse(jsonStr.substring(start, end + 1));
    } catch {
      console.error('[Extraction] Failed to parse JSON response');
      return [];
    }
  }

  if (!parsed?.figures || !Array.isArray(parsed.figures)) {
    console.error('[Extraction] Response missing "figures" array');
    return [];
  }

  // Validate, clamp, sanity-check, and assign IDs
  return parsed.figures
    .filter(f => f.page > 0 && Array.isArray(f.region) && f.region.length === 4)
    .map((f, i) => {
      const clamped = clampRegion(f.region);

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

// ── Pre-crop extracted figures ────────────────────────────────

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

  const results: ExtractedFigure[] = [];

  for (const fig of capped) {
    const resolved = resolveRegion(fig.region);
    const croppedDataURL = await cropPdfFigure(pdfDoc, fig.page, resolved, cache);
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
  const hints: string[] = [];
  const labelPattern = /\b((?:Supplementary\s+)?(?:Figure|Fig\.|Table|Equation|Eq\.|Scheme|Chart|Plate|Box))\s*\.?\s*(\d+[a-zA-Z]?(?:\.\d+)?)/gi;

  const limit = Math.min(textPages.length, maxPage);
  for (let i = 0; i < limit; i++) {
    if (!textPages[i]) continue;
    for (const m of textPages[i].matchAll(labelPattern)) {
      const rawType = m[1].replace(/\.$/, '');
      hints.push(`${rawType} ${m[2]} → page ${i + 1}`);
    }
  }

  // Deduplicate
  const unique = [...new Set(hints)];
  return unique.length > 0 ? unique.join('\n') : null;
}
