/**
 * Provider registry. Each provider knows:
 * - Which models it offers
 * - How to authenticate (api_key paste or none)
 * - How to validate a credential
 * - Which LLM protocol it speaks (openai-compatible vs anthropic-native)
 */

export type AuthMethod = "api_key" | "none";
export type LlmProtocol = "openai" | "anthropic" | "google";

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  bestFor: string;
  paid: boolean;
  /** Approximate USD per million tokens. Absent = unknown (cost tracked as 0). */
  pricing?: { inputPerMTokUsd: number; outputPerMTokUsd: number };
  /**
   * Marks an agentic session model (currently only Cognition/Devin). The runner
   * dispatches these via callDevinSession() instead of callOpenAICompatible() —
   * the session runs autonomously with shell/file/web/sub-agent access.
   */
  agentic?: boolean;
}

export interface ProviderDef {
  id: string;
  name: string;
  description: string;
  authMethod: AuthMethod;
  protocol: LlmProtocol;
  models: ProviderModel[];
  /** For api_key providers: validate by making a test API call */
  validateApiKey?: (apiKey: string) => Promise<{ valid: boolean; error?: string }>;
  /** Whether this provider offers free models without any credential */
  freeTier?: boolean;
  /**
   * Tier controls which UI tab a provider appears in:
   * - "premium": providers that appear in the Premium AI tab. These support
   *   API key paste. The brain routes complex tasks to these.
   * - "free": API-key-only or no-key providers that appear in the Providers
   *   tab. These are developer-accessible models for simpler tasks.
   */
  tier: "premium" | "free";
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
      // Note: if this model is retired, the 400/404 fallback below
      // still treats it as "key is valid" — only 401 means bad key.
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
      "https://generativelanguage.googleapis.com/v1beta/models",
      {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(10_000),
      },
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

async function validateXAI(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `xAI returned ${res.status}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

async function validateZhipu(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const baseUrl = process.env.ZHIPU_API_BASE_URL?.replace(/\/chat\/completions\/?$/, "") ?? "https://api.z.ai/api/paas/v4";
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `Zhipu returned ${res.status}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

async function validateCognition(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    // The Devin API uses cog_ prefixed keys. Validate by calling the /v3/self endpoint.
    const res = await fetch("https://api.devin.ai/v3/self", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `Cognition returned ${res.status}` };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

/**
 * Basic non-empty check for providers that don't expose a public validation
 * endpoint (e.g. GitHub Copilot). A real API key is always non-empty.
 */
async function validateNonEmpty(key: string): Promise<{ valid: boolean; error?: string }> {
  if (!key || key.trim().length === 0) {
    return { valid: false, error: "API key is empty" };
  }
  return { valid: true };
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
    tier: "free",
    models: [
      { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free (128K)", contextWindow: 128_000, bestFor: "General tasks, balanced reasoning", paid: false },
      { id: "mimo-v2.5-free", name: "MiMo v2.5 Free (32K)", contextWindow: 32_000, bestFor: "Quick tasks, short content", paid: false },
      { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free (128K)", contextWindow: 128_000, bestFor: "Reasoning-heavy tasks", paid: false },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description:
      "GPT-4o, o3, o1, and more. Connect with an API key from platform.openai.com.",
    authMethod: "api_key",
    protocol: "openai",
    tier: "premium",
    validateApiKey: validateOpenAI,
    models: [
      { id: "o3", name: "o3 (200K)", contextWindow: 200_000, bestFor: "Most powerful OpenAI, deep reasoning, complex analysis", paid: true, pricing: { inputPerMTokUsd: 15, outputPerMTokUsd: 60 } },
      { id: "gpt-4o", name: "GPT-4o (128K)", contextWindow: 128_000, bestFor: "Best overall, multimodal, fast", paid: true, pricing: { inputPerMTokUsd: 2.5, outputPerMTokUsd: 10 } },
      { id: "o1", name: "o1 (200K)", contextWindow: 200_000, bestFor: "Deep reasoning, complex analysis", paid: true, pricing: { inputPerMTokUsd: 15, outputPerMTokUsd: 60 } },
      { id: "gpt-4o-mini", name: "GPT-4o Mini (128K)", contextWindow: 128_000, bestFor: "Fast and cheap, good for bulk tasks", paid: true, pricing: { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 } },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    description:
      "Claude Opus 4.1, Sonnet 4, Haiku. Connect with an API key from console.anthropic.com.",
    authMethod: "api_key",
    protocol: "anthropic",
    tier: "premium",
    validateApiKey: validateAnthropic,
    models: [
      { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1 (200K)", contextWindow: 200_000, bestFor: "Most powerful Claude, deep reasoning, complex coding", paid: true, pricing: { inputPerMTokUsd: 15, outputPerMTokUsd: 75 } },
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (200K)", contextWindow: 200_000, bestFor: "Excellent writing, analysis, coding", paid: true, pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku (200K)", contextWindow: 200_000, bestFor: "Fast and affordable, good for content", paid: true, pricing: { inputPerMTokUsd: 0.8, outputPerMTokUsd: 4 } },
    ],
  },
  {
    id: "google",
    name: "Google (Gemini)",
    description: "Gemini 2.0 Flash, 1.5 Pro. Paste an API key from AI Studio.",
    authMethod: "api_key",
    protocol: "openai", // Google exposes an OpenAI-compatible endpoint
    tier: "premium",
    validateApiKey: validateGoogle,
    models: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash (1M)", contextWindow: 1_000_000, bestFor: "Very fast, huge context, multilingual", paid: true, pricing: { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.4 } },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro (2M)", contextWindow: 2_000_000, bestFor: "Largest context window, complex analysis", paid: true, pricing: { inputPerMTokUsd: 1.25, outputPerMTokUsd: 5 } },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash (1M)", contextWindow: 1_000_000, bestFor: "Fast and cheap, good for bulk tasks", paid: true, pricing: { inputPerMTokUsd: 0.075, outputPerMTokUsd: 0.3 } },
      { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash (1M)", contextWindow: 1_000_000, bestFor: "Latest flash, 250 req/day free tier", paid: false, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    description: "Llama 3.3 70B, Mixtral, and more. Ultra-fast inference. Paste your API key from console.groq.com.",
    authMethod: "api_key",
    protocol: "openai",
    tier: "free",
    validateApiKey: validateGroq,
    models: [
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B (128K)", contextWindow: 128_000, bestFor: "Strong reasoning, fast inference", paid: false, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
      { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B (128K)", contextWindow: 128_000, bestFor: "Very fast, good multilingual", paid: false, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
      { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B (128K)", contextWindow: 128_000, bestFor: "Fast, lightweight tasks", paid: false, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter (All Models)",
    description:
      "One connection unlocks GPT-4, Claude, Gemini, Llama, and 200+ other models. Paste your API key from openrouter.ai/keys.",
    authMethod: "api_key",
    protocol: "openai",
    tier: "premium",
    validateApiKey: validateOpenRouter,
    models: [
      { id: "openai/o3", name: "o3 via OpenRouter", contextWindow: 200_000, bestFor: "Most powerful OpenAI, accessed through OpenRouter", paid: true, pricing: { inputPerMTokUsd: 17, outputPerMTokUsd: 66 } },
      { id: "anthropic/claude-opus-4.1", name: "Claude Opus 4.1 via OpenRouter", contextWindow: 200_000, bestFor: "Most powerful Claude via OpenRouter", paid: true, pricing: { inputPerMTokUsd: 17, outputPerMTokUsd: 82 } },
      { id: "openai/gpt-4o", name: "GPT-4o via OpenRouter", contextWindow: 128_000, bestFor: "Best overall, accessed through OpenRouter", paid: true, pricing: { inputPerMTokUsd: 2.75, outputPerMTokUsd: 11 } },
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4 via OpenRouter", contextWindow: 200_000, bestFor: "Excellent writing via OpenRouter", paid: true, pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash via OpenRouter", contextWindow: 1_000_000, bestFor: "Huge context via OpenRouter", paid: true, pricing: { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.4 } },
      { id: "x-ai/grok-4.6", name: "Grok 4.6 via OpenRouter", contextWindow: 500_000, bestFor: "Grok's latest, accessed through OpenRouter", paid: true, pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      { id: "z-ai/glm-5.2:free", name: "GLM-5.2 Free via OpenRouter", contextWindow: 200_000, bestFor: "Free tier of GLM-5.2 — same family as Devin's GLM-5.2 High", paid: false, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
      { id: "nvidia/nemotron-3-ultra:free", name: "Nemotron 3 Ultra Free via OpenRouter", contextWindow: 1_000_000, bestFor: "Most-used free model on OpenRouter, 1M context, strong reasoning", paid: false, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
      { id: "minimax/m3:free", name: "MiniMax M3 Free via OpenRouter", contextWindow: 1_000_000, bestFor: "Strong general-purpose model, 1M context", paid: false, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
      { id: "nvidia/nemotron-3-super:free", name: "Nemotron 3 Super Free via OpenRouter", contextWindow: 262_000, bestFor: "Fast reasoning, good for structured output", paid: false, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } },
    ],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    description: "Grok 4.6, 4.5, and 4.3. Paste your API key from console.x.ai. OpenAI-compatible endpoint.",
    authMethod: "api_key",
    protocol: "openai",
    tier: "premium",
    validateApiKey: validateXAI,
    models: [
      { id: "grok-4.6", name: "Grok 4.6 (500K)", contextWindow: 500_000, bestFor: "Most intelligent Grok, code and chat", paid: true, pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      { id: "grok-4.5", name: "Grok 4.5 (500K)", contextWindow: 500_000, bestFor: "Strong reasoning, balanced cost", paid: true, pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
      { id: "grok-4.3", name: "Grok 4.3 (1M)", contextWindow: 1_000_000, bestFor: "Largest context, cost-effective", paid: true, pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 } },
    ],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    description:
      "Use your Copilot subscription to run models like GPT-4o and Claude. Paste your Copilot API key.",
    authMethod: "api_key",
    protocol: "openai",
    tier: "premium",
    validateApiKey: validateNonEmpty,
    models: [
      { id: "gpt-4o", name: "GPT-4o via Copilot", contextWindow: 128_000, bestFor: "Best overall through your Copilot plan", paid: false },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4 via Copilot", contextWindow: 200_000, bestFor: "Excellent writing through your Copilot plan", paid: false },
      { id: "gemini-2.0-flash-001", name: "Gemini 2.0 Flash via Copilot", contextWindow: 1_000_000, bestFor: "Huge context through your Copilot plan", paid: false },
    ],
  },
  {
    id: "zhipu",
    name: "Zhipu AI (GLM)",
    description:
      "GLM-5.3, GLM-5.1 — powerful Chinese AI models with strong agentic and tool-use capabilities. OpenAI-compatible API. Paste your API key from open.bigmodel.cn (China) or z.ai (international).",
    authMethod: "api_key",
    protocol: "openai",
    tier: "premium",
    validateApiKey: validateZhipu,
    models: [
      { id: "glm-5.3", name: "GLM-5.3 (128K)", contextWindow: 128_000, bestFor: "Latest flagship, strong agentic tasks and tool use", paid: true, pricing: { inputPerMTokUsd: 0.5, outputPerMTokUsd: 1.5 } },
      { id: "glm-5.2", name: "GLM-5.2 (128K)", contextWindow: 128_000, bestFor: "Powerful reasoning, same family as Devin's GLM-5.2 High", paid: true, pricing: { inputPerMTokUsd: 0.4, outputPerMTokUsd: 1.2 } },
      { id: "glm-5.1", name: "GLM-5.1 (128K)", contextWindow: 128_000, bestFor: "Balanced reasoning, cost-effective", paid: true, pricing: { inputPerMTokUsd: 0.25, outputPerMTokUsd: 0.75 } },
    ],
  },
  {
    id: "cognition",
    name: "Cognition (Devin)",
    description:
      "Devin agentic sessions powered by GLM-5.2 High. Unlike other providers, Devin runs autonomously — it can use shell, files, web search, and spawn sub-agents to complete complex multi-step tasks. Paste your Devin API key (cog_...) and organization ID (org-...) from settings.devin.ai.",
    authMethod: "api_key",
    tier: "premium",
    // Devin uses a session API, not chat completions — but we set "openai" here
    // so the credential route accepts it. The runner dispatches via callDevinSession()
    // instead of callOpenAICompatible() based on the model's `agentic` flag.
    protocol: "openai",
    validateApiKey: validateCognition,
    models: [
      { id: "devin-glm-5.2-high", name: "Devin (GLM-5.2 High, agentic)", contextWindow: 200_000, bestFor: "Autonomous multi-step tasks: deep research, complex analysis, sub-agent orchestration", paid: true, pricing: { inputPerMTokUsd: 0, outputPerMTokUsd: 0 }, agentic: true },
    ],
  },
];

export function findProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Approximate USD cost of a call, in micro-USD (1e-6). Unknown prices count
 * as 0 but the usage row still records the request.
 */
export function estimateCostMicroUsd(model: ProviderModel, tokensIn: number, tokensOut: number): number {
  if (!model.pricing) return 0;
  const cost =
    (tokensIn / 1_000_000) * model.pricing.inputPerMTokUsd +
    (tokensOut / 1_000_000) * model.pricing.outputPerMTokUsd;
  return Math.round(cost * 1_000_000);
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
    tier: p.tier,
    modelCount: p.models.length,
    supportsApiKeyPaste: typeof p.validateApiKey === "function",
  }));
}
