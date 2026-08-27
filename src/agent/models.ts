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
    id: "nemotron-3.5-lightning-free",
    provider: "opencode-zen",
    name: "Nemotron 3.5 Lightning Free (Zen, fast)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 128_000,
    bestFor: "General tasks, balanced reasoning and speed",
    requiresKey: false,
  },
  {
    id: "mimo-v2.5-free",
    provider: "opencode-zen",
    name: "MiMo v2.5 Free (Zen, quick)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 32_000,
    bestFor: "Quick tasks, short content generation",
    requiresKey: false,
  },
  {
    id: "laguna-s-2.1-free",
    provider: "opencode-zen",
    name: "Laguna S 2.1 Free (Zen, reasoning)",
    freeLimit: { requestsPerDay: 100 },
    contextWindow: 128_000,
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
