import { PROVIDERS } from "../providers/registry.js";

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
 *
 * Derived from `PROVIDERS` in the registry: any model with `paid === false`
 * is a free model. The `freeLimit` is a per-provider heuristic (not stored in
 * the registry) so it is applied here based on the provider id.
 */
function freeLimitForProvider(providerId: string): { requestsPerDay?: number; rateLimitRpm?: number } {
  switch (providerId) {
    case "google":
      return { requestsPerDay: 250, rateLimitRpm: 15 };
    case "groq":
      return { requestsPerDay: 14_400, rateLimitRpm: 30 };
    case "openrouter":
      return { requestsPerDay: 50, rateLimitRpm: 20 };
    case "opencode-zen":
    default:
      return { requestsPerDay: 100 };
  }
}

export const MODELS: ModelDef[] = PROVIDERS.flatMap((p) =>
  p.models
    .filter((m) => !m.paid)
    .map((m) => ({
      id: m.id,
      provider: p.id,
      name: m.name,
      freeLimit: freeLimitForProvider(p.id),
      contextWindow: m.contextWindow,
      bestFor: m.bestFor,
      requiresKey: !p.freeTier,
    })),
);

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
//
// Derived from `PROVIDERS` in the registry: any model with `paid === true`
// is a premium model.

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

export const PREMIUM_MODELS: PremiumModelDef[] = PROVIDERS.flatMap((p) =>
  p.models
    .filter((m) => m.paid === true)
    .map((m) => ({
      id: m.id,
      provider: p.id,
      name: m.name,
      contextWindow: m.contextWindow,
      bestFor: m.bestFor,
      priceInputPerMTok: m.pricing?.inputPerMTokUsd ?? 0,
      priceOutputPerMTok: m.pricing?.outputPerMTokUsd ?? 0,
      agentic: m.agentic,
    })),
);

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
