/**
 * Lightweight SVG post-processing for common weak-model issues.
 * Safe, non-destructive transforms that won't break well-formed SVGs.
 */

/**
 * Sanitize an SVG string: enforce viewBox, minimum font sizes, and xmlns.
 */
export function sanitizeSvg(svgStr: string): string {
  let svg = svgStr;

  // 1. xmlns enforcement — add if missing
  if (/<svg\b/i.test(svg) && !/<svg[^>]*xmlns\s*=/i.test(svg)) {
    svg = svg.replace(/<svg\b/i, "<svg xmlns='http://www.w3.org/2000/svg'");
  }

  // 2. viewBox enforcement — add from width/height if missing, ensure minimum 800×500
  if (/<svg\b/i.test(svg) && !/<svg[^>]*viewBox\s*=/i.test(svg)) {
    const wMatch = svg.match(/<svg[^>]*\bwidth\s*=\s*['"]?(\d+)/i);
    const hMatch = svg.match(/<svg[^>]*\bheight\s*=\s*['"]?(\d+)/i);
    const w = wMatch ? Math.max(Number(wMatch[1]), 800) : 800;
    const h = hMatch ? Math.max(Number(hMatch[1]), 500) : 500;
    svg = svg.replace(/<svg\b/i, `<svg viewBox='0 0 ${w} ${h}'`);
  }

  // 3. Font-size floor — bump any font-size below 11px to 13px
  //    Handles: font-size='8', font-size="10px", font-size:9px, font-size: 7
  svg = svg.replace(
    /font-size\s*[:=]\s*['"]?\s*(\d+(?:\.\d+)?)\s*(px)?\s*['"]?/gi,
    (match, size, unit) => {
      const numSize = parseFloat(size);
      if (numSize < 11) {
        return match.replace(size + (unit || ''), '13' + (unit || 'px'));
      }
      return match;
    },
  );

  return svg;
}
