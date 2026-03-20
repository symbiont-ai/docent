// ==========================================================
// DOCENT — OpenRouter API Proxy Route
// Translates client requests to OpenRouter's OpenAI-compatible format
// Supports both streaming (SSE) and non-streaming responses
// ==========================================================

import { NextRequest, NextResponse } from 'next/server';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Allow long-running streams (deep analysis can take 10+ minutes)
export const maxDuration = 300; // 5 minutes — Vercel Pro plan max

// ── In-memory rate limiter for free-mode (server-key) requests ────
// Tracks requests per IP with a sliding window. Resets every WINDOW_MS.
const FREE_RATE_LIMIT = 20;          // max requests per window per IP
const FREE_RATE_WINDOW_MS = 60 * 60_000; // 1 hour window
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkFreeRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + FREE_RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  // Garbage-collect expired entries (max 1000 IPs tracked)
  if (rateBuckets.size > 1000) {
    for (const [key, val] of rateBuckets) {
      if (now >= val.resetAt) rateBuckets.delete(key);
    }
  }
  return {
    allowed: bucket.count <= FREE_RATE_LIMIT,
    remaining: Math.max(0, FREE_RATE_LIMIT - bucket.count),
    resetAt: bucket.resetAt,
  };
}

// Budget model enforced for free-mode users (keeps cost down)
const FREE_MODE_MODEL = 'google/gemini-2.5-flash';
const FREE_MODE_MAX_TOKENS = 16384; // enough for presentation generation (~10 slides)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateMessages(messages: any[]): any[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string') return msg;

    // Convert Anthropic-style content blocks to OpenAI format
    if (Array.isArray(msg.content)) {
      const translated = msg.content.map((block: Record<string, unknown>) => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text };
        }
        if (block.type === 'image_url') {
          return block; // Already in OpenAI format
        }
        // Anthropic image format → OpenAI format
        if (block.type === 'image') {
          const source = block.source as Record<string, string>;
          if (source?.type === 'base64') {
            return {
              type: 'image_url',
              image_url: {
                url: `data:${source.media_type};base64,${source.data}`,
              },
            };
          }
        }
        return block;
      });
      return { ...msg, content: translated };
    }

    return msg;
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, model, max_tokens, system, options, stream, temperature } = body;

    // Get API key: from request header first, then env variable as fallback
    const clientKey = request.headers.get('x-api-key') || '';
    const serverKey = process.env.OPENROUTER_API_KEY || '';
    const usingFreeMode = !clientKey && !!serverKey;
    const apiKey = clientKey || serverKey;

    if (!apiKey) {
      return NextResponse.json(
        { error: 'No API key provided. Please enter your OpenRouter API key in Settings.' },
        { status: 401 },
      );
    }

    // ── Free-mode rate limiting ──────────────────────────────
    if (usingFreeMode) {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || 'unknown';
      const rl = checkFreeRateLimit(ip);
      if (!rl.allowed) {
        const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
        return NextResponse.json(
          { error: `Free tier rate limit reached (${FREE_RATE_LIMIT} requests/hour). Please add your own OpenRouter API key in Settings, or try again in ${Math.ceil(retryAfter / 60)} minutes.` },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } },
        );
      }
    }

    // Build OpenRouter request
    const orMessages: Array<Record<string, unknown>> = [];

    // System prompt goes as first message with role: system
    if (system) {
      orMessages.push({ role: 'system', content: system });
    }

    // Translate and add conversation messages
    const translatedMessages = translateMessages(messages || []);
    orMessages.push(...translatedMessages);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orBody: Record<string, any> = {
      model: usingFreeMode ? FREE_MODE_MODEL : (model || 'anthropic/claude-opus-4.6'),
      messages: orMessages,
      max_tokens: usingFreeMode ? Math.min(max_tokens || 4096, FREE_MODE_MAX_TOKENS) : (max_tokens || 4096),
      stream: !!stream,
    };

    // Web search: use OpenRouter's online plugin for supported models
    if (options?.search) {
      orBody.plugins = [{ id: 'web' }];
    }

    // Extended thinking / reasoning
    // OpenRouter only allows ONE of "effort" or "max_tokens", not both
    if (options?.thinking) {
      if (options.thinkingBudget) {
        // Explicit budget → use max_tokens
        orBody.reasoning = { max_tokens: options.thinkingBudget };
      } else {
        // No budget → use effort level
        orBody.reasoning = { effort: 'high' };
      }
      // Some models require temperature = 1 for reasoning
      orBody.temperature = 1;
    } else if (temperature !== undefined) {
      // Forward explicit temperature (e.g., 0 for deterministic extraction)
      orBody.temperature = temperature;
    }

    // Add provider preferences
    orBody.provider = {
      sort: 'throughput',
    };

    // Forward client abort signal + server-side timeout.
    // For streaming requests, the stall detector (below) is the real safety net —
    // it resets on every chunk, so active streams survive indefinitely.
    // The overall timeout here is only a backstop for non-streaming or pre-stream hangs.
    const controller = new AbortController();
    const serverTimeout = stream
      ? 30 * 60_000   // Streaming: 30 min hard cap (stall detector handles actual hangs)
      : Math.min(body.timeout || 5 * 60_000, 10 * 60_000);  // Non-streaming: client-computed, capped at 10 min
    const timeoutId = setTimeout(() => controller.abort(), serverTimeout);

    // If the client disconnects, abort the upstream request too
    request.signal.addEventListener('abort', () => controller.abort());

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

    // For non-streaming responses, the timeout is no longer needed once we have the response.
    // For streaming, keep the timeout alive — it protects the entire SSE stream duration.
    if (!stream) clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[API] OpenRouter error:', response.status, errorText.substring(0, 500));
      return NextResponse.json(
        { error: `OpenRouter API error ${response.status}: ${errorText.substring(0, 300)}` },
        { status: response.status },
      );
    }

    // === STREAMING PATH ===
    // Wrap the upstream SSE stream with a stall detector.
    // Resets a 5-minute inactivity timer on every chunk so legitimate long streams
    // survive, but a stalled connection (no data for 5 min) gets killed cleanly.
    if (stream && response.body) {
      const STALL_TIMEOUT = 5 * 60_000; // 5 min of silence = stalled
      let stallTimer: ReturnType<typeof setTimeout> | null = null;

      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT);
      };

      // Start initial stall timer (covers time between headers and first chunk)
      resetStall();

      const passthrough = new TransformStream({
        transform(chunk, ctrl) {
          resetStall();
          ctrl.enqueue(chunk);
        },
        flush() {
          if (stallTimer) clearTimeout(stallTimer);
          clearTimeout(timeoutId);
        },
      });

      response.body.pipeTo(passthrough.writable).catch(() => {
        if (stallTimer) clearTimeout(stallTimer);
      });

      return new Response(passthrough.readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // === NON-STREAMING PATH (fallback) ===
    const data = await response.json();

    // Extract text content from OpenRouter response (OpenAI format)
    const choice = data.choices?.[0];
    if (!choice) {
      return NextResponse.json(
        { error: 'No response from model.' },
        { status: 502 },
      );
    }

    const content = choice.message?.content || '';

    return NextResponse.json({ content, usage: data.usage || null });
  } catch (error) {
    console.error('[API] Route error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
