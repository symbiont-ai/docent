// ==========================================================
// DOCENT — Image Proxy Route
// Downloads an image from a URL server-side to avoid CORS,
// returns it as a base64 data URL.
// ==========================================================

import { NextRequest, NextResponse } from 'next/server';

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const TIMEOUT_MS = 15_000;

// Browser-like User-Agent — many image hosts (Wikipedia, Wikimedia, etc.)
// block requests with bot-like or custom User-Agent strings.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Attempt to fetch an image URL, returning the Response or null on failure. */
async function tryFetch(
  url: string,
  signal: AbortSignal,
): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://docent.symbiont-ai.com',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (res.ok) return res;
    console.error(
      `[Image Proxy] Fetch failed: ${res.status} ${res.statusText} for URL: ${url}`,
    );
    return null;
  } catch (err) {
    // Don't log abort errors — they'll be handled by the caller
    if (err instanceof Error && err.name === 'AbortError') throw err;
    console.error(`[Image Proxy] Fetch error for ${url}:`, err);
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl.searchParams.get('url');

    if (!url) {
      return NextResponse.json(
        { error: 'Missing "url" query parameter.' },
        { status: 400 },
      );
    }

    // Validate URL scheme
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json(
        { error: 'Invalid URL format.' },
        { status: 400 },
      );
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return NextResponse.json(
        { error: 'Only http/https URLs are supported.' },
        { status: 400 },
      );
    }

    // Fetch the image with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response = await tryFetch(url, controller.signal);

    // ── Wikimedia / Wikipedia fallback ──
    // If the original URL failed and it's from Wikimedia, try the thumbnail API
    // which is more lenient with access control.
    if (
      !response &&
      (url.includes('upload.wikimedia.org') || url.includes('wikipedia.org'))
    ) {
      const filename = url.split('/').pop();
      if (filename) {
        const thumbUrl = `https://commons.wikimedia.org/w/thumb.php?f=${encodeURIComponent(filename)}&w=1024`;
        console.log(`[Image Proxy] Retrying via Wikimedia thumbnail: ${thumbUrl}`);
        response = await tryFetch(thumbUrl, controller.signal);
      }
    }

    clearTimeout(timeoutId);

    if (!response) {
      return NextResponse.json(
        { error: `Failed to fetch image from: ${parsed.hostname}` },
        { status: 502 },
      );
    }

    // Check content type
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return NextResponse.json(
        { error: `Response is not an image (content-type: ${contentType})` },
        { status: 400 },
      );
    }

    // Check content length if provided
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_SIZE) {
      return NextResponse.json(
        { error: `Image too large (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)} MB, max ${MAX_SIZE / 1024 / 1024} MB)` },
        { status: 413 },
      );
    }

    // Read the full body
    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength > MAX_SIZE) {
      return NextResponse.json(
        { error: `Image too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB, max ${MAX_SIZE / 1024 / 1024} MB)` },
        { status: 413 },
      );
    }

    // Convert to base64 data URL
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const mediaType = contentType.split(';')[0].trim();
    const dataURL = `data:${mediaType};base64,${base64}`;

    return NextResponse.json({ dataURL });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Image download timed out.' },
        { status: 504 },
      );
    }
    console.error('[Image Proxy] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to proxy image.' },
      { status: 500 },
    );
  }
}
