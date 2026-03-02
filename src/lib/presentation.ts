// ==========================================================
// DOCENT — Presentation Utility Functions
// ==========================================================

import type { Message, Slide, ImageCatalogEntry, UploadedFile } from '@/src/types';

// Decode HTML entities that LLMs sometimes put in JSON text
export const decodeEntities = (text: string | undefined): string => {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
};

export const isPresentationIntent = (text: string, messages?: Message[]): boolean => {
  const lower = text.toLowerCase();
  const createKeywords = ['presentation', ' present ', 'deck', 'prepare a talk', 'make a talk', 'give a talk', 'lecture on', 'lecture about'];
  const slideCreation = /\b(make|create|build|prepare|generate|give me|add)\b.*\bslides?\b|\bslides?\b.*\b(about|on the topic|for|presentation)\b|\b\d+\s*(content\s+)?slides?\b/i;
  if (createKeywords.some(k => lower.includes(k)) || /^present\s/i.test(text.trim()) || slideCreation.test(text)) return true;
  if (messages && messages.length >= 2) {
    const recentUserMsgs = messages.filter(m => m.sender === 'user').slice(-3);
    return recentUserMsgs.some(m => {
      const ml = m.text.toLowerCase();
      return createKeywords.some(k => ml.includes(k)) || /^present\s/i.test(m.text.trim()) || slideCreation.test(m.text);
    });
  }
  return false;
};

export const cleanTextForSpeech = (text: string): string => {
  return text
    // ── Markdown formatting ──
    .replace(/```[\s\S]*?```/g, ' code block omitted ')       // code blocks
    .replace(/\*\*(.*?)\*\*/g, '$1')                           // bold
    .replace(/\*(.*?)\*/g, '$1')                                // italic
    .replace(/#{1,6}\s/g, '')                                   // headings
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')                   // markdown links
    .replace(/\[\d+\]/g, '')                                     // citation markers [1], [2]
    .replace(/[`_~]/g, '')                                      // backticks, underscores, tildes
    .replace(/\|[^\n]+\|/g, ' table row omitted ')             // table rows
    // ── Emojis and special characters ──
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')  // emojis (👋🎉🔥 etc.)
    .replace(/[→←↑↓↔⇒⇐⇔▶◀●○■□▪▫◆◇★☆✓✗✦✧►◄•‣⁃※†‡§¶©®™℗]/g, '')    // common symbols
    .replace(/[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬═║]/g, '')             // box-drawing chars
    .replace(/([.!?])\1{2,}/g, '$1')                           // repeated punctuation (!!!→!)
    .replace(/\s{2,}/g, ' ')                                   // collapse multiple spaces
    // ── Whitespace normalization ──
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();
};

export const chunkText = (text: string): string[] => {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > 180) {
      if (current) chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
};

// Chunk text for Gemini TTS — larger chunks (~1500 chars) since Gemini handles longer inputs
export const chunkTextForGemini = (text: string): string[] => {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks: string[] = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > 1500) {
      if (current) chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
};

// ==========================================================
// String-aware brace matching — shared utility
// Skips braces inside JSON string values (handles SVG, CSS, etc.)
// ==========================================================

/**
 * Find the matching closing brace for an opening '{' at `startIdx`.
 * Returns the index AFTER the closing '}', or -1 if not found (incomplete/truncated).
 * String-aware: skips braces inside "..." and handles \\ escapes.
 */
export function findMatchingBrace(text: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inString) { i++; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1; // incomplete
}

// ==========================================================
// Incremental slide extraction — for streaming slide-by-slide rendering
// ==========================================================

export interface IncrementalParseState {
  slidesArrayStart: number; // char index of '[' after "slides":, or -1 if not found yet
  extractedCount: number;   // how many slides we've already extracted
  lastScanPos: number;      // where to resume scanning for the next slide object
  title: string;
  language: string;
}

export function createIncrementalParseState(): IncrementalParseState {
  return { slidesArrayStart: -1, extractedCount: 0, lastScanPos: 0, title: '', language: '' };
}

/**
 * Peek into a growing JSON buffer and extract any newly completed slide objects.
 * Returns only slides not previously extracted (based on state.extractedCount).
 */
export function extractIncrementalSlides(
  buffer: string,
  state: IncrementalParseState,
): { newSlides: Slide[]; updatedState: IncrementalParseState } {
  let { slidesArrayStart, extractedCount, lastScanPos, title, language } = state;

  // Step 1: Find the "slides": [ marker if not yet found
  if (slidesArrayStart === -1) {
    const slidesKey = buffer.indexOf('"slides"');
    if (slidesKey === -1) return { newSlides: [], updatedState: state };
    // Find the '[' after "slides" :
    const bracketIdx = buffer.indexOf('[', slidesKey + 8);
    if (bracketIdx === -1) return { newSlides: [], updatedState: state };
    slidesArrayStart = bracketIdx;
    lastScanPos = bracketIdx + 1;

    // Extract title from the buffer (appears before "slides")
    const titleMatch = buffer.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (titleMatch) title = titleMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');

    // Extract language
    const langMatch = buffer.match(/"language"\s*:\s*"([^"]*)"/);
    if (langMatch) language = langMatch[1];
  }

  // Step 2: Scan for complete slide objects starting from lastScanPos
  const newSlides: Slide[] = [];
  let pos = lastScanPos;

  while (pos < buffer.length) {
    // Skip whitespace and commas between slide objects
    while (pos < buffer.length && (buffer[pos] === ' ' || buffer[pos] === '\n' || buffer[pos] === '\r' || buffer[pos] === '\t' || buffer[pos] === ',')) {
      pos++;
    }

    // Check if we hit the end of the slides array or end of buffer
    if (pos >= buffer.length || buffer[pos] === ']') break;

    // Expect an opening brace for a slide object
    if (buffer[pos] !== '{') break;

    // Use string-aware brace matcher to find the complete slide object
    const endIdx = findMatchingBrace(buffer, pos);
    if (endIdx === -1) break; // incomplete slide — wait for more data

    // Extract and parse the individual slide JSON
    const slideJson = buffer.substring(pos, endIdx);
    let slide: Slide | null = null;
    try {
      slide = JSON.parse(slideJson);
    } catch {
      // Strategy 1: Replace attribute quotes inside SVG tags
      try {
        const fixed = slideJson.replace(
          /(<svg[\s\S]*?<\/svg>)/g,
          (svgBlock) => svgBlock.replace(/(\w)="([^"]*?)"/g, "$1='$2'")
        );
        slide = JSON.parse(fixed);
      } catch { /* continue */ }

      // Strategy 2: Strip SVG content entirely so slide at least parses
      if (!slide) {
        try {
          const stripped = slideJson
            .replace(/"content"\s*:\s*"(<svg[\s\S]*?<\/svg>)"/g, '"content": ""')
            .replace(/"content"\s*:\s*"(<svg[\s\S]*?)$/g, '"content": ""');
          slide = JSON.parse(stripped);
          if (slide) console.warn(`[IncrementalParse] Stripped SVG from slide ${extractedCount + newSlides.length + 1}`);
        } catch { /* continue */ }
      }

      if (!slide) {
        console.warn(`[IncrementalParse] Could not parse slide ${extractedCount + newSlides.length + 1}, skipping`);
      }
    }

    if (slide) {
      newSlides.push(slide);
    }

    pos = endIdx;
  }

  const updatedState: IncrementalParseState = {
    slidesArrayStart,
    extractedCount: extractedCount + newSlides.length,
    lastScanPos: pos,
    title,
    language,
  };

  return { newSlides, updatedState };
}

// SVG-aware JSON repair — multi-strategy approach
export const repairSvgJson = (jsonStr: string): { title: string; slides: Slide[] } | null => {
  if (!jsonStr.includes('<svg')) return null;

  // Strategy A: Replace unescaped double quotes inside SVG attribute values with single quotes.
  // SVG content in JSON looks like: "content": "<svg width=\"100\" ...>text</svg>"
  // Sometimes the model outputs unescaped quotes: "content": "<svg width="100" ...>"
  // which breaks JSON.parse. We fix by finding SVG ranges and replacing " with ' inside them,
  // but ONLY the inner quotes (not the JSON string delimiters).
  try {
    // Replace attribute-style quotes inside SVG tags: e.g. width="100" → width='100'
    // This targets double quotes inside < > angle brackets within SVG content
    let repaired = jsonStr;
    // Match unescaped quotes in SVG attribute contexts: attr="value" → attr='value'
    repaired = repaired.replace(
      /(<svg[\s\S]*?<\/svg>)/g,
      (svgBlock) => svgBlock.replace(/(\w)="([^"]*?)"/g, "$1='$2'")
    );
    const parsed = JSON.parse(repaired);
    if (parsed.slides?.length > 0) return parsed;
  } catch { /* continue */ }

  // Strategy B: Escape all unescaped double quotes inside SVG string values.
  // Find "content" values that contain SVG and properly escape internal quotes.
  try {
    let repaired = jsonStr;
    // Find SVG content values and escape unescaped quotes within them
    repaired = repaired.replace(
      /"content"\s*:\s*"(<svg[\s\S]*?<\/svg>)"/g,
      (_match, svgContent: string) => {
        const escaped = svgContent.replace(/"/g, "'");
        return `"content": "${escaped}"`;
      }
    );
    const parsed = JSON.parse(repaired);
    if (parsed.slides?.length > 0) return parsed;
  } catch { /* continue */ }

  // Strategy C: Nuclear option — strip SVG content entirely so the rest of the JSON parses.
  // The presentation will load without figures but at least won't show raw JSON.
  try {
    let stripped = jsonStr.replace(
      /"content"\s*:\s*"(<svg[\s\S]*?<\/svg>)"/g,
      '"content": ""'
    );
    const parsed = JSON.parse(stripped);
    if (parsed.slides?.length > 0) {
      console.warn('[repairSvgJson] Had to strip SVG content to parse JSON. Figures may be missing.');
      return parsed;
    }
  } catch { /* continue */ }

  // Strategy D: Original blanket replacement as last resort
  const svgStartRegex = /<svg[\s>]/g;
  let svgMatch;
  const svgRanges: { start: number; end: number }[] = [];
  while ((svgMatch = svgStartRegex.exec(jsonStr)) !== null) {
    const start = svgMatch.index;
    const endIdx = jsonStr.indexOf('</svg>', start);
    if (endIdx !== -1) svgRanges.push({ start, end: endIdx + 6 });
  }
  if (svgRanges.length > 0) {
    let repaired = jsonStr;
    for (let i = svgRanges.length - 1; i >= 0; i--) {
      const { start, end } = svgRanges[i];
      repaired = repaired.substring(0, start) + repaired.substring(start, end).replace(/"/g, "'") + repaired.substring(end);
    }
    try {
      const parsed = JSON.parse(repaired);
      if (parsed.slides?.length > 0) return parsed;
    } catch { /* continue */ }
  }

  return null;
};

export const extractPresentationJson = (text: string): { presData: { title: string; slides: Slide[] }; fullMatch: string } | null => {
  // Strategy 1: Find code-fenced JSON blocks (```json ... ```)
  const blockRegex = /```(?:\w*)\s*\n?([\s\S]*?)```/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const content = match[1].trim();
    if (!content.includes('"slides"')) continue;
    try {
      const parsed = JSON.parse(content);
      if (parsed.slides?.length > 0) return { presData: parsed, fullMatch: match[0] };
    } catch {
      const repaired = repairSvgJson(content);
      if (repaired?.slides?.length) return { presData: repaired, fullMatch: match[0] };
    }
  }

  // Strategy 2: Aggressive truncation repair with code fences
  const openIdx = text.search(/```(?:json|\w*)\s*\n?/);
  const rawStart = openIdx !== -1 ? text.indexOf('\n', openIdx) + 1 : -1;
  const braceStart = text.indexOf('{"');
  const startIdx = rawStart > 0 ? rawStart : braceStart;

  if (startIdx >= 0) {
    const candidate = text.substring(startIdx).replace(/```\s*$/, '').trim();
    if (candidate.includes('"slides"')) {
      const result = tryParsePresentation(candidate, text, openIdx >= 0 ? openIdx : braceStart);
      if (result) return result;
    }
  }

  // Strategy 3: Raw JSON extraction via string-aware brace-matching (no code fences needed)
  // Handles models that output JSON without code blocks
  if (text.includes('"slides"')) {
    const slidesIdx = text.indexOf('"slides"');
    // Walk backwards from "slides" to find the outermost opening brace
    // (backwards walk doesn't need string-awareness since we just need the first '{')
    let braceDepth = 0;
    let jsonStart = -1;
    for (let i = slidesIdx; i >= 0; i--) {
      if (text[i] === '}') braceDepth++;
      if (text[i] === '{') {
        if (braceDepth === 0) { jsonStart = i; break; }
        braceDepth--;
      }
    }

    if (jsonStart >= 0) {
      // Use the shared string-aware brace matcher
      const jsonEnd = findMatchingBrace(text, jsonStart);

      if (jsonEnd > jsonStart) {
        const rawJson = text.substring(jsonStart, jsonEnd);
        const result = tryParsePresentation(rawJson, text, jsonStart);
        if (result) return result;
      }

      // Even if brace-matching didn't find a clean end (truncated), try from jsonStart
      const remainder = text.substring(jsonStart).replace(/```\s*$/, '').trim();
      const result = tryParsePresentation(remainder, text, jsonStart);
      if (result) return result;
    }
  }

  return null;
};

/** Helper: try to parse a candidate string as presentation JSON, with multiple repair strategies */
function tryParsePresentation(
  candidate: string,
  fullText: string,
  matchStart: number,
): { presData: { title: string; slides: Slide[] }; fullMatch: string } | null {
  // Direct parse
  try {
    const parsed = JSON.parse(candidate);
    if (parsed.slides?.length > 0) return { presData: parsed, fullMatch: fullText.substring(matchStart) };
  } catch { /* continue */ }

  // SVG repair
  const svgRepaired = repairSvgJson(candidate);
  if (svgRepaired?.slides?.length) return { presData: svgRepaired, fullMatch: fullText.substring(matchStart) };

  // Truncation repair: try to close incomplete JSON
  const lastCompleteSlide = candidate.lastIndexOf('"speakerNotes"');
  const lastCloseBrace = lastCompleteSlide > 0 ? candidate.indexOf('}', lastCompleteSlide) : -1;

  const closers = [']}', '"]}', '"}]}', '""]}', '"}]}'];
  for (const closer of closers) {
    const cutPoints = [
      candidate.length,
      lastCloseBrace > 0 ? lastCloseBrace + 1 : -1,
      candidate.lastIndexOf('},') + 1,
    ].filter(p => p > 0);

    for (const cut of cutPoints) {
      const attempt = candidate.substring(0, cut) + closer;
      try {
        const parsed = JSON.parse(attempt);
        if (parsed.slides?.length > 0) return { presData: parsed, fullMatch: fullText.substring(matchStart) };
      } catch { /* continue */ }
      const repaired = repairSvgJson(attempt);
      if (repaired?.slides?.length) return { presData: repaired, fullMatch: fullText.substring(matchStart) };
    }
  }

  // Nuclear fallback: strip ALL SVG figure content so JSON can parse.
  // The presentation loads without SVG figures but at least doesn't show raw JSON.
  try {
    // Remove SVG content values — handles both escaped and unescaped variants
    let stripped = candidate
      .replace(/"content"\s*:\s*"(<svg[\s\S]*?<\/svg>)"/g, '"content": ""')
      .replace(/"content"\s*:\s*"(<svg[\s\S]*?)(?:"|$)/g, '"content": ""');
    // Also try with truncation closers
    for (const closer of ['', ']}', '"}]}']) {
      const attempt = stripped + closer;
      try {
        const parsed = JSON.parse(attempt);
        if (parsed.slides?.length > 0) {
          console.warn('[tryParsePresentation] Nuclear fallback: stripped SVG content to parse JSON.');
          return { presData: parsed, fullMatch: fullText.substring(matchStart) };
        }
      } catch { /* continue */ }
    }
  } catch { /* continue */ }

  return null;
}

// Build slide content summary for the prompt editor (user-facing, content only, no English labels).
// The user sees only their slide content in their language to edit/customize.
export const buildEditorPrompt = (slide: Slide, presentationTitle: string): string => {
  const parts: string[] = [];

  parts.push(presentationTitle);
  parts.push(slide.title);

  if (slide.content?.length) {
    parts.push(slide.content.join('; '));
  }

  if (slide.figure?.label) {
    parts.push(slide.figure.label);
  }

  return parts.join('\n');
};

// Build the full image generation prompt for the AI model (English instruction labels + slide content).
// customContent is the user-edited content from the editor (replaces default slide content).
export const buildImagePrompt = (slide: Slide, presentationTitle: string, language?: string, customContent?: string): string => {
  const parts: string[] = [];

  // Language directive at the top for non-English presentations
  if (language && language !== 'en') {
    parts.push(`LANGUAGE: "${language}" — This is a non-English presentation. ALL text, labels, captions, and annotations rendered in the image MUST be in "${language}". The speaker notes MUST also be written in "${language}". Do NOT use English for any visible text.\n`);
  }

  parts.push(`Create a high-quality, professional image for a presentation slide.`);

  if (customContent) {
    // User edited the content in the prompt editor — use their version as context
    parts.push(`Context:\n${customContent}`);
  } else {
    parts.push(`Presentation: "${presentationTitle}"`);
    parts.push(`Slide title: "${slide.title}"`);

    if (slide.content?.length) {
      parts.push(`Slide context (for understanding the topic ONLY — do NOT render this text in the image): ${slide.content.join('; ')}`);
    }

    if (slide.figure?.label) {
      parts.push(`Current figure description: "${slide.figure.label}"`);
    }
  }

  // Include SVG content so the image model understands the current visual
  if (slide.figure?.content && slide.figure.type === 'svg') {
    const svgSnippet = slide.figure.content.length > 4000
      ? slide.figure.content.substring(0, 4000) + '...(truncated)'
      : slide.figure.content;
    parts.push(`Current SVG diagram:\n${svgSnippet}`);
  }

  // Include speaker notes for coherence (only when not using custom content)
  if (!customContent && slide.speakerNotes) {
    parts.push(`Current speaker notes: "${slide.speakerNotes}"`);
  }

  parts.push(`Style: Clean, educational, professional. No text overlays. Suitable for a dark-themed slide deck.`);

  const notesLangHint = language && language !== 'en'
    ? ` Write the speaker notes in "${language}" (the presentation language).`
    : '';
  parts.push(`\nAfter generating the image, also provide updated speaker notes (2-4 sentences) that describe the NEW image and guide the presenter. The notes should reference what is visible in the new image and how it relates to the slide content.${notesLangHint}`);
  parts.push(`Format the speaker notes on a separate line starting with "SPEAKER_NOTES:" followed by the notes text.`);

  return parts.join('\n');
};

// Build a prompt for the LLM to find a real image URL via web search
export const buildImageSearchPrompt = (slide: Slide, presentationTitle: string, language?: string): string => {
  const context = [
    `Presentation: "${presentationTitle}"`,
    `Slide: "${slide.title}"`,
    slide.content?.length ? `Points: ${slide.content.slice(0, 3).join('; ')}` : '',
  ].filter(Boolean).join('. ');

  const langNote = language && language !== 'en'
    ? `\n- The presentation is in "${language}" — write the description field in that language.`
    : '';

  return `Use web search to find ONE relevant, high-quality photo for this slide context: ${context}

Requirements:
- You MUST search the web to find a real, existing image — do NOT hallucinate or make up URLs
- Return a DIRECT image URL (must end in .jpg, .jpeg, .png, .gif, .webp, or be a direct image link)
- ONLY use images from freely accessible sources: Wikimedia Commons (upload.wikimedia.org/wikipedia/commons/), NASA, government sites (.gov), Unsplash, Pexels, Pixabay
- NEVER use images from hotlink-protected sites: wikia.nocookie.net, fandom.com, getty, shutterstock, alamy, dreamstime, 123rf, or any stock photo site
- Provide proper attribution/credit${langNote}

Return your answer as JSON ONLY, no other text:
{"url": "https://...", "credit": "Source Name / Author", "description": "Brief description of what the image shows"}`;
};

// Build image catalog from uploaded files
export const buildImageCatalog = (
  uploadedFiles: UploadedFile[],
  vizData: { data: Record<string, unknown>[] } | null,
): { catalog: ImageCatalogEntry[]; prompt: string } => {
  const catalog: ImageCatalogEntry[] = [];
  const lines: string[] = [];
  uploadedFiles.forEach((f, i) => {
    if (f.mediaType?.startsWith('image/') && f.dataURL) {
      const id = `img_upload_${i}`;
      catalog.push({ id, description: `Uploaded image: "${f.name}"`, dataURL: f.dataURL });
      lines.push(`- ${id}: Uploaded image: "${f.name}"`);
    }
  });
  if (vizData?.data?.length) {
    const keys = vizData.data[0] ? Object.keys(vizData.data[0]).filter(k => k !== 'name') : [];
    const desc = `Current chart data with ${vizData.data.length} data points, keys: ${keys.join(', ')}`;
    catalog.push({ id: 'img_viz', description: desc, dataURL: null });
    lines.push(`- img_viz: ${desc}`);
  }
  if (catalog.length === 0) return { catalog: [], prompt: '' };
  const prompt = `\n\nIMAGE CATALOG — reference these in slides using {"type":"image_ref","imageId":"ID","label":"Description"}:\n${lines.join('\n')}\n\nAuto-match images to relevant slides.`;
  return { catalog, prompt };
};

export const resolveImageRefs = (slides: Slide[], catalog: ImageCatalogEntry[]): Slide[] => {
  return slides.map(slide => {
    if (slide.figure?.type !== 'image_ref') return slide;
    const img = catalog.find(c => c.id === slide.figure!.imageId);
    if (img?.dataURL) return { ...slide, figure: { type: 'image' as const, src: img.dataURL, label: slide.figure!.label || img.description } };
    return { ...slide, figure: { type: 'card' as const, label: slide.figure!.label || 'Image', description: 'Image not available' } };
  });
};
