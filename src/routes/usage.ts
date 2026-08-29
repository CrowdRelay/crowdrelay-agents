import type { FastifyInstance } from "fastify";
import type { DbPool } from "../store/db.js";
import { extractWorkspaceId } from "../auth.js";
import { getConnectedProviders } from "../store/credentials.js";
import { PROVIDERS } from "../providers/registry.js";

/**
 * Unified AI usage analytics. Combines cost-ROI per template with model
 * routing analytics and daily spend trends into one endpoint that powers
 * the AI Usage dashboard in the control plane.
 */
export function registerUsageRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    defaultMonthlyBudgetMicroUsd: number;
  },
) {
  /**
   * GET /usage/analytics — Returns unified AI usage analytics:
   * 1. Budget status (monthly spend vs budget)
   * 2. Cost-ROI per template (cost vs outcomes produced)
   * 3. Model routing analytics (success rate, latency, cost per task)
   * 4. Daily spend trend (last 30 days, free vs paid)
   */
  app.get("/usage/analytics", async (request, reply) => {
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

    // Run all 4 independent DB queries in parallel to stay well under the
    // control plane's 10s proxy timeout. Sequential execution would take
    // 4x as long on a workspace with many tasks.
    const [spendRow, budgetRow, templateRow, modelRow, dailyRow] = await Promise.all([
      // 1a. Monthly spend
      opts.pool.query(
        `SELECT COALESCE(SUM(cost_micro_usd), 0) AS spent
         FROM agent_service_usage
         WHERE workspace_id = $1
           AND day >= date_trunc('month', now()::date)`,
        [workspaceId],
      ),
      // 1b. Budget limit
      opts.pool.query(
        `SELECT monthly_cost_micro_usd FROM agent_service_budgets WHERE workspace_id = $1`,
        [workspaceId],
      ),
      // 2. Cost-ROI per template (LATERAL join ensures one result per task)
      opts.pool.query(
        `SELECT t.template_id,
                COUNT(*) AS total_tasks,
                COUNT(*) FILTER (WHERE t.status = 'completed') AS completed_tasks,
                COUNT(*) FILTER (WHERE t.status = 'failed') AS failed_tasks,
                COALESCE(SUM(t.cost_micro_usd), 0) AS total_cost,
                COUNT(r.structured) FILTER (WHERE r.structured IS NOT NULL) AS outcome_count,
                COALESCE(SUM(r.tokens_in), 0) AS tokens_in,
                COALESCE(SUM(r.tokens_out), 0) AS tokens_out
         FROM agent_service_tasks t
         LEFT JOIN LATERAL (
           SELECT structured, tokens_in, tokens_out
           FROM agent_service_results
           WHERE task_id = t.id
           ORDER BY created_at DESC
           LIMIT 1
         ) r ON true
         WHERE t.workspace_id = $1
           AND t.created_at >= date_trunc('month', now()::date)
         GROUP BY t.template_id
         ORDER BY total_cost DESC, total_tasks DESC`,
        [workspaceId],
      ),
      // 3. Model routing analytics (LATERAL join ensures one result per task)
      opts.pool.query(
        `SELECT t.model_id,
                t.model_provider,
                COUNT(*) AS total_tasks,
                COUNT(*) FILTER (WHERE t.status = 'completed') AS completed_tasks,
                COUNT(*) FILTER (WHERE t.status = 'failed') AS failed_tasks,
                COALESCE(SUM(t.cost_micro_usd), 0) AS total_cost,
                COALESCE(AVG(r.duration_ms), 0) AS avg_latency_ms,
                COALESCE(AVG(r.tokens_in), 0) AS avg_tokens_in,
                COALESCE(AVG(r.tokens_out), 0) AS avg_tokens_out
         FROM agent_service_tasks t
         LEFT JOIN LATERAL (
           SELECT structured, tokens_in, tokens_out, duration_ms
           FROM agent_service_results
           WHERE task_id = t.id
           ORDER BY created_at DESC
           LIMIT 1
         ) r ON true
         WHERE t.workspace_id = $1
           AND t.created_at >= now() - interval '30 days'
         GROUP BY t.model_id, t.model_provider
         ORDER BY total_tasks DESC`,
        [workspaceId],
      ),
      // 4. Daily spend trend (last 30 days)
      opts.pool.query(
        `SELECT day::text AS day,
                COALESCE(SUM(cost_micro_usd) FILTER (WHERE cost_micro_usd > 0), 0) AS paid_cost,
                COALESCE(SUM(cost_micro_usd) FILTER (WHERE cost_micro_usd = 0), 0) AS free_cost,
                COUNT(*) AS requests
         FROM agent_service_usage
         WHERE workspace_id = $1
           AND day >= CURRENT_DATE - INTERVAL '29 days'
         GROUP BY day
         ORDER BY day`,
        [workspaceId],
      ),
    ]);

    const spentMonthMicroUsd = Math.min(
      Number(spendRow.rows[0]?.spent ?? 0),
      Number.MAX_SAFE_INTEGER,
    );

    const budgetMicroUsd = budgetRow.rows[0]?.monthly_cost_micro_usd != null
      ? Math.min(Number(budgetRow.rows[0].monthly_cost_micro_usd), Number.MAX_SAFE_INTEGER)
      : opts.defaultMonthlyBudgetMicroUsd;

    const templateRoi = templateRow.rows.map((r) => {
      const totalTasks = Math.min(Number(r.total_tasks), Number.MAX_SAFE_INTEGER);
      const completedTasks = Math.min(Number(r.completed_tasks), Number.MAX_SAFE_INTEGER);
      const failedTasks = Math.min(Number(r.failed_tasks), Number.MAX_SAFE_INTEGER);
      const totalCost = Math.min(Number(r.total_cost), Number.MAX_SAFE_INTEGER);
      const outcomeCount = Math.min(Number(r.outcome_count), Number.MAX_SAFE_INTEGER);
      const tokensIn = Math.min(Number(r.tokens_in), Number.MAX_SAFE_INTEGER);
      const tokensOut = Math.min(Number(r.tokens_out), Number.MAX_SAFE_INTEGER);
      const successRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : null;
      const costPerOutcome = outcomeCount > 0 ? Math.round(totalCost / outcomeCount) : null;
      return {
        template_id: r.template_id,
        total_tasks: totalTasks,
        completed_tasks: completedTasks,
        failed_tasks: failedTasks,
        total_cost_micro_usd: totalCost,
        outcome_count: outcomeCount,
        cost_per_outcome_micro_usd: costPerOutcome,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        success_rate: successRate,
      };
    });

    const modelAnalytics = modelRow.rows.map((r) => {
      const totalTasks = Math.min(Number(r.total_tasks), Number.MAX_SAFE_INTEGER);
      const completedTasks = Math.min(Number(r.completed_tasks), Number.MAX_SAFE_INTEGER);
      const failedTasks = Math.min(Number(r.failed_tasks), Number.MAX_SAFE_INTEGER);
      const totalCost = Math.min(Number(r.total_cost), Number.MAX_SAFE_INTEGER);
      const avgLatency = Math.min(Number(r.avg_latency_ms), Number.MAX_SAFE_INTEGER);
      const avgTokensIn = Math.min(Number(r.avg_tokens_in), Number.MAX_SAFE_INTEGER);
      const avgTokensOut = Math.min(Number(r.avg_tokens_out), Number.MAX_SAFE_INTEGER);
      const successRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : null;
      const avgCostPerTask = totalTasks > 0 ? Math.round(totalCost / totalTasks) : 0;
      return {
        model_id: r.model_id,
        model_provider: r.model_provider ?? null,
        total_tasks: totalTasks,
        completed_tasks: completedTasks,
        failed_tasks: failedTasks,
        total_cost_micro_usd: totalCost,
        avg_cost_per_task_micro_usd: avgCostPerTask,
        avg_latency_ms: Math.round(avgLatency),
        avg_tokens_in: Math.round(avgTokensIn),
        avg_tokens_out: Math.round(avgTokensOut),
        success_rate: successRate,
      };
    });

    const dailySpend = dailyRow.rows.map((r) => ({
      day: r.day,
      paid_cost_micro_usd: Math.min(Number(r.paid_cost), Number.MAX_SAFE_INTEGER),
      free_cost_micro_usd: Math.min(Number(r.free_cost), Number.MAX_SAFE_INTEGER),
      requests: Math.min(Number(r.requests), Number.MAX_SAFE_INTEGER),
    }));

    // 5. Available models (connected + free tier + no-auth providers).
    // A model is only "available" if the operator can actually use it:
    // - free models from free-tier providers (no credential needed)
    // - paid models from connected providers
    // - models from providers with authMethod 'none' (no credential needed)
    const availableModels: Array<{
      id: string;
      provider: string;
      name: string;
      paid: boolean;
      connected: boolean;
    }> = [];
    for (const provider of PROVIDERS) {
      const isConnected = connectedProviders.includes(provider.id);
      const noAuthNeeded = provider.authMethod === 'none' || provider.freeTier;
      for (const model of provider.models) {
        if (!model.paid || isConnected || noAuthNeeded) {
          availableModels.push({
            id: model.id,
            provider: provider.id,
            name: model.name,
            paid: model.paid,
            connected: isConnected,
          });
        }
      }
    }

    return reply.send({
      budget: {
        monthly_spend_micro_usd: spentMonthMicroUsd,
        budget_micro_usd: budgetMicroUsd,
        remaining_micro_usd: Math.max(0, budgetMicroUsd - spentMonthMicroUsd),
        days_in_month: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate(),
        day_of_month: new Date().getDate(),
      },
      template_roi: templateRoi,
      model_analytics: modelAnalytics,
      daily_spend: dailySpend,
      connected_providers: connectedProviders,
      available_models: availableModels,
    });
  });
}
