// ==========================================================
// DOCENT — OpenRouter API Proxy Route
// Translates client requests to OpenRouter's OpenAI-compatible format
// Supports both streaming (SSE) and non-streaming responses
// ==========================================================

import { NextRequest, NextResponse } from 'next/server';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
    const { messages, model, max_tokens, system, options, stream } = body;

    // Get API key: from request header first, then env variable as fallback
    const apiKey = request.headers.get('x-api-key') || process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: 'No API key provided. Please enter your OpenRouter API key in Settings.' },
        { status: 401 },
      );
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
      model: model || 'anthropic/claude-opus-4.6',
      messages: orMessages,
      max_tokens: max_tokens || 4096,
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
    }

    // Add provider preferences
    orBody.provider = {
      sort: 'throughput',
    };

    // Forward client abort signal + server-side timeout (uses client-computed timeout, capped at 20 min)
    const controller = new AbortController();
    const serverTimeout = Math.min(body.timeout || 5 * 60_000, 20 * 60_000);
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

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[API] OpenRouter error:', response.status, errorText.substring(0, 500));
      return NextResponse.json(
        { error: `OpenRouter API error ${response.status}: ${errorText.substring(0, 300)}` },
        { status: response.status },
      );
    }

    // === STREAMING PATH ===
    if (stream && response.body) {
      return new Response(response.body, {
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
