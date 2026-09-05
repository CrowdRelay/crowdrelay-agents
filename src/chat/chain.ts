/**
 * Chat fallback chain — resolves the ordered list of (endpoint, key, model)
 * targets to try when the operator sends a chat message.
 *
 * Extracted from routes/chat.ts so it can be unit-tested without pulling in
 * the Fastify/auth dependency tree (which uses .js extension imports that
 * node:test's --experimental-strip-types cannot resolve).
 */

import { PROVIDER_ENDPOINTS } from "../agent/endpoints.js";
import { PROVIDERS } from "../providers/registry.js";
import { getConnectedProviders, getCredential } from "../store/credentials.js";
import type { DbPool } from "../store/db.js";

/** Free Zen models, tried first (shared 100 req/day pool). */
const ZEN_CHAT_MODELS = [
  "nemotron-3.5-lightning-free",
  "mimo-v2.5-free",
  "deepseek-v4-flash-free",
] as const;

/** Free Groq models, tried after Zen fails. */
const GROQ_CHAT_MODELS = [
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-20b",
] as const;

/** Free OpenRouter models, tried if an OpenRouter key is connected. */
const OPENROUTER_FREE_MODELS = [
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "minimax/minimax-m3:free",
] as const;

/** One target in the chat fallback chain. */
export interface ChatTarget {
  endpoint: string;
  apiKey: string | null;
  model: string;
  label: string;
}

/** Options shared by both chat endpoints. */
export interface ChatOpts {
  zenToken: string | null;
  pool: DbPool;
  encryptionKey: string;
  previousEncryptionKey: string | null;
  fallbackGoogleKey: string | null;
  fallbackGroqKey: string | null;
}

/**
 * Resolves a provider's API key from platform env defaults or connected DB
 * credentials. Returns `undefined` when the provider is not configured (so
 * the chain skips it), `null` for a keyless call, or the key string.
 */
export async function resolveChatApiKey(
  providerId: string,
  opts: ChatOpts,
  workspaceId: string,
): Promise<string | null | undefined> {
  // Platform-level env defaults
  if (providerId === "groq") return opts.fallbackGroqKey ?? undefined;
  if (providerId === "google") return opts.fallbackGoogleKey ?? undefined;

  // Connected provider credential from DB
  const connected = await getConnectedProviders(opts.pool, workspaceId);
  if (!connected.includes(providerId)) return undefined;
  try {
    const cred = await getCredential(
      opts.pool,
      workspaceId,
      providerId,
      opts.encryptionKey,
      opts.previousEncryptionKey,
    );
    return cred?.decryptedValue ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the ordered list of (endpoint, key, model) targets to try.
 *
 * Priority:
 * 1. Zen free models (shared 100 req/day pool)
 * 2. Groq free models (platform key or connected credential)
 * 3. Google free model (gemini-3.6-flash, 250 req/day free tier)
 * 4. OpenRouter free models (connected credential only)
 * 5. Connected premium models (last resort — operator's own key)
 *
 * Anthropic is skipped because it uses a different protocol. The operator
 * can connect any OpenAI-compatible provider (OpenAI, Google, Groq,
 * OpenRouter, xAI, Copilot, Zhipu) for chat fallback.
 */
export async function buildChatChain(opts: ChatOpts, workspaceId: string): Promise<ChatTarget[]> {
  const chain: ChatTarget[] = [];
  const seen = new Set<string>();

  // 1. Zen free models
  if (opts.zenToken) {
    const zenEndpoint = PROVIDER_ENDPOINTS["opencode-zen"];
    for (const model of ZEN_CHAT_MODELS) {
      chain.push({ endpoint: zenEndpoint, apiKey: opts.zenToken, model, label: `zen/${model}` });
      seen.add(model);
    }
  }

  // 2. Groq free models
  const groqKey = await resolveChatApiKey("groq", opts, workspaceId);
  if (groqKey !== undefined) {
    const endpoint = PROVIDER_ENDPOINTS["groq"];
    for (const model of GROQ_CHAT_MODELS) {
      if (!seen.has(model)) {
        chain.push({ endpoint, apiKey: groqKey, model, label: `groq/${model}` });
        seen.add(model);
      }
    }
  }

  // 3. Google free model
  const googleKey = await resolveChatApiKey("google", opts, workspaceId);
  if (googleKey !== undefined) {
    const endpoint = PROVIDER_ENDPOINTS["google"];
    const model = "gemini-3.6-flash";
    if (!seen.has(model)) {
      chain.push({ endpoint, apiKey: googleKey, model, label: `google/${model}` });
      seen.add(model);
    }
  }

  // 4. OpenRouter free models
  const openrouterKey = await resolveChatApiKey("openrouter", opts, workspaceId);
  if (openrouterKey !== undefined) {
    const endpoint = PROVIDER_ENDPOINTS["openrouter"];
    for (const model of OPENROUTER_FREE_MODELS) {
      if (!seen.has(model)) {
        chain.push({ endpoint, apiKey: openrouterKey, model, label: `openrouter/${model}` });
        seen.add(model);
      }
    }
  }

  // 5. Connected premium models (OpenAI-compatible only)
  for (const provider of PROVIDERS) {
    if (provider.tier !== "premium" || provider.protocol !== "openai") continue;
    if (["opencode-zen", "google", "groq", "openrouter"].includes(provider.id)) continue;
    const key = await resolveChatApiKey(provider.id, opts, workspaceId);
    if (key === undefined) continue;
    const endpoint = PROVIDER_ENDPOINTS[provider.id];
    if (!endpoint) continue;
    for (const model of provider.models) {
      if (seen.has(model.id)) continue;
      chain.push({ endpoint, apiKey: key, model: model.id, label: `${provider.id}/${model.id}` });
      seen.add(model.id);
    }
  }

  return chain;
}

/** Upstream states worth trying a different model for. */
export function isTransientUpstream(status: number): boolean {
  return status === 401 || status === 404 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Walks the chat fallback chain until one model answers.
 *
 * Transient failures (including 401/404) advance to the next target. A shared
 * endpoint like Zen can return 401 for "model not supported" — the key is
 * valid, just the model was deprecated, so the next model in the chain is
 * likely to work. A 400 means the request itself is wrong and every model
 * will say the same, so it returns immediately rather than spending quota
 * to hear it twice more.
 */
export async function fetchWithModelFallback(
  chain: ChatTarget[],
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ response: Response; model: string } | { failure: string }> {
  let lastFailure = "no model was reachable";
  for (const target of chain) {
    let response: Response;
    try {
      response = await fetch(target.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...body, model: target.model }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      lastFailure = `${target.label} did not respond`;
      continue;
    }
    if (response.ok) return { response, model: target.model };
    const detail = await response.text().catch(() => "");
    if (!isTransientUpstream(response.status)) {
      return {
        failure: `${target.label} refused the request (HTTP ${response.status}) ${detail.slice(0, 160)}`.trim(),
      };
    }
    lastFailure = `${target.label} was unavailable (HTTP ${response.status})`;
  }
  return { failure: lastFailure };
}
