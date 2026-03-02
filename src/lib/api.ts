// ==========================================================
// DOCENT — Client-side API helper (calls /api/chat proxy)
// Supports both non-streaming and streaming (SSE) responses
// ==========================================================

export interface ChatRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }>;
  model: string;
  max_tokens: number;
  system?: string;
  timeout?: number;
  options?: {
    search?: boolean;
    thinking?: boolean;
    thinkingBudget?: number;
  };
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  content: string;
  error?: string;
}

export interface StreamResult {
  content: string;
  usage?: TokenUsage;
  finishReason?: string;  // 'stop' | 'length' | 'content_filter'
}

/** Non-streaming: waits for full response, returns complete text */
export async function callChat(
  request: ChatRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error ${response.status}: ${err.substring(0, 300)}`);
  }

  const data: ChatResponse = await response.json();
  if (data.error) throw new Error(data.error);
  return data.content || 'No response received.';
}

/**
 * Streaming: reads SSE chunks from the API route.
 * Calls onChunk(delta, fullText) as each token arrives.
 * Returns the full accumulated response text + token usage when the stream ends.
 */
export async function callChatStream(
  request: ChatRequest,
  apiKey: string,
  onChunk: (delta: string, fullText: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ ...request, stream: true }),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error ${response.status}: ${err.substring(0, 300)}`);
  }

  if (!response.body) {
    throw new Error('No response body received.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';

  let chunkCount = 0;
  let emptyDeltaCount = 0;
  let usage: TokenUsage | undefined;
  let lastFinishReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // skip empty / comments
        if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') continue;

        // Handle both "data: " and "data:" (no space) formats
        let jsonStr = '';
        if (trimmed.startsWith('data: ')) {
          jsonStr = trimmed.slice(6);
        } else if (trimmed.startsWith('data:')) {
          jsonStr = trimmed.slice(5);
        } else {
          continue;
        }

        try {
          const parsed = JSON.parse(jsonStr);
          // Capture token usage from final chunk (OpenRouter includes it)
          if (parsed.usage) {
            usage = {
              prompt_tokens: parsed.usage.prompt_tokens || 0,
              completion_tokens: parsed.usage.completion_tokens || 0,
              total_tokens: parsed.usage.total_tokens || 0,
            };
          }
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) lastFinishReason = choice.finish_reason;
          const delta = choice?.delta?.content;
          if (delta) {
            accumulated += delta;
            chunkCount++;
            onChunk(delta, accumulated);
          } else {
            emptyDeltaCount++;
          }
        } catch {
          // Ignore unparseable chunks (could be partial JSON)
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Handle any remaining data in the buffer
  const remaining = buffer.trim();
  if (remaining && remaining !== 'data: [DONE]' && remaining !== 'data:[DONE]') {
    let jsonStr = '';
    if (remaining.startsWith('data: ')) jsonStr = remaining.slice(6);
    else if (remaining.startsWith('data:')) jsonStr = remaining.slice(5);

    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          accumulated += delta;
          onChunk(delta, accumulated);
        }
      } catch { /* ignore */ }
    }
  }

  console.log(`[Stream] Done. Chunks: ${chunkCount}, Empty deltas: ${emptyDeltaCount}, Length: ${accumulated.length}`,
    usage ? `| Tokens: ${usage.prompt_tokens} in / ${usage.completion_tokens} out` : '',
    lastFinishReason ? `| Finish: ${lastFinishReason}` : '');

  if (!accumulated) {
    console.warn('[Stream] No content accumulated. The model may have returned only reasoning tokens.');
    return { content: 'No response received.', usage, finishReason: lastFinishReason };
  }

  return { content: accumulated, usage, finishReason: lastFinishReason };
}
