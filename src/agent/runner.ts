import type { DbPool } from "../store/db.js";
import type { AgentTemplate } from "../templates/catalog.js";
import { PROVIDERS, type ProviderDef, type ProviderModel } from "../providers/registry.js";
import { getConnectedProviders, getCredential } from "../store/credentials.js";
import { updateTaskStatus, setTaskMetadata } from "../store/tasks.js";
import { callOpenAICompatible, type LlmResponse } from "./opencode.js";
import { callAnthropic } from "./anthropic.js";
import { callDevinSession } from "./cognition.js";
import { buildContext, renderContextSections } from "./context.js";
import { parseOutcome, outputContractText, type OutcomeKind } from "./structured.js";
import { emitOutcomes } from "./outcomes.js";
import { recordUsage, hasRemainingBudget } from "./usage.js";
import { verifyOutcome, type VerifyResult } from "./verify.js";
import { availablePremiumModels } from "./models.js";
import { getDiscoveredFreeModels, type DiscoveredModel } from "./discovery.js";

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
  /** Intelligent token optimization: "basic" uses free models, "premium" routes to connected paid providers. */
  tier: "basic" | "premium";
  /** Monthly spend ceiling used when the workspace has no explicit budget row. */
  defaultMonthlyBudgetMicroUsd: number;
  /** Trace ID from the autopilot trace spine, for causal correlation in agent_outcomes. */
  traceId?: string | null;
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
 * 3. Resolve the model + credential chain (API key lookup)
 * 4. Call the LLM (fallback chain, JSON mode when the template wants structure)
 * 5. For structured outcomes: verify the response with a tier-matched model
 *    (free reviews free, premium reviews premium) before accepting it.
 *    Rejected responses fall through to the next model.
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

    // Guard: when every data tool returned empty arrays, the LLM has nothing
    // grounded to work with. Hallucination is the likely outcome, so fail
    // fast with a clear message rather than burning quota on a useless call.
    const hasData = Object.values(bundle.data).some((v) => {
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === "object") return Object.keys(v).length > 0;
      return v != null && v !== "";
    });
    if (!hasData) {
      await setTaskMetadata(pool, taskId, {
        context: {
          budget_chars: bundle.budgetChars,
          used_chars: bundle.usedChars,
          blocks: bundle.truncationReport,
        },
        skipped: "no tenant data available for this template's data scope",
      });
      throw new Error(
        "No tenant data available for this template's data scope. The workspace may not have events, outreach targets, or other required data yet.",
      );
    }

    const outputKind = template.outputKind as OutcomeKind | undefined;
    const systemPrompt =
      template.systemPrompt +
      (outputKind ? `\n\n${outputContractText(outputKind)}` : "") +
      "\n\nRULES: Use only the provided data — it comes from the band's read-only database, labeled per section. Never invent contacts, venues, dates, or numbers.";

    // Let the template format its own prompt from the seeded data, then
    // append the structured-output instruction. Templates know how to
    // present their data (e.g. press-pitch formats events + targets);
    // the runner just supplies the raw tool outputs.
    const templatePrompt = template.buildPrompt(prompt, bundle.data);
    const userPrompt = `${templatePrompt}${
      outputKind ? "\n\nRespond with ONLY the JSON object described in the output contract. No prose, no markdown fences, no pretty-printing — output compact JSON on a single line." : ""
    }`;

    // 3. Resolve model + credential chain
    // For premium tasks, try connected premium providers first. If none are
    // connected or all fail, fall through to the basic chain — premium never
    // blocks, it degrades gracefully.
    let modelChain = config.tier === "premium"
      ? await resolvePremiumChain(config)
      : [];
    const usedPremiumFallback = modelChain.length === 0;
    if (usedPremiumFallback) {
      console.log(`Task ${taskId} is premium but no premium credentials connected — falling back to basic chain`);
      modelChain = await resolveModelChain(config);
    }
    let response: LlmResponse | null = null;
    let lastError: string | null = null;
    let modelUsed = "";
    let providerUsed: string | null = null;
    let costMicroUsd = 0;
    const attempts: AttemptRecord[] = [];
    let verificationResult: VerifyResult | null = null;

    // Verifier models are resolved lazily, per generator provider, and cached:
    // the verifier must never come from the same provider as the model whose
    // output it is checking, and the accepted model may be any entry in the
    // chain — not just the first one.
    const verifierCache = new Map<string, ChainEntry | null>();
    const verifierFor = async (generatorProviderId: string): Promise<ChainEntry | null> => {
      if (!verifierCache.has(generatorProviderId)) {
        verifierCache.set(generatorProviderId, await resolveVerifier(config, generatorProviderId));
      }
      return verifierCache.get(generatorProviderId) ?? null;
    };

    // Total budget for the entire fallback chain. Premium agentic sessions
    // (Devin) get a longer deadline since they run autonomously.
    const hasAgentic = modelChain.some((e) => (e.model as ProviderModel & { agentic?: boolean }).agentic);
    const CHAIN_DEADLINE_MS = hasAgentic ? 360_000 : 180_000;
    const chainStart = Date.now();

    for (const entry of modelChain) {
      const remaining = CHAIN_DEADLINE_MS - (Date.now() - chainStart);
      if (remaining <= 5_000) {
        console.error("Model chain deadline exceeded, skipping remaining fallbacks");
        break;
      }
      // Each attempt gets its own verdict — a rejection from an earlier model
      // must not be reported as this model's verification result.
      verificationResult = null;

      // Budget gate before the money is spent. recordUsage runs after the
      // call and always writes what was actually consumed, so an exhausted
      // budget has to be caught here or not at all.
      if (entry.model.paid) {
        const withinBudget = await hasRemainingBudget(
          pool,
          workspaceId,
          config.defaultMonthlyBudgetMicroUsd,
        );
        if (!withinBudget) {
          lastError = "monthly budget exhausted";
          attempts.push({
            provider: entry.provider.id,
            model: entry.model.id,
            ok: false,
            cost_micro_usd: 0,
            error: "skipped: monthly budget exhausted",
          });
          continue;
        }
      }
      try {
        // Agentic models (Devin) use a session API instead of chat completions.
        // The session runs autonomously with shell/file/web/sub-agent access.
        const isAgentic = (entry.model as ProviderModel & { agentic?: boolean }).agentic === true;
        const candidate = isAgentic
          ? await callAgenticSession(entry, config, systemPrompt + "\n\n" + userPrompt)
          : await callLLM(entry, systemPrompt, userPrompt, outputKind !== undefined);
        const entryCost = isAgentic
          ? 0  // Agentic sessions (Devin) are free for subscribers
          : await recordUsage(pool, workspaceId, entry.provider.id, entry.model, {
              tokensIn: candidate.tokensIn,
              tokensOut: candidate.tokensOut,
            });
        costMicroUsd += entryCost;

        // For structured outcomes, run the verification gate before
        // accepting this model's response. If the verifier rejects it,
        // record the issues and try the next model in the chain — a
        // verified answer from a fallback beats an unverified one from
        // the primary.
        const verifierEntry = outputKind && config.outcomesEnabled
          ? await verifierFor(entry.provider.id)
          : null;
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
            // The verification pass burns tokens too. A premium verifier is a
            // paid model — leaving it out of the ledger under-reports spend
            // and hides it from the budget gate on the next run.
            costMicroUsd += await recordVerifierUsage(
              pool,
              workspaceId,
              verifierEntry,
              verificationResult,
            );
            if (!verificationResult.passed) {
              console.error(
                `Model ${entry.model.id} output rejected by verifier:`,
                verificationResult.issues.join("; "),
              );
              attempts.push({
                provider: entry.provider.id,
                model: entry.model.id,
                ok: true,
                cost_micro_usd: entryCost,
                verified: "rejected",
                verification_issues: verificationResult.issues,
              });
              continue;
            }
          }
        }

        response = candidate;
        modelUsed = entry.model.id;
        providerUsed = entry.provider.id;
        attempts.push({
          provider: entry.provider.id,
          model: entry.model.id,
          ok: true,
          cost_micro_usd: entryCost,
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
            traceId: config.traceId,
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
      tier: config.tier,
      premium_fallback: usedPremiumFallback,
    });

    // Record the total cost and the provider that actually produced the
    // accepted answer. Written unconditionally: a free run costs 0 but its
    // provider still belongs on the row, or the model-routing analytics
    // report every free task under a NULL provider.
    await pool.query(
      `UPDATE agent_service_tasks SET cost_micro_usd = $2, model_provider = $3 WHERE id = $1`,
      [taskId, costMicroUsd, providerUsed],
    );

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
 * 1. The requested model with its credential (credentials are resolved here)
 * 2. Other recommended models from the template among connected providers
 * 3. Free-tier models (Zen, Groq free, Gemini free)
 */
async function resolveModelChain(config: RunConfig): Promise<ChainEntry[]> {
  const { pool, workspaceId, modelId } = config;
  const chain: ChainEntry[] = [];
  const connectedProviders = await getConnectedProviders(pool, workspaceId);
  // Per-task credential cache: the same provider's key is queried many times
  // during chain resolution. Without this, each candidate model triggers a
  // separate DB call — an N+1 on the credentials table.
  const credentialCache = new Map<string, string | null | undefined>();

  const requested = findProviderForModel(modelId);

  // 1. Requested model first. API keys are decrypted directly from the
  //    credentials store.
  if (requested) {
    const key = await resolveApiKey(requested.provider, config, connectedProviders, credentialCache);
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
    const key = await resolveApiKey(entry.provider, config, connectedProviders, credentialCache);
    if (key !== undefined) {
      chain.push({ provider: entry.provider, model: entry.model, apiKey: key });
      seen.add(fallbackId);
    }
  }

  // 3. Free-tier floor — the system must keep working with zero credentials.
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      if (model.paid || seen.has(model.id)) continue;
      const key = await resolveApiKey(provider, config, connectedProviders, credentialCache);
      if (key !== undefined) {
        chain.push({ provider, model, apiKey: key });
        seen.add(model.id);
      }
    }
  }

  // 4. Discovered free models from the periodic discovery poller. These are
  //    new free-tier models that OpenRouter or Zen added since the last code
  //    deploy. They're upserted into agent_service_discovered_models by the
  //    cron ticker in server.ts. We add them at the end of the fallback chain
  //    so the known-good hardcoded models are tried first.
  try {
    const discovered = await getDiscoveredFreeModels(config.pool);
    for (const dm of discovered) {
      if (seen.has(dm.model_id)) continue;
      // Map the discovered model to its provider. OpenRouter models use the
      // 'openrouter' provider; Zen models use 'opencode-zen'.
      const providerId = dm.source === "openrouter" ? "openrouter" : "opencode-zen";
      const provider = PROVIDERS.find((p) => p.id === providerId);
      if (!provider) continue;
      // Only add if we have a credential for this provider (or it's free-tier)
      const key = await resolveApiKey(provider, config, connectedProviders, credentialCache);
      if (key === undefined) continue;
      // Construct a synthetic ProviderModel for the discovered model
      const syntheticModel: ProviderModel = {
        id: dm.model_id,
        name: dm.name,
        contextWindow: dm.context_window,
        bestFor: "Discovered free model",
        paid: false,
      };
      chain.push({ provider, model: syntheticModel, apiKey: key });
      seen.add(dm.model_id);
    }
  } catch (err) {
    // Discovery table might not exist yet on first boot — fail silently
    console.error("failed to load discovered models:", err);
  }

  return chain;
}

/**
 * Resolves the premium model chain for intelligent token optimization.
 * Returns connected premium providers' models, ordered by:
 * 1. Agentic models (Devin) first — best for complex multi-step tasks
 * 2. Template recommended models that are premium
 * 3. Other premium models from connected providers
 *
 * Returns an empty chain if no premium credentials are connected — the
 * caller falls back to the basic chain in that case.
 */
async function resolvePremiumChain(config: RunConfig): Promise<ChainEntry[]> {
  const { pool, workspaceId } = config;
  const connectedProviders = await getConnectedProviders(pool, workspaceId);
  const premiumModels = availablePremiumModels(connectedProviders);

  if (premiumModels.length === 0) {
    return [];
  }

  const chain: ChainEntry[] = [];
  const seen = new Set<string>();
  const credentialCache = new Map<string, string | null | undefined>();

  // 1. Agentic models first (Devin) — best for complex multi-step tasks.
  for (const pm of premiumModels) {
    if (!pm.agentic) continue;
    const provider = PROVIDERS.find((p) => p.id === pm.provider);
    if (!provider) continue;
    const model = provider.models.find((m) => m.id === pm.id);
    if (!model) continue;
    const key = await resolveApiKey(provider, config, connectedProviders, credentialCache);
    if (key !== undefined) {
      chain.push({ provider, model, apiKey: key });
      seen.add(`${pm.provider}:${pm.id}`);
    }
  }

  // 2. Template recommended models that are premium.
  for (const fallbackId of config.template.recommendedModels) {
    const pm = premiumModels.find((m) => m.id === fallbackId);
    if (!pm || seen.has(`${pm.provider}:${pm.id}`)) continue;
    const provider = PROVIDERS.find((p) => p.id === pm.provider);
    if (!provider) continue;
    const model = provider.models.find((m) => m.id === pm.id);
    if (!model) continue;
    const key = await resolveApiKey(provider, config, connectedProviders, credentialCache);
    if (key !== undefined) {
      chain.push({ provider, model, apiKey: key });
      seen.add(`${pm.provider}:${pm.id}`);
    }
  }

  // 3. Other premium models from connected providers (by cost: cheapest first).
  const remaining = premiumModels
    .filter((pm) => !seen.has(`${pm.provider}:${pm.id}`))
    .sort((a, b) => (a.priceInputPerMTok + a.priceOutputPerMTok) - (b.priceInputPerMTok + b.priceOutputPerMTok));
  for (const pm of remaining) {
    const provider = PROVIDERS.find((p) => p.id === pm.provider);
    if (!provider) continue;
    const model = provider.models.find((m) => m.id === pm.id);
    if (!model) continue;
    const key = await resolveApiKey(provider, config, connectedProviders, credentialCache);
    if (key !== undefined) {
      chain.push({ provider, model, apiKey: key });
      seen.add(`${pm.provider}:${pm.id}`);
    }
  }

  return chain;
}

/**
 * Calls a Devin agentic session. The session runs autonomously with shell,
 * file, web, and sub-agent access. The runner creates the session, polls for
 * completion, and extracts the final message.
 *
 * The org ID is stored in the `provider_account` column of the credential.
 */
async function callAgenticSession(
  entry: ChainEntry,
  config: RunConfig,
  fullPrompt: string,
): Promise<LlmResponse> {
  if (entry.provider.id !== "cognition") {
    throw new Error(`Agentic sessions not supported for provider: ${entry.provider.id}`);
  }
  if (!entry.apiKey) {
    throw new Error("No API key for Cognition/Devin");
  }

  // The org ID is stored in the provider_account column of the credential.
  const { rows } = await config.pool.query(
    `SELECT provider_account FROM agent_service_credentials
     WHERE workspace_id = $1 AND provider = $2 AND status = 'active'`,
    [config.workspaceId, entry.provider.id],
  );
  const orgId = rows[0]?.provider_account as string | null;
  if (!orgId) {
    throw new Error("No organization ID found for Cognition/Devin credential");
  }

  const start = Date.now();
  const result = await callDevinSession(entry.apiKey, orgId, fullPrompt, 300_000);
  const durationMs = Date.now() - start;

  return {
    content: result.content,
    tokensIn: 0,   // Devin sessions don't report token usage
    tokensOut: 0,
    durationMs,
  };
}

/**
 * Resolves a verifier model for the verification pass.
 *
 * Tier-matched cross-review: free AI reviews free AI, premium AI reviews
 * premium AI. The verifier is always from a different provider than the
 * primary generator model, so a model never reviews itself.
 *
 * - Free tier: uses free models only (no cost). Preference: Zen, then Groq,
 *   then Gemini, then any other free model.
 * - Premium tier: uses paid models from connected providers (different
 *   provider than the generator). Falls back to free models if no premium
 *   verifier from a different provider is available.
 *
 * Returns null when no verifier is available — the runner then skips
 * verification (fail-open) rather than blocking the pipeline.
 */
async function resolveVerifier(
  config: RunConfig,
  excludeProviderId?: string,
): Promise<ChainEntry | null> {
  const connectedProviders = await getConnectedProviders(config.pool, config.workspaceId);
  const isPremium = config.tier === "premium";

  if (isPremium) {
    // Try premium models from connected providers, excluding the generator's
    // provider so a model never reviews itself. Within a provider, take the
    // cheapest paid model — verification is a short structured check, not a
    // reason to pay flagship rates.
    for (const provider of PROVIDERS) {
      if (provider.id === excludeProviderId) continue;
      if (!connectedProviders.includes(provider.id)) continue;
      if (!PROVIDER_ENDPOINTS[provider.id] && provider.protocol !== "anthropic") continue;
      const cheapest = provider.models
        .filter((m) => m.paid && !(m as ProviderModel & { agentic?: boolean }).agentic)
        .sort(
          (a, b) =>
            (a.pricing?.inputPerMTokUsd ?? 0) + (a.pricing?.outputPerMTokUsd ?? 0) -
            ((b.pricing?.inputPerMTokUsd ?? 0) + (b.pricing?.outputPerMTokUsd ?? 0)),
        )[0];
      if (!cheapest) continue;
      const key = await resolveApiKey(provider, config, connectedProviders);
      if (key !== undefined) return { provider, model: cheapest, apiKey: key };
    }
    // Fall through to free verifier if no premium verifier from a different
    // provider is available — verification with a free model is better than
    // no verification.
  }

  // Prefer Zen for verification — it's always available and free.
  for (const provider of PROVIDERS) {
    if (provider.id === "opencode-zen") {
      if (provider.id === excludeProviderId) continue;
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
    if (provider.id === excludeProviderId) continue;
    if (!provider.freeTier && !connectedProviders.includes(provider.id)) continue;
    if (!PROVIDER_ENDPOINTS[provider.id] && provider.protocol !== "anthropic") continue;
    for (const model of provider.models) {
      if (model.paid) continue;
      const key = await resolveApiKey(provider, config, connectedProviders);
      if (key !== undefined) return { provider, model, apiKey: key };
    }
  }

  return null;
}

/**
 * Records the verifier call in the usage ledger. Verification is a real
 * provider call — on the premium tier it is a paid model — so its tokens
 * belong in the ledger alongside the generator's. A verifier that never
 * reached the provider reports no tokens and is skipped; one that answered
 * unparseably still burned them and is billed.
 */
async function recordVerifierUsage(
  pool: DbPool,
  workspaceId: string,
  verifier: ChainEntry,
  result: VerifyResult,
): Promise<number> {
  if (result.tokensIn == null && result.tokensOut == null) return 0;
  try {
    return await recordUsage(pool, workspaceId, verifier.provider.id, verifier.model, {
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
    });
  } catch (err) {
    // Ledger write failures must never sink an otherwise good run.
    console.error("failed to record verifier usage:", err);
    return 0;
  }
}

async function resolveApiKey(
  provider: ProviderDef,
  config: RunConfig,
  connectedProviders: string[],
  credentialCache?: Map<string, string | null | undefined>,
): Promise<string | null | undefined> {
  // Check cache first — the same provider's credential is queried many times
  // during chain resolution (requested, recommended, free-tier, discovered).
  // Without this, each candidate model triggers a separate DB call. `has` is
  // the membership test, not `!== undefined`: `undefined` ("no key for this
  // provider") is a cached value too, and it is the one that would otherwise
  // re-query on every single candidate.
  if (credentialCache?.has(provider.id)) {
    return credentialCache.get(provider.id);
  }

  // Free tier — no key needed
  if (provider.authMethod === "none" || provider.freeTier) {
    const result = provider.id === "opencode-zen" ? config.zenToken : null;
    credentialCache?.set(provider.id, result);
    return result;
  }

  if (connectedProviders.includes(provider.id)) {
    // API key providers: decrypt the stored key directly. A credential sealed
    // with a key we no longer hold throws — that must skip this provider, not
    // abort the whole task before any model has been tried.
    let result: string | undefined;
    try {
      const cred = await getCredential(
        config.pool,
        config.workspaceId,
        provider.id,
        config.encryptionKey,
        config.previousEncryptionKey,
      );
      result = cred?.decryptedValue ?? undefined;
    } catch (err) {
      console.error(
        `could not decrypt the ${provider.id} credential for workspace ${config.workspaceId}:`,
        err instanceof Error ? err.message : err,
      );
      result = undefined;
    }
    credentialCache?.set(provider.id, result);
    return result;
  }

  // Platform-level env defaults. Return undefined (not null) when absent so
  // the chain skips this provider instead of attempting a keyless call.
  if (provider.id === "google") {
    const result = config.fallbackGoogleKey ?? undefined;
    credentialCache?.set(provider.id, result);
    return result;
  }
  if (provider.id === "groq") {
    const result = config.fallbackGroqKey ?? undefined;
    credentialCache?.set(provider.id, result);
    return result;
  }

  credentialCache?.set(provider.id, undefined);
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
