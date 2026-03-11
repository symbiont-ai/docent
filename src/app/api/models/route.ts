// ==========================================================
// DOCENT — OpenRouter Models API Proxy
// Fetches available models from OpenRouter and returns a
// filtered, capability-annotated list for the smart model picker.
// ==========================================================

import { NextResponse } from 'next/server';
import type { ModelOption, ModelCapabilities, ModelPricing, PricingTier } from '@/src/types';

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    max_completion_tokens?: number;
  };
  supported_parameters?: string[];
}

// In-memory cache (survives across requests in the same server process)
let cachedModels: { data: OpenRouterModel[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET(request: Request) {
  try {
    const apiKey =
      request.headers.get('x-api-key') ||
      process.env.OPENROUTER_API_KEY ||
      '';

    if (!apiKey) {
      return NextResponse.json(
        { error: 'No API key provided. Set your OpenRouter key in Settings.' },
        { status: 401 },
      );
    }

    // Return cached if fresh
    if (cachedModels && Date.now() - cachedModels.timestamp < CACHE_TTL) {
      return NextResponse.json({ models: formatModels(cachedModels.data) });
    }

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://docent.app',
        'X-Title': 'Docent',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        { error: `OpenRouter error ${response.status}: ${errText.substring(0, 200)}` },
        { status: response.status },
      );
    }

    const data = await response.json();
    const models: OpenRouterModel[] = data?.data || [];

    // Cache the raw response
    cachedModels = { data: models, timestamp: Date.now() };

    return NextResponse.json({ models: formatModels(models) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── Pricing tier from cost per 1M input tokens ────────────
function computePricingTier(per1M: number): PricingTier {
  if (per1M === 0) return 'free';
  if (per1M < 1) return 'budget';
  if (per1M <= 10) return 'standard';
  return 'premium';
}

// ── Extract provider display name from model ID ──────────
function extractProvider(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash === -1) return 'Unknown';
  const raw = modelId.substring(0, slash);
  const providerMap: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    'meta-llama': 'Meta',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    mistralai: 'Mistral',
    cohere: 'Cohere',
    'x-ai': 'xAI',
    perplexity: 'Perplexity',
    nvidia: 'NVIDIA',
    microsoft: 'Microsoft',
  };
  return providerMap[raw] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ── Quality score for ranking recommended models ─────────
// Higher = better. Weighs capabilities Docent cares about most.
function computeQualityScore(m: ModelOption): number {
  let score = 0;
  // Capabilities (most important for Docent)
  if (m.capabilities.vision) score += 30;       // essential for PDF analysis
  if (m.capabilities.reasoning) score += 25;    // deep thinking & better slides
  if (m.capabilities.jsonOutput) score += 20;   // structured slide generation
  if (m.capabilities.tools) score += 5;         // nice-to-have
  // Context length (log-scaled bonus — 1M ctx is valuable but not 10x more than 128k)
  score += Math.min(20, Math.log2(m.contextLength / 1000) * 3);
  // Value: prefer lower cost (budget models get a bump)
  if (m.pricing.tier === 'free') score += 10;
  else if (m.pricing.tier === 'budget') score += 8;
  else if (m.pricing.tier === 'standard') score += 4;
  // premium gets 0 bonus
  return score;
}

// ── Filter, enrich, and sort models ──────────────────────
function formatModels(models: OpenRouterModel[]): ModelOption[] {
  return models
    .filter((m) => {
      const id = m.id.toLowerCase();
      // Exclude embeddings, moderation, and image-generation-only models
      if (id.includes('embed') || id.includes('moderat')) return false;
      if (id.includes('image') && !id.includes('vision')) return false;
      // Must support text output
      const outMods = m.architecture?.output_modalities || [];
      if (outMods.length > 0 && !outMods.includes('text')) return false;
      return true;
    })
    .map((m): ModelOption => {
      const params = m.supported_parameters || [];
      const inputMods = m.architecture?.input_modalities || [];

      const capabilities: ModelCapabilities = {
        vision: inputMods.includes('image'),
        reasoning: params.includes('reasoning'),
        tools: params.includes('tools'),
        jsonOutput: params.includes('json_mode') || params.includes('structured_outputs'),
      };

      const promptCostPerToken = parseFloat(m.pricing?.prompt || '0');
      const completionCostPerToken = parseFloat(m.pricing?.completion || '0');
      const promptPer1M = promptCostPerToken * 1_000_000;
      const completionPer1M = completionCostPerToken * 1_000_000;

      const pricing: ModelPricing = {
        promptPer1M,
        completionPer1M,
        tier: computePricingTier(promptPer1M),
      };

      // Recommended: vision + (reasoning or JSON) + context >= 32k
      const contextLength = m.context_length || 0;
      const recommended =
        capabilities.vision &&
        (capabilities.reasoning || capabilities.jsonOutput) &&
        contextLength >= 32000;

      return {
        id: m.id,
        name: m.name || m.id,
        provider: extractProvider(m.id),
        contextLength,
        maxCompletionTokens: m.top_provider?.max_completion_tokens || 32000,
        capabilities,
        pricing,
        recommended,
      };
    })
    .sort((a, b) => {
      // Recommended first
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      // Within recommended: sort by quality score (highest first)
      if (a.recommended && b.recommended) {
        return computeQualityScore(b) - computeQualityScore(a);
      }
      // Non-recommended: sort by quality score too
      return computeQualityScore(b) - computeQualityScore(a);
    });
}
