import type { DbPool } from "../store/db.js";
import { findProvider, estimateCostMicroUsd, type ProviderModel } from "../providers/registry.js";

/**
 * Usage ledger + budget enforcement. Replaces the in-memory hourly rate map
 * with the agent_service_usage table (multi-instance safe); the in-memory
 * concurrent-task guard stays in routes/tasks.ts — concurrency is a property
 * of one process.
 */

export interface BudgetState {
  spentMonthMicroUsd: number;
  limitMicroUsd: number;
  remainingMicroUsd: number;
}

export async function recordUsage(
  pool: DbPool,
  workspaceId: string,
  providerId: string,
  model: ProviderModel,
  usage: { tokensIn: number | null; tokensOut: number | null },
): Promise<number> {
  const costMicroUsd = estimateCostMicroUsd(model, usage.tokensIn ?? 0, usage.tokensOut ?? 0);
  await pool.query(
    `INSERT INTO agent_service_usage (workspace_id, day, provider, model_id, requests, tokens_in, tokens_out, cost_micro_usd)
     VALUES ($1, CURRENT_DATE, $2, $3, 1, $4, $5, $6)
     ON CONFLICT (workspace_id, day, provider, model_id)
     DO UPDATE SET requests = agent_service_usage.requests + 1,
                   tokens_in = agent_service_usage.tokens_in + EXCLUDED.tokens_in,
                   tokens_out = agent_service_usage.tokens_out + EXCLUDED.tokens_out,
                   cost_micro_usd = agent_service_usage.cost_micro_usd + EXCLUDED.cost_micro_usd`,
    [workspaceId, providerId, model.id, usage.tokensIn ?? 0, usage.tokensOut ?? 0, costMicroUsd],
  );
  return costMicroUsd;
}

export async function getBudgetState(
  pool: DbPool,
  workspaceId: string,
  defaultMonthlyBudgetMicroUsd: number,
): Promise<BudgetState> {
  const [spend, budget] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
       FROM agent_service_usage
       WHERE workspace_id = $1
         AND day >= date_trunc('month', CURRENT_DATE)`,
      [workspaceId],
    ),
    pool.query(
      `SELECT monthly_cost_micro_usd FROM agent_service_budgets WHERE workspace_id = $1`,
      [workspaceId],
    ),
  ]);
  const limit = Number(
    budget.rows[0]?.monthly_cost_micro_usd ?? defaultMonthlyBudgetMicroUsd,
  );
  const spent = Number(spend.rows[0]?.spent ?? 0);
  return {
    spentMonthMicroUsd: spent,
    limitMicroUsd: limit,
    remainingMicroUsd: Math.max(0, limit - spent),
  };
}

export async function setBudget(
  pool: DbPool,
  workspaceId: string,
  monthlyCostMicroUsd: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_service_budgets (workspace_id, monthly_cost_micro_usd, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (workspace_id)
     DO UPDATE SET monthly_cost_micro_usd = $2, updated_at = now()`,
    [workspaceId, monthlyCostMicroUsd],
  );
}

/**
 * Pre-flight check at task creation. Rejects when the monthly budget is
 * exhausted; free-tier models never consume budget, so a free-model task is
 * always allowed.
 */
export async function checkBudgetForTask(
  pool: DbPool,
  workspaceId: string,
  providerId: string,
  modelId: string,
  defaultMonthlyBudgetMicroUsd: number,
): Promise<{ allowed: true } | { allowed: false; state: BudgetState }> {
  const provider = findProvider(providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  if (!model || !model.paid) return { allowed: true };

  const state = await getBudgetState(pool, workspaceId, defaultMonthlyBudgetMicroUsd);
  if (state.remainingMicroUsd <= 0) return { allowed: false, state };
  return { allowed: true };
}

/** Daily request count across all providers/models for this workspace.
 *  (Usage rows are per-day; the old in-memory hourly map becomes a daily cap —
 *  one client still cannot drain a provider quota by spamming.) */
export async function dailyRequests(pool: DbPool, workspaceId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(requests), 0)::int AS count
     FROM agent_service_usage
     WHERE workspace_id = $1 AND day = CURRENT_DATE`,
    [workspaceId],
  );
  return Number(rows[0]?.count ?? 0);
}
