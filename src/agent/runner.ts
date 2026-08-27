import type { DbPool } from "../store/db";
import type { AgentTemplate } from "../templates/catalog";
import { findTool, toolDefinitions } from "../mcp/tools";
import { fallbackChain, type ModelDef } from "./models";
import { updateTaskStatus, saveResult } from "../store/tasks";
import { callOpenAICompatible, type LlmResponse } from "./opencode";

export interface RunConfig {
  pool: DbPool;
  taskId: string;
  workspaceId: string;
  template: AgentTemplate;
  modelId: string;
  prompt: string;
  availableKeys: { google?: boolean; groq?: boolean };
  opencodeServerUrl: string | null;
  zenToken: string | null;
}

/**
 * Orchestrates a single agent task:
 * 1. Pull tenant data via MCP tools (data scope from template)
 * 2. Build the full prompt from template + data + operator input
 * 3. Call the LLM (with fallback chain)
 * 4. Store the result
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
        // A failed tool call is not fatal — the LLM can still work with partial data
        console.error(`MCP tool ${toolName} failed:`, err);
        seededData[toolName] = { error: "data unavailable" };
      }
    }

    // 2. Build the full prompt
    const systemPrompt = template.systemPrompt;
    const userPrompt = template.buildPrompt(prompt, seededData);

    // 3. Call the LLM with fallback chain
    const chain = fallbackChain(config.modelId, config.availableKeys);
    let response: LlmResponse | null = null;
    let lastError: string | null = null;
    let modelUsed = "";

    for (const model of chain) {
      try {
        response = await callLLM(model, systemPrompt, userPrompt, config);
        modelUsed = model.id;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`Model ${model.id} failed:`, lastError);
        continue;
      }
    }

    if (!response) {
      throw new Error(`All models failed. Last error: ${lastError}`);
    }

    // 4. Store the result
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

async function callLLM(
  model: ModelDef,
  systemPrompt: string,
  userPrompt: string,
  config: RunConfig,
): Promise<LlmResponse> {
  // For v1, we use a direct OpenAI-compatible API call.
  // The OpenCode SDK server mode is an option for later — for now,
  // we call the Zen endpoint directly (it's OpenAI-compatible).

  const endpoints: Record<string, string> = {
    "opencode-zen": "https://opencode.ai/zen/v1/chat/completions",
    google: "https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions",
    groq: "https://api.groq.com/openai/v1/chat/completions",
  };

  const endpoint = endpoints[model.provider];
  if (!endpoint) {
    throw new Error(`Unknown provider: ${model.provider}`);
  }

  const apiKey = resolveApiKey(model, config);
  if (model.requiresKey && !apiKey) {
    throw new Error(`No API key for ${model.provider}`);
  }

  return callOpenAICompatible({
    endpoint,
    apiKey: apiKey ?? "",
    modelId: model.id,
    systemPrompt,
    userPrompt,
    tools: toolDefinitions(),
  });
}

function resolveApiKey(model: ModelDef, config: RunConfig): string | null {
  if (model.provider === "opencode-zen") {
    return config.zenToken;
  }
  if (model.provider === "google") {
    return config.availableKeys.google ? process.env.GOOGLE_API_KEY ?? null : null;
  }
  if (model.provider === "groq") {
    return config.availableKeys.groq ? process.env.GROQ_API_KEY ?? null : null;
  }
  return null;
}
