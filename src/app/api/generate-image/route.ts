// ==========================================================
// DOCENT — AI Image Generation Route (Nano Banana / Gemini)
// Calls OpenRouter's image generation endpoint and returns
// the generated image as a base64 data URL.
// Includes automatic retry with prompt simplification.
// ==========================================================

import { NextRequest, NextResponse } from 'next/server';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const IMAGE_MODEL = 'google/gemini-3-pro-image-preview'; // Nano Banana Pro (Gemini 3 Pro Image)
const MAX_ATTEMPTS = 3;

/**
 * Extract an image data URL from an OpenRouter/Gemini response message.
 * Returns { imageDataURL, textContent } — imageDataURL may be null if
 * the model only returned text.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImage(message: any): { imageDataURL: string | null; textContent: string } {
  let imageDataURL: string | null = null;
  let textContent = '';

  // Check for multimodal content (array of parts)
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        imageDataURL = part.image_url.url;
      } else if (part.type === 'text' && part.text) {
        textContent += part.text;
      }
      // Also check inline_data format (Gemini native)
      if (part.inline_data?.data && part.inline_data?.mime_type) {
        imageDataURL = `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
      }
    }
  }

  // Some models return images in a top-level images array
  if (!imageDataURL && message?.images?.length > 0) {
    const img = message.images[0];
    if (img.image_url?.url) {
      imageDataURL = img.image_url.url;
    } else if (img.url) {
      imageDataURL = img.url;
    }
  }

  // Fallback: check if the response content is a string with a data URL
  if (!imageDataURL && typeof message?.content === 'string') {
    const dataUrlMatch = message.content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (dataUrlMatch) {
      imageDataURL = dataUrlMatch[0];
    }
    textContent = message.content;
  }

  return { imageDataURL, textContent };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt } = body;

    if (!prompt) {
      return NextResponse.json(
        { error: 'Missing "prompt" in request body.' },
        { status: 400 },
      );
    }

    // Get API key: from request header first, then env variable as fallback
    const apiKey = request.headers.get('x-api-key') || process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: 'No API key provided. Please enter your OpenRouter API key in Settings.' },
        { status: 401 },
      );
    }

    // ── Retry loop: attempt image generation up to MAX_ATTEMPTS times ──
    // On retries, simplify the prompt to be more visual/concrete since
    // Gemini sometimes returns text-only for abstract or complex prompts.
    let lastTextContent = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // On retries, simplify the prompt to focus on visual output
      const effectivePrompt = attempt === 1
        ? prompt
        : `Generate an image: a clean, professional illustration for a presentation slide.\n${prompt.split('\n').slice(0, 2).join('\n')}\nStyle: simple, visual, no text overlays, dark background friendly. Please output an image.`;

      const orBody = {
        model: IMAGE_MODEL,
        messages: [
          {
            role: 'user',
            content: effectivePrompt,
          },
        ],
        modalities: ['text', 'image'],
        max_tokens: 4096,
        provider: {
          sort: 'throughput',
        },
      };

      console.log(`[Generate Image] Attempt ${attempt}/${MAX_ATTEMPTS}, model: ${IMAGE_MODEL}, prompt length: ${effectivePrompt.length}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);

      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://docent.symbiont-ai.com',
          'X-Title': 'Docent - AI Presenter',
        },
        body: JSON.stringify(orBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Generate Image] OpenRouter error (attempt ${attempt}):`, response.status, errorText.substring(0, 500));
        // For API errors (4xx/5xx), don't retry — these are usually permanent
        return NextResponse.json(
          { error: `Image generation failed (${response.status}): ${errorText.substring(0, 300)}` },
          { status: response.status },
        );
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) {
        console.warn(`[Generate Image] No choices in response (attempt ${attempt})`);
        if (attempt < MAX_ATTEMPTS) continue;
        return NextResponse.json(
          { error: 'No response from image model.' },
          { status: 502 },
        );
      }

      const message = choice.message;
      console.log(`[Generate Image] Attempt ${attempt} — content type:`, typeof message?.content,
        'is array:', Array.isArray(message?.content),
        'has images:', !!message?.images?.length);

      let { imageDataURL, textContent } = extractImage(message);
      lastTextContent = textContent;

      if (imageDataURL) {
        // Parse speaker notes from the text content (marked with SPEAKER_NOTES:)
        let speakerNotes: string | undefined;
        if (textContent) {
          const notesMatch = textContent.match(/SPEAKER_NOTES:\s*([\s\S]+)/i);
          if (notesMatch) {
            speakerNotes = notesMatch[1].trim();
            textContent = textContent.replace(/SPEAKER_NOTES:\s*[\s\S]+/i, '').trim();
          }
        }

        console.log(`[Generate Image] Success on attempt ${attempt}! Image data URL length:`, imageDataURL.length,
          speakerNotes ? `| Speaker notes: ${speakerNotes.substring(0, 80)}...` : '| No speaker notes');
        return NextResponse.json({
          dataURL: imageDataURL,
          text: textContent || undefined,
          speakerNotes,
        });
      }

      // No image — log and retry
      console.warn(`[Generate Image] No image on attempt ${attempt}. Text: ${textContent.substring(0, 150)}`);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[Generate Image] Retrying with simplified prompt...`);
      }
    }

    // All attempts failed — return error with the model's text response for context
    const hint = lastTextContent
      ? ` The model replied: "${lastTextContent.substring(0, 120)}"`
      : '';
    console.error(`[Generate Image] Failed after ${MAX_ATTEMPTS} attempts.${hint}`);
    return NextResponse.json(
      { error: `Image generation failed after ${MAX_ATTEMPTS} attempts.${hint} Try simplifying your prompt or use 🔍 Find Photo instead.` },
      { status: 422 },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Image generation timed out.' },
        { status: 504 },
      );
    }
    console.error('[Generate Image] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate image.' },
      { status: 500 },
    );
  }
}
