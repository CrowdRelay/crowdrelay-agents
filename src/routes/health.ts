import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MODELS } from "../agent/models.js";
import type { DbPool } from "../store/db.js";

let version = "unknown";
try {
  // import.meta.url is /app/dist/routes/health.js — package.json is /app/package.json
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  version = JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
} catch {
  // ignore — fallback to "unknown"
}
const VERSION = version;

export function registerHealthRoutes(
  app: FastifyInstance,
  opts: { pool: DbPool },
) {
  app.get("/health", async (_request, reply) => {
    try {
      await opts.pool.query("SELECT 1");
      return reply.send({ status: "ok", version: VERSION });
    } catch {
      return reply.code(503).send({ status: "degraded", error: "database unreachable" });
    }
  });

  app.get("/health/providers", async (_request, reply) => {
    // Query stored health snapshots from the database
    const { rows } = await opts.pool.query(
      `SELECT provider, model_id, status, requests_remaining,
              last_checked_at, last_error, latency_ms
       FROM agent_service_provider_health
       ORDER BY provider, model_id`,
    );

    // Merge with model catalog to show full picture
    const catalogModels = MODELS.map((m) => ({
      id: m.id,
      provider: m.provider,
      name: m.name,
      free_limit: m.freeLimit,
      context_window: m.contextWindow,
      best_for: m.bestFor,
      requires_key: m.requiresKey,
    }));

    return reply.send({
      models: catalogModels,
      health: rows,
    });
  });
}
