// ==========================================================
// DOCENT — Export Utilities (PPTX + HTML)
// ==========================================================

import type { Slide, PresentationState } from '@/src/types';
import { COLORS } from './colors';

// Convert SVG content to a data URL image (for PPTX embedding)
export const svgToDataURL = (svgContent: string): Promise<string | null> => {
  return new Promise((resolve) => {
    try {
      let svg = svgContent.trim();
      svg = svg.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/g, '&amp;');

      if (!svg.includes('xmlns=')) {
        svg = svg.replace('<svg', "<svg xmlns='http://www.w3.org/2000/svg'");
      }

      const vbMatch = svg.match(/viewBox\s*=\s*['"]([^'"]+)['"]/i);
      if (vbMatch) {
        const parts = vbMatch[1].trim().split(/[\s,]+/);
        if (parts.length >= 4) {
          const vbW = parseFloat(parts[2]);
          const vbH = parseFloat(parts[3]);
          svg = svg.replace(/^<svg([^>]*)>/, (_match, attrs: string) => {
            const cleaned = attrs.replace(/\bwidth\s*=\s*['"][^'"]*['"]/gi, '').replace(/\bheight\s*=\s*['"][^'"]*['"]/gi, '');
            return `<svg width='${vbW}' height='${vbH}'${cleaned}>`;
          });
        }
      } else if (!svg.match(/^<svg[^>]*\bwidth\s*=/i)) {
        svg = svg.replace('<svg', "<svg width='960' height='540'");
      }

      const renderW = 1920;
      const renderH = 1080;

      const tryRender = (imgSrc: string, fallbackFn?: () => void) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = renderW; canvas.height = renderH;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#1A2332';
            ctx.fillRect(0, 0, renderW, renderH);
            const natW = img.naturalWidth || renderW;
            const natH = img.naturalHeight || renderH;
            const scale = Math.min(renderW / natW, renderH / natH) * 0.9;
            const x = (renderW - natW * scale) / 2;
            const y = (renderH - natH * scale) / 2;
            ctx.drawImage(img, x, y, natW * scale, natH * scale);
            resolve(canvas.toDataURL('image/png'));
          } catch {
            if (fallbackFn) fallbackFn();
            else resolve(null);
          }
        };
        img.onerror = () => {
          if (fallbackFn) fallbackFn();
          else resolve(null);
        };
        img.src = imgSrc;
      };

      let encoded: string;
      try {
        encoded = btoa(unescape(encodeURIComponent(svg)));
      } catch {
        const urlURI = 'data:image/svg+xml,' + encodeURIComponent(svg);
        tryRender(urlURI, () => resolve(null));
        return;
      }

      const base64URI = 'data:image/svg+xml;base64,' + encoded;
      tryRender(base64URI, () => {
        const urlURI = 'data:image/svg+xml,' + encodeURIComponent(svg);
        tryRender(urlURI, () => resolve(null));
      });
    } catch {
      resolve(null);
    }
  });
};

// Generate self-contained HTML for export/print
export const generateExportHTML = (
  slides: Slide[],
  title: string,
  showNotes: boolean,
): string => {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title || 'Presentation'} - Docent</title><style>
    @page { size: landscape; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0F1419; color: #E8EAED; overflow-x: hidden; }
    .slide { width: 100vw; height: 100vh; page-break-after: always; display: flex; flex-direction: column; padding: 40px 60px; background: #0F1419; position: relative; overflow: hidden; }
    .slide:last-child { page-break-after: auto; }
    .slide-title { font-size: 32px; font-weight: 700; border-bottom: 3px solid #D4A853; padding-bottom: 12px; margin-bottom: 20px; flex-shrink: 0; }
    .slide-body { flex: 1; display: flex; gap: 30px; min-height: 0; }
    .slide-body.vertical { flex-direction: column; }
    .bullets { flex: 1; display: flex; flex-direction: column; gap: 10px; }
    .bullets.narrow { flex: 0 0 35%; }
    .bullet { font-size: 18px; line-height: 1.5; display: flex; gap: 10px; }
    .bullet::before { content: '\\203A'; color: #D4A853; font-weight: 700; }
    .figure { flex: 1.2; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 0; overflow: hidden; }
    .figure img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; }
    .figure svg { width: 100%; height: 100%; max-width: 100%; max-height: 100%; }
    .slide-body.vertical .bullets { flex: 0 0 auto; max-height: 40%; }
    .slide-body.vertical .figure { flex: 1; }
    .figure.card { background: #1A2332; border: 1px solid #2A3A4E; border-radius: 12px; padding: 24px; flex-direction: column; }
    .figure-label { color: #D4A853; font-weight: 600; font-size: 20px; margin-bottom: 8px; }
    .figure-desc { color: #8B9DB6; font-size: 16px; line-height: 1.5; }
    .speaker-notes { margin-top: 16px; padding: 12px 20px; background: rgba(0,0,0,0.85); border-top: 2px solid #D4A853; border-radius: 0 0 8px 8px; flex-shrink: 0; max-height: 20vh; overflow-y: auto; position: relative; z-index: 2; }
    .notes-label { font-size: 11px; color: #D4A853; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .notes-text { font-size: 14px; color: #FFFFFF; line-height: 1.6; }
    .branding { position: absolute; bottom: 12px; right: 20px; left: 20px; font-size: 10px; color: #8B9DB6; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .title-slide { text-align: center; padding: 60px 80px; }
    .title-content { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 0; }
    .title-slide .title-heading { font-size: 48px; font-weight: 800; color: #FFFFFF; margin-bottom: 16px; border: none; text-shadow: 0 0 10px rgba(0,0,0,0.9), 0 2px 20px rgba(0,0,0,0.8), 0 4px 40px rgba(0,0,0,0.6); position: relative; z-index: 1; }
    .title-slide .gold-rule { width: 120px; height: 3px; background: linear-gradient(90deg, transparent, #D4A853, transparent); border-radius: 2px; margin: 0 auto 20px; position: relative; z-index: 1; }
    .title-slide .title-line { margin: 6px 0; position: relative; z-index: 1; }
    .title-slide .title-line.subtitle { font-size: 22px; color: #FFFFFF; font-weight: 700; text-shadow: 0 0 8px rgba(0,0,0,0.9), 0 2px 16px rgba(0,0,0,0.7); }
    .title-slide .title-line.byline { font-size: 18px; color: #FFD700; font-weight: 700; letter-spacing: 1px; text-shadow: 0 0 8px rgba(0,0,0,0.9), 0 2px 16px rgba(0,0,0,0.7); }
    .title-slide .title-line.dateline { font-size: 16px; color: #FFFFFF; font-weight: 600; font-style: italic; text-shadow: 0 0 8px rgba(0,0,0,0.9), 0 2px 16px rgba(0,0,0,0.7); }
    .title-slide .ai-bg { position: absolute; inset: 0; background-size: cover; background-position: center; opacity: 0.75; pointer-events: none; }
    .title-slide .ai-bg-overlay { position: absolute; inset: 0; background: radial-gradient(ellipse at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.45) 100%); pointer-events: none; }
    .title-slide .svg-watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0.12; pointer-events: none; }
    .title-slide .svg-watermark svg { width: 85%; height: 85%; }
    .title-slide .corner { position: absolute; width: 40px; height: 40px; }
    .title-slide .corner.tl { top: 20px; left: 20px; border-top: 2px solid #D4A85340; border-left: 2px solid #D4A85340; }
    .title-slide .corner.tr { top: 20px; right: 20px; border-top: 2px solid #D4A85340; border-right: 2px solid #D4A85340; }
    .title-slide .corner.bl { bottom: 20px; left: 20px; border-bottom: 2px solid #D4A85340; border-left: 2px solid #D4A85340; }
    .title-slide .corner.br { bottom: 20px; right: 20px; border-bottom: 2px solid #D4A85340; border-right: 2px solid #D4A85340; }
    .title-slide .gradient-bg { position: absolute; inset: 0; background: radial-gradient(ellipse at center, #D4A8530A 0%, transparent 70%); pointer-events: none; }
    .footnotes { border-top: 1px solid #2A3A4E; padding: 6px 0 4px; margin-top: 12px; flex-shrink: 0; }
    .footnote { font-size: 11px; color: #5A6F87; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .footnote-num { color: #D4A853; font-weight: 600; font-size: 10px; margin-right: 4px; }
    .citation-marker { color: #D4A853; font-size: 10px; font-weight: 600; }
    .figure-caption { font-size: 10px; color: #5A6F87; text-align: center; margin-top: 4px; font-style: italic; }
    @media print { body { margin: 0; } }
  </style></head><body>
  ${slides.map((slide, idx) => {
    const hasFig = !!slide.figure;
    const hasContent = (slide.content?.length ?? 0) > 0;
    const notesHtml = showNotes && slide.speakerNotes ? '<div class="speaker-notes"><div class="notes-label">Speaker Notes</div><div class="notes-text">' + slide.speakerNotes.replace(/\n/g, '<br>') + '</div></div>' : '';
    const brandingHtml = '<div class="branding">Docent v1.0.0 &middot; Symbiont-AI Cognitive Labs &middot; Slide ' + (idx + 1) + '/' + slides.length + '</div>';

    // ── Title slide (idx 0) — enhanced centered layout ──
    if (idx === 0 && slide.figure?.type !== 'pdf_crop') {
      const svgWatermark = hasFig && slide.figure!.type === 'svg' ? '<div class="svg-watermark">' + (slide.figure!.content || '') + '</div>' : '';
      const aiBgHtml = hasFig && slide.figure!.type === 'image' && slide.figure!.src
        ? '<div class="ai-bg" style="background-image:url(' + slide.figure!.src + ')"></div><div class="ai-bg-overlay"></div>'
        : '';
      const contentLines = hasContent ? slide.content!.map(c => {
        const lower = c.toLowerCase();
        const isByline = lower.includes('presented by');
        const isDate = /^\d{4}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(c);
        const cls = isByline ? 'title-line byline' : isDate ? 'title-line dateline' : 'title-line subtitle';
        return '<div class="' + cls + '">' + c + '</div>';
      }).join('') : '';
      return '<div class="slide title-slide">' + aiBgHtml + '<div class="gradient-bg"></div>' + svgWatermark + '<div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div><div class="title-content"><div class="title-heading">' + slide.title + '</div><div class="gold-rule"></div>' + contentLines + '</div>' + notesHtml + brandingHtml + '</div>';
    }

    // ── Regular slides ──
    let layout = slide.layout || (!hasContent && hasFig ? 'figure_only' : hasFig && (slide.content?.length || 0) <= 3 ? 'figure_focus' : hasFig ? 'balanced' : 'text_only');
    if (layout === 'figure_only' && hasContent) layout = 'figure_focus';
    const isVertical = layout === 'figure_only' || layout === 'text_only';
    const isNarrow = layout === 'figure_focus';
    let figHtml = '';
    const captionHtml = slide.figure?.caption ? '<div class="figure-caption">' + slide.figure.caption + '</div>' : '';
    if (hasFig) {
      if (slide.figure!.type === 'card') figHtml = '<div class="figure card"><div class="figure-label">' + (slide.figure!.label || '') + '</div><p class="figure-desc">' + (slide.figure!.description || '') + '</p></div>';
      else if (slide.figure!.type === 'pdf_crop' && slide.figure!.croppedDataURL) figHtml = '<div class="figure"><img src="' + slide.figure!.croppedDataURL + '" />' + captionHtml + '</div>';
      else if (slide.figure!.type === 'svg') figHtml = '<div class="figure">' + (slide.figure!.content || '') + captionHtml + '</div>';
      else if (slide.figure!.type === 'image' && slide.figure!.src) figHtml = '<div class="figure"><img src="' + slide.figure!.src + '" />' + captionHtml + '</div>';
    }
    const bulletsClass = isNarrow ? 'bullets narrow' : 'bullets';
    const bodyClass = isVertical ? 'slide-body vertical' : 'slide-body';
    const highlightCitations = (text: string): string => text.replace(/\[(\d+)\]/g, '<sup class="citation-marker">[$1]</sup>');
    const footnotesHtml = (slide.references?.length ?? 0) > 0
      ? '<div class="footnotes">' + slide.references!.map((ref, i) => '<div class="footnote"><span class="footnote-num">[' + (i + 1) + ']</span>' + ref + '</div>').join('') + '</div>'
      : '';
    return '<div class="slide"><div class="slide-title">' + slide.title + '</div><div class="' + bodyClass + '">' + (hasContent ? '<div class="' + bulletsClass + '">' + slide.content!.map(c => '<div class="bullet">' + highlightCitations(c) + '</div>').join('') + '</div>' : '') + figHtml + '</div>' + footnotesHtml + notesHtml + brandingHtml + '</div>';
  }).join('')}
  </body></html>`;
  return html;
};

// Extract natural dimensions from a data URL image
const getImageDimensions = (dataURL: string): Promise<{ width: number; height: number } | null> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataURL;
  });
};

// Compute aspect-ratio-correct bounding box centered in the available area
const adjustBoundsToAspectRatio = (
  imgW: number, imgH: number,
  availX: number, availY: number, availW: number, availH: number,
): { x: number; y: number; w: number; h: number } => {
  const imgAspect = imgW / imgH;
  const availAspect = availW / availH;
  let w: number, h: number;
  if (imgAspect > availAspect) {
    // Image is wider — constrain by width
    w = availW;
    h = availW / imgAspect;
  } else {
    // Image is taller — constrain by height
    h = availH;
    w = availH * imgAspect;
  }
  return {
    x: availX + (availW - w) / 2,
    y: availY + (availH - h) / 2,
    w,
    h,
  };
};

// PPTX figure helper — sizes images to their actual aspect ratio
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const addFigureToPptx = async (pSlide: any, figure: NonNullable<Slide['figure']>, x: number, y: number, w: number, h: number): Promise<void> => {
  try {
    // Helper: add an image with aspect-ratio-adjusted bounds
    const addImageFitted = async (dataURL: string) => {
      const dims = await getImageDimensions(dataURL);
      if (dims) {
        const b = adjustBoundsToAspectRatio(dims.width, dims.height, x, y, w, h);
        pSlide.addImage({ data: dataURL, x: b.x, y: b.y, w: b.w, h: b.h });
      } else {
        // Fallback: let PptxGenJS handle contain sizing
        pSlide.addImage({ data: dataURL, x, y, w, h, sizing: { type: 'contain', w, h } });
      }
    };

    if (figure.type === 'svg' && figure.content) {
      const dataURL = await svgToDataURL(figure.content);
      if (dataURL) {
        await addImageFitted(dataURL);
      } else {
        pSlide.addShape('roundRect', {
          x, y: y + 0.5, w, h: h - 1, fill: { color: '1A2332' }, line: { color: '2A3A4E', width: 1, dashType: 'dash' }, rectRadius: 0.15,
        });
        pSlide.addText(figure.label || 'SVG Diagram (view in HTML export)', {
          x, y: y + h / 3, w, h: h / 3, fontSize: 14, color: '8B9DB6', align: 'center', fontFace: 'Calibri', italic: true,
        });
      }
    } else if (figure.type === 'pdf_crop' && figure.croppedDataURL) {
      await addImageFitted(figure.croppedDataURL);
    } else if (figure.type === 'image' && figure.src) {
      await addImageFitted(figure.src);
    } else if (figure.type === 'card') {
      pSlide.addShape('roundRect', {
        x, y: y + 0.5, w, h: h - 1, fill: { color: '1A2332' }, line: { color: '2A3A4E', width: 1 }, rectRadius: 0.15,
      });
      if (figure.label) {
        pSlide.addText(figure.label, {
          x: x + 0.3, y: y + 0.8, w: w - 0.6, h: 0.5,
          fontSize: 18, fontFace: 'Palatino Linotype', color: 'D4A853', bold: true,
        });
      }
      if (figure.description) {
        pSlide.addText(figure.description, {
          x: x + 0.3, y: y + 1.5, w: w - 0.6, h: h - 2.5,
          fontSize: 14, fontFace: 'Calibri', color: '8B9DB6', valign: 'top',
        });
      }
    }
  } catch (e) {
    console.warn('Failed to add figure:', e);
  }
};

// Export presentation as PPTX
export const exportPresentationPPTX = async (
  presState: PresentationState,
  onProgress: (msg: string) => void,
): Promise<void> => {
  const { slides, title, speakerNotesVisible } = presState;
  if (slides.length === 0) return;

  // Dynamically import PptxGenJS
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.author = 'Docent - Symbiont-AI Cognitive Labs';
  pres.title = title || 'Presentation';

  const BG = '0F1419';
  const TEXT = 'E8EAED';
  const ACCENT = 'D4A853';

  for (let idx = 0; idx < slides.length; idx++) {
    const slideData = slides[idx];
    onProgress(`Building PPTX slide ${idx + 1}/${slides.length}...`);
    await new Promise(r => setTimeout(r, 0));

    const pSlide = pres.addSlide();
    pSlide.background = { fill: BG };

    const hasFig = !!slideData.figure;
    const hasContent = (slideData.content?.length ?? 0) > 0;
    let layout = slideData.layout || (!hasContent && hasFig ? 'figure_only' : hasFig && (slideData.content?.length || 0) <= 3 ? 'figure_focus' : hasFig ? 'balanced' : 'text_only');
    if (layout === 'figure_only' && hasContent) layout = 'figure_focus';

    // ── Title slide (idx 0) — centered premium layout ──
    if (idx === 0 && slideData.figure?.type !== 'pdf_crop') {
      // AI-generated image as semi-transparent background
      if (hasFig && slideData.figure!.type === 'image' && slideData.figure!.src) {
        pSlide.addImage({ data: slideData.figure!.src, x: 0, y: 0, w: 13.333, h: 7.5, transparency: 25 });
      }
      // Decorative SVG as semi-transparent background
      if (hasFig && slideData.figure!.type === 'svg' && slideData.figure!.content) {
        const dataURL = await svgToDataURL(slideData.figure!.content);
        if (dataURL) {
          pSlide.addImage({ data: dataURL, x: 0.5, y: 0.5, w: 12.3, h: 6.5, transparency: 85 });
        }
      }

      // Centered title — larger
      pSlide.addText(slideData.title || '', {
        x: 1.5, y: 1.5, w: 10.3, h: 1.5,
        fontSize: 36, fontFace: 'Palatino Linotype',
        color: TEXT, bold: true, align: 'center', valign: 'bottom',
      });

      // Centered gold decorative line
      pSlide.addShape('rect', {
        x: 5.5, y: 3.2, w: 2.3, h: 0.04, fill: { color: ACCENT },
      });

      // Content lines — centered, no bullets
      if (hasContent) {
        slideData.content!.forEach((line, lineIdx) => {
          const isByline = line.toLowerCase().includes('presented by');
          const isDate = /^\d{4}|january|february|march|april|may|june|july|august|september|october|november|december/i.test(line);
          pSlide.addText(line, {
            x: 2.0, y: 3.5 + lineIdx * 0.6, w: 9.3, h: 0.5,
            fontSize: isByline ? 16 : isDate ? 14 : 18,
            fontFace: isByline ? 'Calibri' : 'Palatino Linotype',
            color: isByline ? ACCENT : isDate ? '8B9DB6' : TEXT,
            bold: isByline,
            italic: isDate,
            align: 'center',
          });
        });
      }

      // Corner brackets (decorative shapes)
      const cornerLen = 0.5;
      const cornerW = 0.03;
      const cornerColor = 'D4A85340';
      // Top-left
      pSlide.addShape('rect', { x: 0.4, y: 0.4, w: cornerLen, h: cornerW, fill: { color: cornerColor } });
      pSlide.addShape('rect', { x: 0.4, y: 0.4, w: cornerW, h: cornerLen, fill: { color: cornerColor } });
      // Top-right
      pSlide.addShape('rect', { x: 12.4 - cornerLen, y: 0.4, w: cornerLen, h: cornerW, fill: { color: cornerColor } });
      pSlide.addShape('rect', { x: 12.4 + cornerLen - cornerLen, y: 0.4, w: cornerW, h: cornerLen, fill: { color: cornerColor } });
      // Bottom-left
      pSlide.addShape('rect', { x: 0.4, y: 7.1, w: cornerLen, h: cornerW, fill: { color: cornerColor } });
      pSlide.addShape('rect', { x: 0.4, y: 7.1 - cornerLen + cornerW, w: cornerW, h: cornerLen, fill: { color: cornerColor } });
      // Bottom-right
      pSlide.addShape('rect', { x: 12.4 - cornerLen, y: 7.1, w: cornerLen, h: cornerW, fill: { color: cornerColor } });
      pSlide.addShape('rect', { x: 12.4 + cornerLen - cornerLen, y: 7.1 - cornerLen + cornerW, w: cornerW, h: cornerLen, fill: { color: cornerColor } });
    } else {
      // ── Regular slides (and PDF title slides) ──

      // Title bar
      pSlide.addText(slideData.title || '', {
        x: 0.5, y: 0.3, w: 12.3, h: 0.7,
        fontSize: 28, fontFace: 'Palatino Linotype',
        color: TEXT, bold: true, valign: 'bottom',
      });
      pSlide.addShape('rect', {
        x: 0.5, y: 1.05, w: 12.3, h: 0.04, fill: { color: ACCENT },
      });

      const bodyTop = 1.3;
      const hasRefs = (slideData.references?.length ?? 0) > 0;
      const bodyH = hasRefs ? 5.0 : 5.5;

      if (layout === 'text_only') {
        if (hasContent) {
          const bullets = slideData.content!.map(c => ({
            text: c, options: { fontSize: 16, color: TEXT, bullet: { code: '203A', color: ACCENT }, lineSpacingMultiple: 1.4 },
          }));
          pSlide.addText(bullets, { x: 0.5, y: bodyTop, w: 12.3, h: bodyH, valign: 'top', fontFace: 'Calibri' });
        }
      } else if (layout === 'figure_only') {
        if (hasFig) await addFigureToPptx(pSlide, slideData.figure!, 0.5, bodyTop, 12.3, bodyH);
      } else if (layout === 'figure_focus') {
        if (hasContent) {
          const bullets = slideData.content!.map(c => ({
            text: c, options: { fontSize: 14, color: TEXT, bullet: { code: '203A', color: ACCENT }, lineSpacingMultiple: 1.4 },
          }));
          pSlide.addText(bullets, { x: 0.5, y: bodyTop, w: 4.0, h: bodyH, valign: 'top', fontFace: 'Calibri' });
        }
        if (hasFig) await addFigureToPptx(pSlide, slideData.figure!, 4.8, bodyTop, 8.0, bodyH);
      } else {
        if (hasContent) {
          const bullets = slideData.content!.map(c => ({
            text: c, options: { fontSize: 15, color: TEXT, bullet: { code: '203A', color: ACCENT }, lineSpacingMultiple: 1.4 },
          }));
          pSlide.addText(bullets, { x: 0.5, y: bodyTop, w: 5.8, h: bodyH, valign: 'top', fontFace: 'Calibri' });
        }
        if (hasFig) await addFigureToPptx(pSlide, slideData.figure!, 6.6, bodyTop, 6.2, bodyH);
      }

      // Figure caption (e.g. "Source: Wikipedia")
      if (slideData.figure?.caption) {
        const captionY = hasRefs ? 6.25 : 6.6;
        pSlide.addText(slideData.figure.caption, {
          x: 0.5, y: captionY, w: 12.3, h: 0.25,
          fontSize: 8, fontFace: 'Calibri', color: '5A6F87',
          italic: true, align: 'center',
        });
      }

      // Per-slide footnote references
      if (hasRefs) {
        // Thin separator line
        pSlide.addShape('rect', {
          x: 0.5, y: 6.4, w: 12.3, h: 0.01, fill: { color: '2A3A4E' },
        });
        // Footnote text
        const footnoteLines = slideData.references!.map((ref: string, i: number) => ({
          text: `[${i + 1}] ${ref}`,
          options: { fontSize: 9, color: '5A6F87', lineSpacingMultiple: 1.2 as const },
        }));
        pSlide.addText(footnoteLines, {
          x: 0.5, y: 6.45, w: 12.3, h: 0.6,
          valign: 'top' as const, fontFace: 'Calibri',
        });
      }
    }

    if (speakerNotesVisible && slideData.speakerNotes) {
      pSlide.addNotes(slideData.speakerNotes);
    }

    pSlide.addText(`Docent v1.0.0 \u00B7 Symbiont-AI Cognitive Labs \u00B7 Slide ${idx + 1}/${slides.length}`, {
      x: 6.0, y: 7.1, w: 7.0, h: 0.3,
      fontSize: 8, color: '8B9DB6', align: 'right', fontFace: 'Calibri',
    });
  }

  // Download
  const fileName = (title || 'presentation').replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_');
  onProgress('Downloading PPTX...');
  try {
    const blob = await pres.write({ outputType: 'blob' }) as Blob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName}_docent.pptx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {
    const base64 = await pres.write({ outputType: 'base64' }) as string;
    const a = document.createElement('a');
    a.href = 'data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,' + base64;
    a.download = `${fileName}_docent.pptx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
};
