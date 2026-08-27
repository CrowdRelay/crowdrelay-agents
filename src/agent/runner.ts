import type { DbPool } from "../store/db.js";
import type { AgentTemplate } from "../templates/catalog.js";
import { findTool } from "../mcp/tools.js";
import { findProvider, type ProviderDef, type ProviderModel } from "../providers/registry.js";
import { getCredential, getConnectedProviders } from "../store/credentials.js";
import { updateTaskStatus, saveResult } from "../store/tasks.js";
import { callOpenAICompatible, type LlmResponse } from "./opencode.js";
import { callAnthropic } from "./anthropic.js";

export interface RunConfig {
  pool: DbPool;
  taskId: string;
  workspaceId: string;
  template: AgentTemplate;
  modelId: string;
  prompt: string;
  encryptionKey: string;
  zenToken: string | null;
  fallbackGoogleKey: string | null;
  fallbackGroqKey: string | null;
}

/**
 * Orchestrates a single agent task:
 * 1. Pull tenant data via MCP tools (data scope from template)
 * 2. Build the full prompt from template + data + operator input
 * 3. Resolve the model + credential (tenant-specific or free fallback)
 * 4. Call the LLM (with fallback chain)
 * 5. Store the result
 */
export async function runTask(config: RunConfig): Promise<void> {
  const { pool, taskId, workspaceId, template, prompt } = config;

  await updateTaskStatus(pool, taskId, "running");

  try {
    // 1. Pull tenant data via MCP tools
    const seededData: Record<string, unknown> = {};
    for (const toolName of template.dataScope) {
      const tool = findTool(toolName);
      if (!tool) continue;
      try {
        seededData[toolName] = await tool.execute(pool, workspaceId, {});
      } catch (err) {
        console.error(`MCP tool ${toolName} failed:`, err);
        seededData[toolName] = { error: "data unavailable" };
      }
    }

    // 2. Build the full prompt
    const systemPrompt = template.systemPrompt;
    const userPrompt = template.buildPrompt(prompt, seededData);

    // 3. Resolve model + credential
    const modelChain = await resolveModelChain(config);
    let response: LlmResponse | null = null;
    let lastError: string | null = null;
    let modelUsed = "";

    for (const { provider, model, apiKey } of modelChain) {
      try {
        response = await callLLM(provider, model, apiKey, systemPrompt, userPrompt);
        modelUsed = model.id;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`Model ${model.id} (${provider.id}) failed:`, lastError);
        continue;
      }
    }

    if (!response) {
      throw new Error(`All models failed. Last error: ${lastError}`);
    }

    // 5. Store the result
    await saveResult(pool, taskId, workspaceId, {
      content: response.content,
      format: template.outputFormat,
      model_used: modelUsed,
      tokens_in: response.tokensIn ?? undefined,
      tokens_out: response.tokensOut ?? undefined,
      duration_ms: response.durationMs ?? undefined,
    });

    await updateTaskStatus(pool, taskId, "completed");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await updateTaskStatus(pool, taskId, "failed", errorMsg);
  }
}

/**
 * Resolves the chain of (provider, model, apiKey) tuples to try.
 * Priority:
 * 1. The requested model — if the tenant has a credential for its provider, use it
 * 2. Free-tier models (Zen, Groq free, Gemini free)
 * 3. Other connected providers that have compatible models
 */
async function resolveModelChain(
  config: RunConfig,
): Promise<Array<{ provider: ProviderDef; model: ProviderModel; apiKey: string | null }>> {
  const { pool, workspaceId, modelId, encryptionKey } = config;
  const chain: Array<{ provider: ProviderDef; model: ProviderModel; apiKey: string | null }> = [];
  const connectedProviders = await getConnectedProviders(pool, workspaceId);

  // Search all providers for the requested model
  let requestedProvider: ProviderDef | undefined;
  let requestedModel: ProviderModel | undefined;
  for (const provider of allProviders()) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) {
      requestedProvider = provider;
      requestedModel = model;
      break;
    }
  }

  // 1. Try the requested model first
  if (requestedProvider && requestedModel) {
    const apiKey = await resolveApiKey(requestedProvider, config, connectedProviders, encryptionKey);
    if (apiKey !== undefined) {
      chain.push({ provider: requestedProvider, model: requestedModel, apiKey });
    }
  }

  // 2. Add fallback models from free tier + connected providers
  for (const provider of allProviders()) {
    // Skip the requested provider (already added above)
    if (requestedProvider?.id === provider.id) continue;

    for (const model of provider.models) {
      // Skip paid models if no credential
      if (model.paid && !connectedProviders.includes(provider.id) && !provider.freeTier) continue;

      const apiKey = await resolveApiKey(provider, config, connectedProviders, encryptionKey);
      if (apiKey !== undefined) {
        chain.push({ provider, model, apiKey });
      }
    }
  }

  return chain;
}

async function resolveApiKey(
  provider: ProviderDef,
  config: RunConfig,
  connectedProviders: string[],
  encryptionKey: string,
): Promise<string | null | undefined> {
  // Free tier — no key needed
  if (provider.authMethod === "none" || provider.freeTier) {
    if (provider.id === "opencode-zen") return config.zenToken;
    return null;
  }

  // Check if tenant has a stored credential for this provider
  if (connectedProviders.includes(provider.id)) {
    const cred = await getCredential(config.pool, config.workspaceId, provider.id, encryptionKey);
    if (cred) return cred.decryptedValue;
  }

  // Fall back to env-var keys (platform-level defaults)
  if (provider.id === "google") return config.fallbackGoogleKey;
  if (provider.id === "groq") return config.fallbackGroqKey;

  // No credential available — skip this provider
  return undefined;
}

async function callLLM(
  provider: ProviderDef,
  model: ProviderModel,
  apiKey: string | null,
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmResponse> {
  if (provider.protocol === "anthropic") {
    if (!apiKey) throw new Error("No API key for Anthropic");
    const result = await callAnthropic({
      apiKey,
      modelId: model.id,
      systemPrompt,
      userPrompt,
    });
    return {
      content: result.content,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      durationMs: result.durationMs,
    };
  }

  // OpenAI-compatible (OpenAI, Groq, OpenRouter, Google's OpenAI endpoint, Zen)
  const endpoints: Record<string, string> = {
    "opencode-zen": "https://opencode.ai/zen/v1/chat/completions",
    openai: "https://api.openai.com/v1/chat/completions",
    google: "https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions",
    groq: "https://api.groq.com/openai/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
  };

  const endpoint = endpoints[provider.id];
  if (!endpoint) {
    throw new Error(`Unknown endpoint for provider: ${provider.id}`);
  }

  return callOpenAICompatible({
    endpoint,
    apiKey: apiKey ?? "",
    modelId: model.id,
    systemPrompt,
    userPrompt,
    // Tools are not sent to the LLM — the MCP data is already seeded
    // into the prompt by the template's dataScope + buildPrompt. Free
    // Zen models reject tool-calling parameters with a 400 error.
  });
}

// Import all providers from the registry
import { PROVIDERS } from "../providers/registry.js";

function allProviders(): ProviderDef[] {
  return PROVIDERS;
}
