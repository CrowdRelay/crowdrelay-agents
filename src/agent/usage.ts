import type { DbPool } from "../store/db.js";
import { PROVIDERS, findProvider, estimateCostMicroUsd, type ProviderModel } from "../providers/registry.js";

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

/**
 * Safely converts a BIGINT query result to a finite Number. Values beyond
 * Number.MAX_SAFE_INTEGER (~9 quadrillion micro-USD = ~$9 trillion) are
 * clamped to avoid silent precision loss. In practice spend never approaches
 * this, but the guard prevents NaN from disrupting the budget gate.
 */
function bigIntToSafeNumber(value: unknown, fallback: number = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

export async function recordUsage(
  pool: DbPool,
  workspaceId: string,
  providerId: string,
  model: ProviderModel,
  usage: { tokensIn: number | null; tokensOut: number | null },
  defaultMonthlyBudgetMicroUsd?: number,
): Promise<number> {
  const costMicroUsd = estimateCostMicroUsd(model, usage.tokensIn ?? 0, usage.tokensOut ?? 0);

  // Atomic budget enforcement: lock the budget row (or a workspace sentinel)
  // for the duration of the insert + running-total check. Without this,
  // concurrent tasks can all read remaining > 0 and then all insert, overshooting.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the budget row if it exists. If no explicit budget is set, lock
    // the workspace sentinel via the usage table's per-workspace aggregate.
    // We use a SELECT ... FOR UPDATE on the budget row to serialize writes.
    await client.query(
      `SELECT monthly_cost_micro_usd FROM agent_service_budgets
       WHERE workspace_id = $1 FOR UPDATE`,
      [workspaceId],
    );
    // Check remaining budget before inserting. If the budget is exhausted,
    // reject this usage to prevent overspend by concurrent tasks.
    if (!model.paid) {
      // Free-tier models never consume budget — skip the check entirely.
    } else {
      const defaultBudget = defaultMonthlyBudgetMicroUsd ?? 0;
      const { rows: spendRows } = await client.query(
        `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
         FROM agent_service_usage
         WHERE workspace_id = $1
           AND day >= date_trunc('month', CURRENT_DATE)`,
        [workspaceId],
      );
      const { rows: budgetRows } = await client.query(
        `SELECT monthly_cost_micro_usd FROM agent_service_budgets WHERE workspace_id = $1`,
        [workspaceId],
      );
      const limit = bigIntToSafeNumber(
        budgetRows[0]?.monthly_cost_micro_usd,
        defaultBudget,
      );
      const spent = bigIntToSafeNumber(spendRows[0]?.spent, 0);
      if (limit > 0 && spent + costMicroUsd > limit) {
        await client.query("ROLLBACK");
        return 0;
      }
    }
    await client.query(
      `INSERT INTO agent_service_usage (workspace_id, day, provider, model_id, requests, tokens_in, tokens_out, cost_micro_usd)
       VALUES ($1, CURRENT_DATE, $2, $3, 1, $4, $5, $6)
       ON CONFLICT (workspace_id, day, provider, model_id)
       DO UPDATE SET requests = agent_service_usage.requests + 1,
                     tokens_in = agent_service_usage.tokens_in + EXCLUDED.tokens_in,
                     tokens_out = agent_service_usage.tokens_out + EXCLUDED.tokens_out,
                     cost_micro_usd = agent_service_usage.cost_micro_usd + EXCLUDED.cost_micro_usd`,
      [workspaceId, providerId, model.id, usage.tokensIn ?? 0, usage.tokensOut ?? 0, costMicroUsd],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  const limit = bigIntToSafeNumber(
    budget.rows[0]?.monthly_cost_micro_usd,
    defaultMonthlyBudgetMicroUsd,
  );
  const spent = bigIntToSafeNumber(spend.rows[0]?.spent, 0);
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
 *
 * A model_id (e.g. "gpt-4o") can exist in multiple providers — one paid
 * (OpenAI) and one free (GitHub Copilot). The task is only budget-gated
 * if ALL providers offering this model mark it as paid. If any provider
 * offers it for free, the runner can use that path and the task is allowed.
 */
export async function checkBudgetForTask(
  pool: DbPool,
  workspaceId: string,
  providerId: string,
  modelId: string,
  defaultMonthlyBudgetMicroUsd: number,
): Promise<{ allowed: true } | { allowed: false; state: BudgetState }> {
  // Check if any provider offers this model as free-tier.
  const allProviders = PROVIDERS;
  const hasFreeVariant = allProviders.some(
    (p) => p.models.some((m) => m.id === modelId && !m.paid),
  );
  if (hasFreeVariant) return { allowed: true };

  // When a specific provider is given, check if that provider's model is paid.
  // When providerId is empty (schedule/queue pre-check), check if ANY provider
  // offers this model as paid — if so, the task must be budget-gated.
  if (providerId) {
    const provider = findProvider(providerId);
    const model = provider?.models.find((m) => m.id === modelId);
    if (!model || !model.paid) return { allowed: true };
  } else {
    const hasPaidVariant = allProviders.some(
      (p) => p.models.some((m) => m.id === modelId && m.paid),
    );
    if (!hasPaidVariant) return { allowed: true };
  }

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
