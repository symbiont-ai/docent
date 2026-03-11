// ==========================================================
// DOCENT — PDF Utility Functions
// ==========================================================

// Named region presets for PDF cropping
export const REGION_PRESETS: Record<string, number[]> = {
  full_page:     [0, 0, 1, 1],
  top_half:      [0, 0, 1, 0.5],
  bottom_half:   [0, 0.5, 1, 1],
  top_third:     [0, 0, 1, 0.33],
  middle_third:  [0, 0.33, 1, 0.66],
  bottom_third:  [0, 0.66, 1, 1],
  top_quarter:   [0, 0, 1, 0.25],
  upper_quarter: [0, 0.25, 1, 0.5],
  lower_quarter: [0, 0.5, 1, 0.75],
  bottom_quarter:[0, 0.75, 1, 1],
  top_left:      [0, 0, 0.5, 0.5],
  top_right:     [0.5, 0, 1, 0.5],
  bottom_left:   [0, 0.5, 0.5, 1],
  bottom_right:  [0.5, 0.5, 1, 1],
  left_half:     [0, 0, 0.5, 1],
  right_half:    [0.5, 0, 1, 1],
  left_column:   [0, 0, 0.48, 1],
  right_column:  [0.52, 0, 1, 1],
  center:        [0.1, 0.15, 0.9, 0.85],
  title_area:    [0, 0, 1, 0.15],
  header:        [0, 0, 1, 0.12],
  left_col_top:     [0, 0, 0.48, 0.5],
  left_col_bottom:  [0, 0.5, 0.48, 1],
  right_col_top:    [0.52, 0, 1, 0.5],
  right_col_bottom: [0.52, 0.5, 1, 1],
};

export const resolveRegion = (region: number[] | string | undefined): number[] => {
  if (!region) return [0, 0, 1, 1];
  if (typeof region === 'string') {
    return REGION_PRESETS[region] || REGION_PRESETS.full_page;
  }
  if (Array.isArray(region) && region.length === 4) return region;
  return [0, 0, 1, 1];
};

// Crop a figure from PDF — with pixel-scanning auto-trim
// Uses adaptive scale: smaller crop regions get higher render scale
// to ensure the final cropped image has enough pixels for crisp display.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cropPdfFigure = async (
  doc: any, // PDFDocumentProxy
  pageNum: number,
  region: number[],
  cache: Record<string, string>,
): Promise<string | null> => {
  if (!doc) return null;
  const key = `${pageNum}-${JSON.stringify(region)}`;
  if (cache[key]) return cache[key];
  try {
    const page = await doc.getPage(pageNum);

    // Adaptive scale: target at least ~2000px on the longest edge of the crop.
    // For full-page crops (region area ~1.0), scale=4.0 gives ~3400px wide.
    // For small crops (e.g. 25% of page area), we boost the scale so the
    // cropped region still has enough pixels for a crisp PPTX/HTML embed.
    const [l, t, r, b] = region;
    const regionW = r - l;
    const regionH = b - t;
    const regionArea = regionW * regionH;
    const baseScale = 4.0;
    // For a full page (area=1), use baseScale. For a quarter page (area=0.25),
    // boost ~2×. Capped at 8.0 to prevent excessive memory usage.
    const adaptiveScale = Math.min(8.0, baseScale / Math.sqrt(Math.max(regionArea, 0.04)));
    const scale = Math.max(baseScale, adaptiveScale);

    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;

    const cropX = Math.floor(l * canvas.width);
    const cropY = Math.floor(t * canvas.height);
    const cropW = Math.max(1, Math.floor(regionW * canvas.width));
    const cropH = Math.max(1, Math.floor(regionH * canvas.height));

    // Guard against degenerate regions (e.g., zero-height from bad bounding boxes)
    if (cropW < 5 || cropH < 5) {
      console.warn(`[PDF] Crop region too small: ${cropW}×${cropH}px — skipping`);
      return null;
    }

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropW; cropCanvas.height = cropH;
    const cropCtx = cropCanvas.getContext('2d')!;
    cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    // Auto-trim whitespace
    const imageData = cropCtx.getImageData(0, 0, cropW, cropH);
    const pixels = imageData.data;
    const whiteThreshold = 245;
    let minX = cropW, minY = cropH, maxX = 0, maxY = 0;

    for (let y = 0; y < cropH; y += 4) {
      for (let x = 0; x < cropW; x += 4) {
        const i = (y * cropW + x) * 4;
        const rv = pixels[i], g = pixels[i + 1], bv = pixels[i + 2];
        if (rv < whiteThreshold || g < whiteThreshold || bv < whiteThreshold) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    const marginX = Math.floor(cropW * 0.02);
    const marginY = Math.floor(cropH * 0.02);
    minX = Math.max(0, minX - marginX);
    minY = Math.max(0, minY - marginY);
    maxX = Math.min(cropW - 1, maxX + marginX);
    maxY = Math.min(cropH - 1, maxY + marginY);

    const trimmedW = maxX - minX + 1;
    const trimmedH = maxY - minY + 1;

    let finalDataURL: string;
    if (trimmedW > 20 && trimmedH > 20 && (trimmedW * trimmedH) < (cropW * cropH * 0.85)) {
      const trimCanvas = document.createElement('canvas');
      trimCanvas.width = trimmedW; trimCanvas.height = trimmedH;
      trimCanvas.getContext('2d')!.drawImage(cropCanvas, minX, minY, trimmedW, trimmedH, 0, 0, trimmedW, trimmedH);
      finalDataURL = trimCanvas.toDataURL('image/png');
    } else {
      finalDataURL = cropCanvas.toDataURL('image/png');
    }

    cache[key] = finalDataURL;
    return finalDataURL;
  } catch (e) {
    console.error('PDF crop failed:', e);
    return null;
  }
};

// ── Native XObject (embedded image) extraction ─────────────

/** Minimum native pixel dimensions — skip icons, logos, tiny decorations */
const MIN_XOBJECT_DIM = 50;
/** Minimum rendered size on page (in CSS px at scale=1) */
const MIN_RENDERED_DIM = 30;

export interface NativeXObject {
  objId: string;
  width: number;
  height: number;
  normalizedBBox: [number, number, number, number]; // [left, top, right, bottom] 0-1
}

/** 6-element PDF matrix multiplication: M1 × M2 */
function multiplyMatrices(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** Transform a 2D point through a 6-element PDF matrix */
function applyTransform(p: [number, number], m: number[]): [number, number] {
  return [
    p[0] * m[0] + p[1] * m[2] + m[4],
    p[0] * m[1] + p[1] * m[3] + m[5],
  ];
}

/**
 * Extract embedded raster images (XObjects) from a single PDF page.
 * Tracks the transformation matrix stack to compute each image's
 * normalized bounding box on the page (0-1 coordinates).
 *
 * Returns only "significant" images (above minimum size thresholds),
 * skipping tiny icons, logos, and decorations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function extractPageXObjects(page: any): Promise<NativeXObject[]> {
  const { OPS } = await import('pdfjs-dist');
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;

  // Page dimensions at scale=1 (CSS pixels)
  const vp = page.getViewport({ scale: 1 });
  const pageW = vp.width;
  const pageH = vp.height;

  // CTM stack — initialize with viewport transform (PDF space → screen space)
  let ctm = [...vp.transform] as number[];
  const ctmStack: number[][] = [];
  const results: NativeXObject[] = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    switch (fn) {
      case OPS.save:
        ctmStack.push([...ctm]);
        break;

      case OPS.restore:
        if (ctmStack.length > 0) ctm = ctmStack.pop()!;
        break;

      case OPS.transform: {
        const [a, b, c, d, e, f] = args;
        ctm = multiplyMatrices(ctm, [a, b, c, d, e, f]);
        break;
      }

      case OPS.paintImageXObject: {
        // args = [objId, width, height]
        const [objId, w, h] = args;
        if (w < MIN_XOBJECT_DIM || h < MIN_XOBJECT_DIM) break;

        // Image occupies a 1×1 unit square in current coordinate space.
        // Transform all 4 corners through CTM for axis-aligned bounding box.
        const p0 = applyTransform([0, 0], ctm);
        const p1 = applyTransform([1, 0], ctm);
        const p2 = applyTransform([0, 1], ctm);
        const p3 = applyTransform([1, 1], ctm);

        const xs = [p0[0], p1[0], p2[0], p3[0]];
        const ys = [p0[1], p1[1], p2[1], p3[1]];
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        // Skip if rendered too small on page
        if ((maxX - minX) < MIN_RENDERED_DIM || (maxY - minY) < MIN_RENDERED_DIM) break;

        // Normalize to 0-1 range
        const bbox: [number, number, number, number] = [
          Math.max(0, minX / pageW),
          Math.max(0, minY / pageH),
          Math.min(1, maxX / pageW),
          Math.min(1, maxY / pageH),
        ];

        results.push({ objId, width: w, height: h, normalizedBBox: bbox });
        break;
      }

      case OPS.paintFormXObjectBegin: {
        // Form XObject: save CTM and apply form's transformation matrix
        ctmStack.push([...ctm]);
        if (args[0]) {
          ctm = multiplyMatrices(ctm, args[0]);
        }
        break;
      }

      case OPS.paintFormXObjectEnd: {
        if (ctmStack.length > 0) ctm = ctmStack.pop()!;
        break;
      }

      default:
        break;
    }
  }

  if (results.length > 0) {
    console.log(`[XObject] Page ${page.pageNumber}: found ${results.length} embedded images`);
  }
  return results;
}

/**
 * Convert a pdf.js image object (from page.objs.get()) to a PNG data URL.
 * Handles both ImageBitmap and raw pixel data (RGB_24BPP, RGBA_32BPP).
 * Returns empty string for unsupported formats (e.g. grayscale masks).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function xobjectToDataURL(imgData: any): string {
  if (!imgData || (!imgData.bitmap && !imgData.data)) return '';

  const canvas = document.createElement('canvas');
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  const ctx = canvas.getContext('2d')!;

  try {
    if (imgData.bitmap) {
      // ImageBitmap path — browser-decoded image
      ctx.drawImage(imgData.bitmap, 0, 0);
    } else if (imgData.data) {
      const imageData = ctx.createImageData(imgData.width, imgData.height);

      if (imgData.kind === 3 /* RGBAImage / RGBA_32BPP */) {
        imageData.data.set(imgData.data);
      } else if (imgData.kind === 2 /* RGB_24BPP */) {
        // Convert RGB → RGBA
        const src = imgData.data;
        const dst = imageData.data;
        for (let si = 0, di = 0; si < src.length; si += 3, di += 4) {
          dst[di] = src[si];
          dst[di + 1] = src[si + 1];
          dst[di + 2] = src[si + 2];
          dst[di + 3] = 255;
        }
      } else {
        // Grayscale 1BPP or unknown — likely masks, not figures
        return '';
      }

      ctx.putImageData(imageData, 0, 0);
    }

    return canvas.toDataURL('image/png');
  } catch (e) {
    console.warn('[XObject] Failed to convert image to data URL:', e);
    return '';
  }
}
