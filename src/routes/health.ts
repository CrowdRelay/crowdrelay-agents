import type { FastifyInstance } from "fastify";
import { MODELS } from "../agent/models.js";
import type { DbPool } from "../store/db.js";

const VERSION = process.env.npm_package_version ?? "unknown";

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
