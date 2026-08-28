import type { DbPool } from "../store/db.js";
import type { AgentTemplate } from "../templates/catalog.js";
import { PROVIDERS, type ProviderDef, type ProviderModel } from "../providers/registry.js";
import { getConnectedProviders, getCredential } from "../store/credentials.js";
import { updateTaskStatus, setTaskMetadata } from "../store/tasks.js";
import { callOpenAICompatible, type LlmResponse } from "./opencode.js";
import { callAnthropic } from "./anthropic.js";
import { ensureFreshToken } from "../providers/oauth/refresh.js";
import { buildContext, renderContextSections } from "./context.js";
import { parseOutcome, outputContractText, type OutcomeKind } from "./structured.js";
import { emitOutcomes } from "./outcomes.js";
import { recordUsage } from "./usage.js";
import { verifyOutcome, type VerifyResult } from "./verify.js";

import { PROVIDER_ENDPOINTS } from "./endpoints.js";

export interface RunConfig {
  pool: DbPool;
  taskId: string;
  workspaceId: string;
  template: AgentTemplate;
  modelId: string;
  prompt: string;
  encryptionKey: string;
  previousEncryptionKey: string | null;
  zenToken: string | null;
  fallbackGoogleKey: string | null;
  fallbackGroqKey: string | null;
  /** Kill switch: when false, results are stored but no outcomes are emitted. */
  outcomesEnabled: boolean;
}

interface ChainEntry {
  provider: ProviderDef;
  model: ProviderModel;
  apiKey: string | null;
}

/** One recorded fallback attempt — stored on the task for post-hoc debugging. */
interface AttemptRecord {
  provider: string;
  model: string;
  ok: boolean;
  cost_micro_usd: number;
  error?: string;
  /** Verification result when the model succeeded but was checked by the gate. */
  verified?: "passed" | "rejected";
  verification_issues?: string[];
}

/**
 * Orchestrates a single agent task:
 * 1. Pull tenant data via MCP tools through the budgeted context builder
 * 2. Build the full prompt from template + data + operator input
 * 3. Resolve the model + credential chain (OAuth refresh aware)
 * 4. Call the LLM (fallback chain, JSON mode when the template wants structure)
 * 5. For structured outcomes: verify the response with a free-tier model
 *    before accepting it. Rejected responses fall through to the next model.
 * 6. Record usage/cost, store the result, parse + emit structured outcomes
 */
export async function runTask(config: RunConfig): Promise<void> {
  const { pool, taskId, workspaceId, template, prompt } = config;

  await updateTaskStatus(pool, taskId, "running");

  try {
    // 1+2. Budgeted context; the builder records what was truncated so the
    // prompt the model actually saw is answerable later from metadata.
    const requested = findProviderForModel(config.modelId);
    const contextWindow = requested?.model.contextWindow ?? 128_000;
    const bundle = await buildContext({
      pool,
      workspaceId,
      scope: template.dataScope,
      contextWindow,
    });

    const outputKind = template.outputKind as OutcomeKind | undefined;
    const systemPrompt =
      template.systemPrompt +
      (outputKind ? `\n\n${outputContractText(outputKind)}` : "") +
      "\n\nRULES: Use only the provided data — it comes from the band's read-only database, labeled per section. Never invent contacts, venues, dates, or numbers.";
    const userPrompt = `${prompt}\n\nHere is the current data from the band's database:\n\n${renderContextSections(bundle)}${
      outputKind ? "\n\nRespond with ONLY the JSON object described in the output contract." : ""
    }`;

    // 3. Resolve model + credential chain
    const modelChain = await resolveModelChain(config);
    let response: LlmResponse | null = null;
    let lastError: string | null = null;
    let modelUsed = "";
    const attempts: AttemptRecord[] = [];
    let verificationResult: VerifyResult | null = null;

    // Resolve a free-tier verifier model — the gate must not add cost.
    const verifierEntry = await resolveVerifier(config);

    // Total budget for the entire fallback chain. Each individual LLM call
    // has its own 120s timeout, but without a chain-level deadline the
    // background task could run for 5–10 minutes across all fallbacks,
    // exceeding the graceful-shutdown window and burning free-tier quota.
    // Verification calls are cheap and fast, but they share the same budget.
    const CHAIN_DEADLINE_MS = 180_000;
    const chainStart = Date.now();

    for (const entry of modelChain) {
      const remaining = CHAIN_DEADLINE_MS - (Date.now() - chainStart);
      if (remaining <= 5_000) {
        console.error("Model chain deadline exceeded, skipping remaining fallbacks");
        break;
      }
      try {
        const candidate = await callLLM(entry, systemPrompt, userPrompt, outputKind !== undefined);
        const costMicroUsd = await recordUsage(pool, workspaceId, entry.provider.id, entry.model, {
          tokensIn: candidate.tokensIn,
          tokensOut: candidate.tokensOut,
        });

        // For structured outcomes, run the verification gate before
        // accepting this model's response. If the verifier rejects it,
        // record the issues and try the next model in the chain — a
        // verified answer from a fallback beats an unverified one from
        // the primary.
        if (outputKind && config.outcomesEnabled && verifierEntry) {
          const verifyRemaining = CHAIN_DEADLINE_MS - (Date.now() - chainStart);
          if (verifyRemaining <= 5_000) {
            console.error("Verification deadline exceeded, accepting unverified response");
            verificationResult = null;
          } else {
            verificationResult = await verifyOutcome({
              verifier: verifierEntry,
              outcomeKind: outputKind,
              originalPrompt: prompt,
              dataSections: renderContextSections(bundle),
              modelOutput: candidate.content,
            });
            if (!verificationResult.passed) {
              console.error(
                `Model ${entry.model.id} output rejected by verifier:`,
                verificationResult.issues.join("; "),
              );
              attempts.push({
                provider: entry.provider.id,
                model: entry.model.id,
                ok: true,
                cost_micro_usd: costMicroUsd,
                verified: "rejected",
                verification_issues: verificationResult.issues,
              });
              continue;
            }
          }
        }

        response = candidate;
        modelUsed = entry.model.id;
        attempts.push({
          provider: entry.provider.id,
          model: entry.model.id,
          ok: true,
          cost_micro_usd: costMicroUsd,
          verified: verificationResult?.passed ? "passed" : undefined,
        });
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`Model ${entry.model.id} (${entry.provider.id}) failed:`, lastError);
        attempts.push({
          provider: entry.provider.id,
          model: entry.model.id,
          ok: false,
          cost_micro_usd: 0,
          error: lastError.slice(0, 300),
        });
        continue;
      }
    }

    if (!response) {
      await setTaskMetadata(pool, taskId, { attempts });
      throw new Error(
        lastError
          ? `All models failed or deadline exceeded. Last error: ${lastError}`
          : "Model chain deadline exceeded before any fallback could run.",
      );
    }

    // 5. Store the result and, when it parses, emit outcomes in one
    // transaction so a crash can never leave a result without its outcomes
    // (or vice versa).
    let structuredOk = false;
    let structuredError: string | undefined;
    let outcomeCount = 0;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const resultId = crypto.randomUUID();
      await client.query(
        `INSERT INTO agent_service_results
          (id, task_id, workspace_id, content, format, model_used, tokens_in, tokens_out, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          resultId,
          taskId,
          workspaceId,
          response.content,
          outputKind ? "json" : template.outputFormat,
          modelUsed,
          response.tokensIn ?? null,
          response.tokensOut ?? null,
          response.durationMs ?? null,
        ],
      );

      if (outputKind && config.outcomesEnabled) {
        const parsed = parseOutcome(response.content);
        if (parsed.ok && parsed.envelope) {
          outcomeCount = await emitOutcomes({
            pool,
            workspaceId,
            taskId,
            resultId,
            envelope: parsed.envelope,
            client,
          });
          structuredOk = true;
          await client.query(
            `UPDATE agent_service_results SET structured = $2, schema_version = $3 WHERE id = $1`,
            [resultId, JSON.stringify(parsed.envelope), parsed.envelope.schema_version ?? 1],
          );
        } else {
          structuredError = parsed.error;
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await setTaskMetadata(pool, taskId, {
      attempts,
      context: {
        budget_chars: bundle.budgetChars,
        used_chars: bundle.usedChars,
        blocks: bundle.truncationReport,
      },
      structured: structuredOk,
      structured_error: structuredError,
      outcome_count: outcomeCount,
      verification: verificationResult
        ? {
            passed: verificationResult.passed,
            verifier_model: verificationResult.verifierModel,
            issues: verificationResult.issues,
            verifier_error: verificationResult.verifierError,
          }
        : null,
    });

    await updateTaskStatus(pool, taskId, "completed");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await updateTaskStatus(pool, taskId, "failed", errorMsg);
  }
}

function findProviderForModel(modelId: string): { provider: ProviderDef; model: ProviderModel } | null {
  for (const provider of PROVIDERS) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return { provider, model };
  }
  return null;
}

/**
 * Resolves the chain of (provider, model, key) tuples to try:
 * 1. The requested model with its credential (OAuth credentials refresh here)
 * 2. Other recommended models from the template among connected providers
 * 3. Free-tier models (Zen, Groq free, Gemini free)
 */
async function resolveModelChain(config: RunConfig): Promise<ChainEntry[]> {
  const { pool, workspaceId, modelId, encryptionKey, previousEncryptionKey } = config;
  const chain: ChainEntry[] = [];
  const connectedProviders = await getConnectedProviders(pool, workspaceId);

  const requested = findProviderForModel(modelId);

  // 1. Requested model first. OAuth credentials go through ensureFreshToken
  //    (which refreshes or re-derives as needed); plain keys decrypt directly.
  if (requested) {
    const key = await resolveApiKey(requested.provider, config, connectedProviders);
    if (key !== undefined) {
      chain.push({ provider: requested.provider, model: requested.model, apiKey: key });
    }
  }

  const seen = new Set(chain.map((c) => c.model.id));

  // 2. Recommended fallbacks from the template among connected providers.
  //    Paid models are allowed here: the operator picked the template, and a
  //    working paid answer beats a failed free one. The monthly budget still
  //    bounds total spend.
  for (const fallbackId of config.template.recommendedModels) {
    if (seen.has(fallbackId)) continue;
    const entry = findProviderForModel(fallbackId);
    if (!entry) continue;
    const key = await resolveApiKey(entry.provider, config, connectedProviders);
    if (key !== undefined) {
      chain.push({ provider: entry.provider, model: entry.model, apiKey: key });
      seen.add(fallbackId);
    }
  }

  // 3. Free-tier floor — the system must keep working with zero credentials.
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      if (model.paid || seen.has(model.id)) continue;
      const key = await resolveApiKey(provider, config, connectedProviders);
      if (key !== undefined) {
        chain.push({ provider, model, apiKey: key });
        seen.add(model.id);
      }
    }
  }

  return chain;
}

/**
 * Resolves a free-tier model for the verification pass. The verifier must
 * not add cost, so only free models are considered. Preference order:
 * 1. OpenCode Zen (always available, no key needed)
 * 2. Groq free models (fast, good for short verification prompts)
 * 3. Google Gemini free tier
 *
 * Returns null when no free model is available — the runner then skips
 * verification (fail-open) rather than blocking the pipeline.
 */
async function resolveVerifier(config: RunConfig): Promise<ChainEntry | null> {
  const connectedProviders = await getConnectedProviders(config.pool, config.workspaceId);

  // Prefer Zen for verification — it's always available and free.
  for (const provider of PROVIDERS) {
    if (provider.id === "opencode-zen") {
      const key = await resolveApiKey(provider, config, connectedProviders);
      if (key !== undefined) {
        // Use the first (most capable) free model.
        const model = provider.models.find((m) => !m.paid);
        if (model) return { provider, model, apiKey: key };
      }
    }
  }

  // Fall back to any other free-tier provider.
  for (const provider of PROVIDERS) {
    if (provider.id === "opencode-zen") continue;
    if (!provider.freeTier && !connectedProviders.includes(provider.id)) continue;
    for (const model of provider.models) {
      if (model.paid) continue;
      const key = await resolveApiKey(provider, config, connectedProviders);
      if (key !== undefined) return { provider, model, apiKey: key };
    }
  }

  return null;
}

async function resolveApiKey(
  provider: ProviderDef,
  config: RunConfig,
  connectedProviders: string[],
): Promise<string | null | undefined> {
  // Free tier — no key needed
  if (provider.authMethod === "none" || provider.freeTier) {
    if (provider.id === "opencode-zen") return config.zenToken;
    return null;
  }

  if (connectedProviders.includes(provider.id)) {
    // OAuth credentials (and Copilot's exchanged token) resolve through the
    // refresh engine; api_key flavors fall through to the plain decrypt path.
    const resolved = await ensureFreshToken(
      config.pool,
      config.workspaceId,
      provider.id,
      config.encryptionKey,
      config.previousEncryptionKey,
    ).catch((err: unknown) => {
      console.error(`token resolution for ${provider.id} failed:`, err);
      return null;
    });
    if (resolved) return resolved.token;

    // Fall back to a plain stored key (providers support both paste + OAuth).
    const cred = await getCredential(
      config.pool,
      config.workspaceId,
      provider.id,
      config.encryptionKey,
      config.previousEncryptionKey,
    );
    return cred?.decryptedValue ?? undefined;
  }

  // Platform-level env defaults. Return undefined (not null) when absent so
  // the chain skips this provider instead of attempting a keyless call.
  if (provider.id === "google") return config.fallbackGoogleKey ?? undefined;
  if (provider.id === "groq") return config.fallbackGroqKey ?? undefined;

  return undefined;
}

async function callLLM(
  entry: ChainEntry,
  systemPrompt: string,
  userPrompt: string,
  jsonMode: boolean,
): Promise<LlmResponse> {
  const { provider, model, apiKey } = entry;

  if (provider.protocol === "anthropic") {
    if (!apiKey) throw new Error("No API key for Anthropic");
    const result = await callAnthropic({
      apiKey,
      modelId: model.id,
      systemPrompt,
      userPrompt,
      jsonMode,
    });
    return {
      content: result.content,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      durationMs: result.durationMs,
    };
  }

  const endpoint = PROVIDER_ENDPOINTS[provider.id];
  if (!endpoint) {
    throw new Error(`Unknown endpoint for provider: ${provider.id}`);
  }
  if (provider.id === "github-copilot" && !apiKey) {
    throw new Error("No Copilot token available");
  }

  return callOpenAICompatible({
    endpoint,
    apiKey: apiKey ?? "",
    modelId: model.id,
    systemPrompt,
    userPrompt,
    jsonMode,
    // Tools are not sent to the LLM — the MCP data is already seeded
    // into the prompt by the template's dataScope + context builder. Free
    // Zen models reject tool-calling parameters with a 400 error.
  });
}
