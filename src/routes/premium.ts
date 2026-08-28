import type { FastifyInstance } from "fastify";
import type { DbPool } from "../store/db.js";
import { extractWorkspaceId } from "../auth.js";
import { getConnectedProviders } from "../store/credentials.js";
import { availablePremiumModels } from "../agent/models.js";

export function registerPremiumRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    defaultMonthlyBudgetMicroUsd: number;
  },
) {
  /**
   * GET /premium/usage — Returns the workspace's premium AI spend and task
   * history. Powers the "Premium AI" panel in the control plane frontend.
   */
  app.get("/premium/usage", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(
        opts.authKey,
        request.headers as Record<string, string | string[] | undefined>,
      );
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message });
    }

    const connectedProviders = await getConnectedProviders(opts.pool, workspaceId);
    const premiumModels = availablePremiumModels(connectedProviders);

    // Monthly spend from agent_service_usage (current calendar month)
    const spendRow = await opts.pool.query(
      `SELECT COALESCE(SUM(cost_micro_usd), 0) AS spent
       FROM agent_service_usage
       WHERE workspace_id = $1
         AND day >= date_trunc('month', now()::date)`,
      [workspaceId],
    );
    const spentRaw = spendRow.rows[0]?.spent;
    const spentMonthMicroUsd = spentRaw !== null && spentRaw !== undefined
      ? Math.min(Number(spentRaw), Number.MAX_SAFE_INTEGER)
      : 0;

    // Budget limit (per-workspace override or system default)
    const budgetRow = await opts.pool.query(
      `SELECT monthly_cost_micro_usd FROM agent_service_budgets WHERE workspace_id = $1`,
      [workspaceId],
    );
    const limitMicroUsd = budgetRow.rows[0]?.monthly_cost_micro_usd != null
      ? Math.min(Number(budgetRow.rows[0].monthly_cost_micro_usd), Number.MAX_SAFE_INTEGER)
      : opts.defaultMonthlyBudgetMicroUsd;

    // Recent premium tasks (last 20)
    const tasksRow = await opts.pool.query(
      `SELECT id, template_id, model_id, model_provider, tier, cost_micro_usd,
              status, created_at, completed_at
       FROM agent_service_tasks
       WHERE workspace_id = $1 AND tier = 'premium'
       ORDER BY created_at DESC
       LIMIT 20`,
      [workspaceId],
    );

    return reply.send({
      connected_providers: connectedProviders,
      premium_models: premiumModels.map((m) => ({
        id: m.id,
        provider: m.provider,
        name: m.name,
        best_for: m.bestFor,
        agentic: m.agentic ?? false,
        price_input_per_mtok: m.priceInputPerMTok,
        price_output_per_mtok: m.priceOutputPerMTok,
      })),
      monthly_spend_micro_usd: spentMonthMicroUsd,
      budget_micro_usd: limitMicroUsd,
      tasks: tasksRow.rows,
    });
  });
}
