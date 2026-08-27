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
    id: "claude-sonnet-5",
    provider: "opencode-zen",
    name: "Claude Sonnet 5 (Zen, 200K context)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 200_000,
    bestFor: "General tasks, balanced reasoning and speed",
    requiresKey: false,
  },
  {
    id: "gemini-3.5-flash",
    provider: "opencode-zen",
    name: "Gemini 3.5 Flash (Zen, fast)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 128_000,
    bestFor: "Quick tasks, short content generation",
    requiresKey: false,
  },
  {
    id: "deepseek-v4-flash-free",
    provider: "opencode-zen",
    name: "DeepSeek V4 Flash Free (200K context)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 200_000,
    bestFor: "Reasoning-heavy tasks, long context analysis",
    requiresKey: false,
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    name: "Gemini 2.5 Flash (250 req/day free)",
    freeLimit: { requestsPerDay: 250, rateLimitRpm: 15 },
    contextWindow: 1_000_000,
    bestFor: "Long context, large data seeding, multilingual",
    requiresKey: true,
  },
  {
    id: "groq/llama-3.3-70b",
    provider: "groq",
    name: "Groq Llama 3.3 70B (fast inference)",
    freeLimit: { requestsPerDay: 14_400, rateLimitRpm: 30 },
    contextWindow: 128_000,
    bestFor: "Fast research, analysis, structured output",
    requiresKey: true,
  },
];

export function findModel(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}

/**
 * Returns fallback chain for a model: the model itself, then all other
 * free models that don't require a key.
 */
export function fallbackChain(modelId: string, availableKeys: { google?: boolean; groq?: boolean }): ModelDef[] {
  const primary = findModel(modelId);
  const chain: ModelDef[] = [];
  if (primary) chain.push(primary);
  for (const m of MODELS) {
    if (m.id === modelId) continue;
    if (m.requiresKey && m.provider === "google" && !availableKeys.google) continue;
    if (m.requiresKey && m.provider === "groq" && !availableKeys.groq) continue;
    chain.push(m);
  }
  return chain;
}
