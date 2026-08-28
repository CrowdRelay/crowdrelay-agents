/**
 * Static map of provider ID → OpenAI-compatible chat completions endpoint.
 * Shared by the runner (generation) and the verifier (verification pass)
 * to avoid a circular import between the two modules.
 */
export const PROVIDER_ENDPOINTS: Record<string, string> = {
  "opencode-zen": "https://opencode.ai/zen/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  xai: "https://api.x.ai/v1/chat/completions",
  "github-copilot": "https://api.githubcopilot.com/chat/completions",
  // Zhipu AI (GLM) — OpenAI-compatible. International endpoint by default;
  // China endpoint configurable via ZHIPU_API_BASE_URL env var.
  zhipu: process.env.ZHIPU_API_BASE_URL ?? "https://api.z.ai/api/paas/v4/chat/completions",
};
