export interface ModelDef {
  id: string;
  provider: string;
  name: string;
  freeLimit: { requestsPerDay?: number; rateLimitRpm?: number };
  contextWindow: number;
  bestFor: string;
  requiresKey: boolean;
}

/**
 * Free-tier model catalog. Ordered by fallback priority — the runner tries
 * each in order until one succeeds.
 */
export const MODELS: ModelDef[] = [
  {
    id: "laguna-s-2.1-free",
    provider: "opencode-zen",
    name: "Laguna S 2.1 Free (Zen, fast, 128K)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 128_000,
    bestFor: "General tasks, balanced reasoning and speed",
    requiresKey: false,
  },
  {
    id: "nemotron-3.5-lightning-free",
    provider: "opencode-zen",
    name: "Nemotron 3.5 Lightning Free (Zen, reasoning)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 128_000,
    bestFor: "Reasoning-heavy tasks, long context analysis",
    requiresKey: false,
  },
  {
    id: "mimo-v2.5-free",
    provider: "opencode-zen",
    name: "MiMo v2.5 Free (Zen, quick, 32K)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 32_000,
    bestFor: "Quick tasks, short content generation",
    requiresKey: false,
  },
  {
    id: "gemini-3.6-flash",
    provider: "google",
    name: "Gemini 3.6 Flash (250 req/day free, 1M context)",
    freeLimit: { requestsPerDay: 250, rateLimitRpm: 15 },
    contextWindow: 1_000_000,
    bestFor: "Long context, large data seeding, multilingual",
    requiresKey: true,
  },
  {
    id: "openai/gpt-oss-120b",
    provider: "groq",
    name: "Groq GPT-OSS 120B (fast, strong reasoning)",
    freeLimit: { requestsPerDay: 14_400, rateLimitRpm: 30 },
    contextWindow: 128_000,
    bestFor: "Fast research, analysis, structured output",
    requiresKey: true,
  },
  {
    id: "z-ai/glm-5.2:free",
    provider: "openrouter",
    name: "GLM-5.2 Free (via OpenRouter, 200K context)",
    freeLimit: { requestsPerDay: 50, rateLimitRpm: 20 },
    contextWindow: 200_000,
    bestFor: "Powerful reasoning — same model family as Devin's GLM-5.2 High",
    requiresKey: true,
  },
];

// ─── Premium model registry ──────────────────────────────────────────────
//
// Intelligent token optimization: these are the powerful models that
// connected credentials unlock. The runner uses this list when a task is
// classified as tier="premium" — it filters to models from connected
// providers and selects the best available.
//
// Premium tasks handle stakes: human contact (press pitches, community
// posts), complex analysis (audience research, release planning), and
// deep multi-step work (Devin agentic sessions).

export interface PremiumModelDef {
  id: string;
  provider: string;
  name: string;
  contextWindow: number;
  bestFor: string;
  /** USD per million input tokens. */
  priceInputPerMTok: number;
  /** USD per million output tokens. */
  priceOutputPerMTok: number;
  /**
   * Marks an agentic session model (currently only Cognition/Devin). The
   * runner dispatches these via callDevinSession() instead of the standard
   * chat completions path — the session runs autonomously.
   */
  agentic?: boolean;
}

export const PREMIUM_MODELS: PremiumModelDef[] = [
  // Anthropic — BYOK
  {
    id: "claude-opus-4-1-20250805",
    provider: "anthropic",
    name: "Claude Opus 4.1",
    contextWindow: 200_000,
    bestFor: "Most powerful Claude, deep reasoning, complex coding",
    priceInputPerMTok: 15,
    priceOutputPerMTok: 75,
  },
  {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    bestFor: "Excellent writing, analysis, coding",
    priceInputPerMTok: 3,
    priceOutputPerMTok: 15,
  },
  // OpenAI — BYOK
  {
    id: "gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    contextWindow: 128_000,
    bestFor: "Best overall, multimodal, fast",
    priceInputPerMTok: 2.5,
    priceOutputPerMTok: 10,
  },
  {
    id: "o3",
    provider: "openai",
    name: "o3",
    contextWindow: 200_000,
    bestFor: "Deep reasoning, complex analysis",
    priceInputPerMTok: 15,
    priceOutputPerMTok: 60,
  },
  // Google — BYOK
  {
    id: "gemini-1.5-pro",
    provider: "google",
    name: "Gemini 1.5 Pro",
    contextWindow: 2_000_000,
    bestFor: "Largest context window, complex analysis",
    priceInputPerMTok: 1.25,
    priceOutputPerMTok: 5,
  },
  // xAI — BYOK only
  {
    id: "grok-4.6",
    provider: "xai",
    name: "Grok 4.6",
    contextWindow: 500_000,
    bestFor: "Most intelligent Grok, code and chat",
    priceInputPerMTok: 3,
    priceOutputPerMTok: 15,
  },
  // Zhipu AI (GLM) — BYOK only, OpenAI-compatible
  {
    id: "glm-5.3",
    provider: "zhipu",
    name: "GLM-5.3",
    contextWindow: 128_000,
    bestFor: "Strong agentic tasks and tool use, cost-effective",
    priceInputPerMTok: 0.5,
    priceOutputPerMTok: 1.5,
  },
  {
    id: "glm-5.2",
    provider: "zhipu",
    name: "GLM-5.2",
    contextWindow: 128_000,
    bestFor: "Powerful reasoning, same family as Devin's GLM-5.2 High",
    priceInputPerMTok: 0.4,
    priceOutputPerMTok: 1.2,
  },
  {
    id: "glm-5.1",
    provider: "zhipu",
    name: "GLM-5.1",
    contextWindow: 128_000,
    bestFor: "Balanced reasoning, very cost-effective",
    priceInputPerMTok: 0.25,
    priceOutputPerMTok: 0.75,
  },
  // Cognition (Devin) — BYOK, agentic session API (NOT chat completions)
  // The session runs GLM-5.2 High with full agentic capabilities: shell,
  // file editing, web search, sub-agent spawning. The runner creates a
  // session and polls for completion — the session is the orchestrator.
  {
    id: "devin-glm-5.2-high",
    provider: "cognition",
    name: "Devin (GLM-5.2 High, agentic)",
    contextWindow: 200_000,
    bestFor: "Autonomous multi-step tasks: deep research, complex analysis, sub-agent orchestration",
    priceInputPerMTok: 0,
    priceOutputPerMTok: 0,
    agentic: true,
  },
  // OpenRouter — BYOK, aggregates many models
  {
    id: "anthropic/claude-sonnet-4",
    provider: "openrouter",
    name: "Claude Sonnet 4 (via OpenRouter)",
    contextWindow: 200_000,
    bestFor: "Excellent writing via OpenRouter",
    priceInputPerMTok: 3,
    priceOutputPerMTok: 15,
  },
  {
    id: "openai/gpt-4o",
    provider: "openrouter",
    name: "GPT-4o (via OpenRouter)",
    contextWindow: 128_000,
    bestFor: "Best overall via OpenRouter",
    priceInputPerMTok: 2.75,
    priceOutputPerMTok: 11,
  },
  // GitHub Copilot — BYOK, subscriber benefit
  {
    id: "gpt-4o",
    provider: "github-copilot",
    name: "GPT-4o (via Copilot)",
    contextWindow: 128_000,
    bestFor: "Best overall through your Copilot plan",
    priceInputPerMTok: 0,
    priceOutputPerMTok: 0,
  },
];

/**
 * Finds premium models available to a workspace based on connected providers.
 * Returns models in priority order: agentic (Devin) first for complex tasks,
 * then by provider preference.
 */
export function availablePremiumModels(
  connectedProviderIds: string[],
): PremiumModelDef[] {
  return PREMIUM_MODELS.filter((m) => connectedProviderIds.includes(m.provider));
}

/**
 * Finds a premium model by ID and provider. Used by the runner when a
 * template specifies a recommended model.
 */
export function findPremiumModel(
  modelId: string,
  providerId: string,
): PremiumModelDef | undefined {
  return PREMIUM_MODELS.find((m) => m.id === modelId && m.provider === providerId);
}

/**
 * Estimates the cost of a premium call in micro-USD (1/1,000,000 USD).
 * Used for budget tracking — the runner records this after each premium call.
 */
export function estimatePremiumCostMicroUsd(
  model: PremiumModelDef,
  tokensIn: number,
  tokensOut: number,
): number {
  const cost =
    (tokensIn / 1_000_000) * model.priceInputPerMTok +
    (tokensOut / 1_000_000) * model.priceOutputPerMTok;
  return Math.round(cost * 1_000_000);
}
