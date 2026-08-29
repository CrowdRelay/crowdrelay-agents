/**
 * Free model discovery poller — streaming, low-memory, differential.
 *
 * Periodically fetches public model catalogs from OpenRouter (and optionally
 * OpenCode Zen) to discover new free-tier models. Upserts them into
 * agent_service_discovered_models so the runner can use them in the fallback
 * chain without a code deploy.
 *
 * Performance design:
 * - **Streaming JSON extraction**: the response is read in ~64KB chunks and
 *   individual model objects are extracted by brace-depth tracking. Only free
 *   model objects are JSON.parse'd (~50 × 2KB), not the full catalog (~6000
 *   × 5KB). Peak memory: ~164KB vs. ~30MB with res.json().
 * - **Differential upsert**: existing DB rows are fetched first; only new or
 *   changed models are written. When nothing changed (the common case for a
 *   24h poll), zero INSERT/UPDATE statements are issued — just a single
 *   last_seen_at touch.
 * - **Stale model pruning**: models from this source that disappeared from
 *   the catalog are deleted after each successful poll.
 * - **In-memory runner cache**: getDiscoveredFreeModels caches its result for
 *   10 minutes so the runner doesn't query the DB on every task.
 * - **Overlap guard**: a re-entrant lock prevents concurrent discovery cycles.
 */

import type { DbPool } from "../store/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

interface DiscoveredRow {
  model_id: string;
  name: string;
  context_window: number;
  pricing_prompt: string;
  pricing_completion: string;
}

export interface DiscoveredModel {
  source: string;
  model_id: string;
  name: string;
  context_window: number;
}

// ---------------------------------------------------------------------------
// Streaming JSON array element extractor
// ---------------------------------------------------------------------------

/**
 * Reads a fetch Response stream in chunks, locates the JSON array at the
 * given key (e.g. "data"), and yields each top-level object as a string.
 * The caller JSON.parse's each element individually.
 *
 * Peak memory: one chunk (~64KB) + one element string (~2KB).
 * Compare with res.json() which materialises the full object graph (~30MB
 * for OpenRouter's 6000-model catalog).
 *
 * Brace-depth tracking with string/escape awareness ensures correctness
 * even when model descriptions contain `{`, `}`, or `"` characters.
 */
async function* streamJsonArray(
  response: Response,
  arrayKey: string = '"data"',
): AsyncGenerator<string> {
  yield* _streamJsonArray(response, arrayKey);
}

/**
 * Internal implementation, exported for testing.
 */
export async function* _streamJsonArray(
  response: Response,
  arrayKey: string = '"data"',
): AsyncGenerator<string> {
  if (!response.body) throw new Error("response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scanPos = 0;
  let foundArray = false;
  let inString = false;
  let escape = false;
  let depth = 0;
  let elemStart = -1;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Phase 1: skip to the array start
      if (!foundArray) {
        const needle = `${arrayKey}:[`;
        const idx = buffer.indexOf(needle, scanPos);
        if (idx === -1) {
          // Keep tail in case the key spans the chunk boundary
          const keep = Math.min(buffer.length, needle.length + 16);
          buffer = buffer.slice(buffer.length - keep);
          scanPos = 0;
          continue;
        }
        scanPos = idx + needle.length;
        foundArray = true;
      }

      // Phase 2: extract array elements by tracking brace depth
      for (let i = scanPos; i < buffer.length; i++) {
        const ch = buffer[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") {
          if (depth === 0) elemStart = i;
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0 && elemStart >= 0) {
            yield buffer.slice(elemStart, i + 1);
            elemStart = -1;
          }
        } else if (ch === "]" && depth === 0) {
          return; // end of array
        }
      }

      // Keep unprocessed remainder (partial object) for the next chunk
      if (elemStart >= 0) {
        buffer = buffer.slice(elemStart);
        elemStart = 0;
        scanPos = buffer.length; // already scanned all of this
      } else {
        buffer = "";
        scanPos = 0;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Model filtering
// ---------------------------------------------------------------------------

/**
 * Parses a single model object string and returns the minimal projection
 * we need, or null if the object is not a free model.
 */
/** Parses a model object string, returns it if free, null otherwise. Exported for testing. */
export function _parseFreeModel(objStr: string): RawModel | null {
  try {
    const m = JSON.parse(objStr) as RawModel;
    if (!m.id || !m.pricing) return null;
    // Free models have both prompt and completion pricing as "0"
    if (m.pricing.prompt !== "0" || m.pricing.completion !== "0") return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Zen free models have a `-free` suffix or `:free` in the ID.
 */
/** Zen free model parser. Exported for testing. */
export function _parseZenFreeModel(objStr: string): RawModel | null {
  try {
    const m = JSON.parse(objStr) as RawModel;
    if (!m.id) return null;
    if (!m.id.endsWith("-free") && !m.id.includes(":free")) return null;
    return m;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Differential upsert + pruning
// ---------------------------------------------------------------------------

interface NormalizedModel {
  id: string;
  name: string;
  contextWindow: number;
  pricingPrompt: string;
  pricingCompletion: string;
}

function normalize(m: RawModel): NormalizedModel {
  return {
    id: m.id,
    name: m.name || m.id,
    contextWindow: Math.min(m.context_length || 128_000, 2_000_000),
    pricingPrompt: m.pricing?.prompt ?? "0",
    pricingCompletion: m.pricing?.completion ?? "0",
  };
}

/**
 * Upserts only new or changed models. When nothing changed, issues zero
 * INSERT/UPDATE statements — just a single last_seen_at touch for all
 * existing rows of this source. Also prunes models that disappeared from
 * the catalog since the last poll.
 *
 * Returns the number of free models found in this poll.
 */
async function syncModels(
  pool: DbPool,
  source: string,
  models: NormalizedModel[],
): Promise<number> {
  if (models.length === 0) {
    // No free models in the catalog — prune everything for this source
    await pool.query(
      `DELETE FROM agent_service_discovered_models WHERE source = $1`,
      [source],
    );
    return 0;
  }

  // Fetch existing rows for differential comparison
  const { rows } = await pool.query<DiscoveredRow>(
    `SELECT model_id, name, context_window, pricing_prompt, pricing_completion
     FROM agent_service_discovered_models WHERE source = $1`,
    [source],
  );
  const existing = new Map(rows.map((r) => [r.model_id, r]));

  // Partition into changed/new vs unchanged
  const toUpsert: NormalizedModel[] = [];
  const seenIds = new Set<string>();
  for (const m of models) {
    seenIds.add(m.id);
    const ex = existing.get(m.id);
    if (!ex) {
      toUpsert.push(m);
    } else if (
      ex.name !== m.name ||
      ex.context_window !== m.contextWindow ||
      ex.pricing_prompt !== m.pricingPrompt ||
      ex.pricing_completion !== m.pricingCompletion
    ) {
      toUpsert.push(m);
    }
  }

  // Bulk upsert only changed/new models
  if (toUpsert.length > 0) {
    const ids = toUpsert.map((m) => m.id);
    const names = toUpsert.map((m) => m.name);
    const ctxWindows = toUpsert.map((m) => m.contextWindow);
    const promptPrices = toUpsert.map((m) => m.pricingPrompt);
    const completionPrices = toUpsert.map((m) => m.pricingCompletion);

    await pool.query(
      `INSERT INTO agent_service_discovered_models
        (source, model_id, name, context_window, pricing_prompt, pricing_completion)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::text[])
       ON CONFLICT (source, model_id)
       DO UPDATE SET name = EXCLUDED.name, context_window = EXCLUDED.context_window,
                     pricing_prompt = EXCLUDED.pricing_prompt, pricing_completion = EXCLUDED.pricing_completion,
                     last_seen_at = now()`,
      [source, ids, names, ctxWindows, promptPrices, completionPrices],
    );
  }

  // Touch last_seen_at for unchanged models that are still in the catalog
  // (skip the ones we just upserted — they already got last_seen_at = now())
  if (toUpsert.length < models.length) {
    const unchangedIds = models.filter((m) => !toUpsert.includes(m)).map((m) => m.id);
    if (unchangedIds.length > 0) {
      // Use a CTE to batch-update last_seen_at for unchanged models
      await pool.query(
        `UPDATE agent_service_discovered_models
         SET last_seen_at = now()
         WHERE source = $1 AND model_id = ANY($2::text[])`,
        [source, unchangedIds],
      );
    }
  }

  // Prune models that disappeared from the catalog since the last poll
  const staleIds = rows.filter((r) => !seenIds.has(r.model_id)).map((r) => r.model_id);
  if (staleIds.length > 0) {
    await pool.query(
      `DELETE FROM agent_service_discovered_models
       WHERE source = $1 AND model_id = ANY($2::text[])`,
      [source, staleIds],
    );
    console.log(`[model-discovery] ${source}: pruned ${staleIds.length} stale model(s)`);
  }

  const changed = toUpsert.length > 0
    ? ` (${toUpsert.length} new/changed)`
    : " (no changes)";
  console.log(`[model-discovery] ${source}: ${models.length} free models${changed}`);
  return models.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Polls OpenRouter's public /models endpoint and upserts free models.
 * Uses streaming JSON extraction to avoid materialising the full catalog.
 * Returns the number of free models discovered.
 */
export async function pollOpenRouterFreeModels(pool: DbPool): Promise<number> {
  const pollStartedAt = new Date();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`[model-discovery] OpenRouter returned ${res.status}`);
      return 0;
    }

    // Stream the response and extract only free model objects.
    // Peak memory: ~64KB (one chunk) + ~50 × 2KB (free models) ≈ 164KB.
    // Compare with res.json() which would create ~30MB of JS objects.
    const freeModels: NormalizedModel[] = [];
    for await (const objStr of streamJsonArray(res, '"data"')) {
      const m = _parseFreeModel(objStr);
      if (m) freeModels.push(normalize(m));
    }

    return await syncModels(pool, "openrouter", freeModels);
  } catch (err) {
    console.error("[model-discovery] OpenRouter poll failed:", err);
    return 0;
  }
}

/**
 * Polls OpenCode Zen's /models endpoint (if a token is configured) and
 * upserts free models. Zen's free models have a `-free` suffix or `:free`.
 */
export async function pollZenFreeModels(pool: DbPool, zenToken: string | null): Promise<number> {
  if (!zenToken) return 0;

  try {
    const res = await fetch("https://opencode.ai/zen/v1/models", {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${zenToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error(`[model-discovery] Zen returned ${res.status}`);
      return 0;
    }

    const freeModels: NormalizedModel[] = [];
    for await (const objStr of streamJsonArray(res, '"data"')) {
      const m = _parseZenFreeModel(objStr);
      if (m) freeModels.push(normalize(m));
    }

    return await syncModels(pool, "opencode-zen", freeModels);
  } catch (err) {
    console.error("[model-discovery] Zen poll failed:", err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Overlap guard
// ---------------------------------------------------------------------------

let discoveryRunning = false;

/**
 * Runs a full discovery cycle: poll all configured sources.
 * Called by the cron ticker in server.ts.
 * Re-entrant safe: if a previous cycle is still running, skips this tick.
 */
export async function runDiscoveryCycle(pool: DbPool, zenToken: string | null): Promise<void> {
  if (discoveryRunning) {
    console.log("[model-discovery] previous cycle still running, skipping");
    return;
  }
  discoveryRunning = true;
  try {
    console.log("[model-discovery] starting discovery cycle");
    const [orCount, zenCount] = await Promise.all([
      pollOpenRouterFreeModels(pool),
      pollZenFreeModels(pool, zenToken),
    ]);
    console.log(`[model-discovery] cycle complete: ${orCount} OpenRouter, ${zenCount} Zen`);
    // Invalidate the runner cache so new models are visible immediately
    discoveredModelsCache = null;
  } finally {
    discoveryRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Runner cache
// ---------------------------------------------------------------------------

let discoveredModelsCache: { models: DiscoveredModel[]; expiresAt: number } | null = null;
const RUNNER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Reads discovered free models from the DB, filtered to those seen recently.
 * The runner calls this to augment the hardcoded MODELS fallback chain.
 *
 * Results are cached in-memory for 10 minutes so the runner doesn't query
 * the DB on every task. The cache is invalidated after each discovery cycle.
 *
 * @param maxAgeHours Only return models seen within this many hours (default 7 days)
 */
export async function getDiscoveredFreeModels(
  pool: DbPool,
  maxAgeHours: number = 168,
): Promise<DiscoveredModel[]> {
  if (discoveredModelsCache && Date.now() < discoveredModelsCache.expiresAt) {
    return discoveredModelsCache.models;
  }

  const { rows } = await pool.query<DiscoveredModel>(
    `SELECT source, model_id, name, context_window
     FROM agent_service_discovered_models
     WHERE last_seen_at > now() - ($1 || ' hours')::interval
     ORDER BY last_seen_at DESC
     LIMIT 20`,
    [String(maxAgeHours)],
  );
  discoveredModelsCache = {
    models: rows,
    expiresAt: Date.now() + RUNNER_CACHE_TTL_MS,
  };
  return rows;
}
