/**
 * Provider registry. Each provider knows:
 * - Which models it offers
 * - How to authenticate (api_key paste vs oauth)
 * - How to validate a credential
 * - Which LLM protocol it speaks (openai-compatible vs anthropic-native)
 */

export type AuthMethod = "api_key" | "oauth" | "none";
export type LlmProtocol = "openai" | "anthropic" | "google";

export interface ProviderDef {
  id: string;
  name: string;
  description: string;
  authMethod: AuthMethod;
  protocol: LlmProtocol;
  models: ProviderModel[];
  /** For api_key providers: validate by making a test API call */
  validateApiKey?: (apiKey: string) => Promise<{ valid: boolean; error?: string }>;
  /** For oauth providers: the OAuth scopes needed */
  oauthScopes?: string[];
  /** Whether this provider offers free models without any credential */
  freeTier?: boolean;
}

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  bestFor: string;
  paid: boolean;
}

// --- Validation functions ---

async function validateOpenAI(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `OpenAI returned ${res.status}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

async function validateAnthropic(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    // Minimal message request to validate the key
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    // 400 might mean the model is wrong but the key is valid
    if (res.status === 400 || res.status === 404) return { valid: true };
    return { valid: false, error: `Anthropic returned ${res.status}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

async function validateGoogle(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) return { valid: true };
    if (res.status === 403 || res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `Google returned ${res.status}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

async function validateGroq(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `Groq returned ${res.status}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

async function validateOpenRouter(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `OpenRouter returned ${res.status}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

// --- Provider definitions ---

export const PROVIDERS: ProviderDef[] = [
  {
    id: "opencode-zen",
    name: "OpenCode Zen (Free)",
    description: "Free tier, no API key needed. 100 requests/day across all Zen models.",
    authMethod: "none",
    protocol: "openai",
    freeTier: true,
    models: [
      { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free (128K)", contextWindow: 128_000, bestFor: "General tasks, balanced reasoning", paid: false },
      { id: "mimo-v2.5-free", name: "MiMo v2.5 Free (32K)", contextWindow: 32_000, bestFor: "Quick tasks, short content", paid: false },
      { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free (128K)", contextWindow: 128_000, bestFor: "Reasoning-heavy tasks", paid: false },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT-4o, GPT-4, o1, and more. Paste your API key from platform.openai.com.",
    authMethod: "api_key",
    protocol: "openai",
    validateApiKey: validateOpenAI,
    models: [
      { id: "gpt-4o", name: "GPT-4o (128K)", contextWindow: 128_000, bestFor: "Best overall, multimodal, fast", paid: true },
      { id: "gpt-4o-mini", name: "GPT-4o Mini (128K)", contextWindow: 128_000, bestFor: "Fast and cheap, good for bulk tasks", paid: true },
      { id: "o1", name: "o1 (200K)", contextWindow: 200_000, bestFor: "Deep reasoning, complex analysis", paid: true },
      { id: "o1-mini", name: "o1 Mini (128K)", contextWindow: 128_000, bestFor: "Reasoning at lower cost", paid: true },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    description: "Claude 3.5 Sonnet, Opus, Haiku. Paste your API key from console.anthropic.com.",
    authMethod: "api_key",
    protocol: "anthropic",
    validateApiKey: validateAnthropic,
    models: [
      { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet (200K)", contextWindow: 200_000, bestFor: "Excellent writing, analysis, coding", paid: true },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku (200K)", contextWindow: 200_000, bestFor: "Fast and affordable, good for content", paid: true },
      { id: "claude-3-opus-20240229", name: "Claude 3 Opus (200K)", contextWindow: 200_000, bestFor: "Most capable Claude, deep reasoning", paid: true },
    ],
  },
  {
    id: "google",
    name: "Google (Gemini)",
    description: "Gemini 2.0 Flash, 1.5 Pro. Connect via OAuth or paste an API key from AI Studio.",
    authMethod: "api_key", // oauth also supported, but api_key is the default
    protocol: "google",
    validateApiKey: validateGoogle,
    oauthScopes: ["https://www.googleapis.com/auth/generative-language"],
    models: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash (1M)", contextWindow: 1_000_000, bestFor: "Very fast, huge context, multilingual", paid: true },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro (2M)", contextWindow: 2_000_000, bestFor: "Largest context window, complex analysis", paid: true },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash (1M)", contextWindow: 1_000_000, bestFor: "Fast and cheap, good for bulk tasks", paid: true },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (1M)", contextWindow: 1_000_000, bestFor: "Latest flash, 250 req/day free tier", paid: false },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    description: "Llama 3.3 70B, Mixtral, and more. Ultra-fast inference. Paste your API key from console.groq.com.",
    authMethod: "api_key",
    protocol: "openai",
    validateApiKey: validateGroq,
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B (128K)", contextWindow: 128_000, bestFor: "Fast open-source model, good reasoning", paid: false },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant (128K)", contextWindow: 128_000, bestFor: "Very fast, simple tasks", paid: false },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter (All Models)",
    description: "One API key unlocks GPT-4, Claude, Gemini, Llama, and 200+ other models. Paste your key from openrouter.ai. You pay per-use through OpenRouter.",
    authMethod: "api_key",
    protocol: "openai",
    validateApiKey: validateOpenRouter,
    models: [
      { id: "openai/gpt-4o", name: "GPT-4o via OpenRouter", contextWindow: 128_000, bestFor: "Best overall, accessed through OpenRouter", paid: true },
      { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet via OpenRouter", contextWindow: 200_000, bestFor: "Excellent writing via OpenRouter", paid: true },
      { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash via OpenRouter", contextWindow: 1_000_000, bestFor: "Huge context via OpenRouter", paid: true },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B via OpenRouter", contextWindow: 128_000, bestFor: "Open-source via OpenRouter", paid: true },
    ],
  },
];

export function findProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Returns all models available to a tenant, given their connected providers.
 * Free-tier models are always available. Paid models require a connected credential.
 */
export function availableModels(connectedProviderIds: string[]): Array<ProviderModel & { providerId: string; providerName: string }> {
  const result: Array<ProviderModel & { providerId: string; providerName: string }> = [];
  for (const provider of PROVIDERS) {
    const isConnected = connectedProviderIds.includes(provider.id);
    for (const model of provider.models) {
      if (!model.paid || isConnected || provider.freeTier) {
        result.push({
          ...model,
          providerId: provider.id,
          providerName: provider.name,
        });
      }
    }
  }
  return result;
}

/**
 * Returns provider summaries for the frontend connection UI.
 */
export function providerSummaries() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    authMethod: p.authMethod,
    freeTier: p.freeTier ?? false,
    modelCount: p.models.length,
    oauthScopes: p.oauthScopes ?? [],
  }));
}
