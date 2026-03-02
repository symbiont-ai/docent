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
    const cropW = Math.floor(regionW * canvas.width);
    const cropH = Math.floor(regionH * canvas.height);

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
