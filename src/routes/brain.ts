import type { FastifyInstance } from "fastify";
import type { DbPool } from "../store/db.js";
import { extractWorkspaceId } from "../auth.js";

/**
 * Brain transparency routes. The brain is the deterministic Rust autopilot —
 * it dispatches LLM workers via `RequestAgentRun` actions and creates
 * `agent_service_workflows` rows. These routes let the control panel observe
 * the brain's decision log: what it decided to research, why (rationale),
 * what the workers found, and the downstream status.
 *
 * There is no POST endpoint — the brain creates workflows via the Rust
 * autopilot, not via this TS API.
 */
export function registerBrainRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
  },
) {
  /**
   * GET /brain/decisions — Returns the brain's recent decision log for this
   * workspace. Each entry is a workflow (brain plan) with its plan items
   * (rationale + prompt), dispatched worker tasks, and their results.
   *
   * Query params:
   * - limit: number of decisions (default 20, max 100)
   * - days: time range in days (default 30, max 365)
   */
  app.get("/brain/decisions", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(
        opts.authKey,
        request.headers as Record<string, string | string[] | undefined>,
      );
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message });
    }

    const query = request.query as { limit?: string; days?: string };
    const limit = Math.max(1, Math.min(Math.trunc(Number(query.limit) || 20), 100));
    const days = Math.max(1, Math.min(Math.trunc(Number(query.days) || 30), 365));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    // Fetch brain workflows with their plan items
    const workflowsRow = await opts.pool.query(
      `SELECT id, brain_template, brain_model, status, plan,
              parent_task_id, created_at, completed_at
       FROM agent_service_workflows
       WHERE workspace_id = $1 AND created_at >= $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [workspaceId, since, limit],
    );

    const workflowIds = workflowsRow.rows.map((r) => r.id as string);

    // Fetch workflow tasks (dispatched workers) for all workflows in one query
    let workflowTasks: Array<{
      workflow_id: string;
      task_id: string;
      slot: number;
      role: string;
      task_status: string;
      task_template_id: string;
      task_error: string | null;
      task_created_at: string | null;
      task_completed_at: string | null;
      result_structured: unknown;
      result_tokens_in: number | null;
      result_tokens_out: number | null;
    }> = [];
    if (workflowIds.length > 0) {
      const tasksRow = await opts.pool.query(
        `SELECT wt.workflow_id, wt.task_id, wt.slot, wt.role,
                t.status AS task_status, t.template_id AS task_template_id,
                t.error AS task_error, t.created_at AS task_created_at,
                t.completed_at AS task_completed_at,
                r.structured AS result_structured,
                r.tokens_in AS result_tokens_in,
                r.tokens_out AS result_tokens_out
         FROM agent_service_workflow_tasks wt
         JOIN agent_service_tasks t ON t.id = wt.task_id
         LEFT JOIN LATERAL (
           SELECT structured, tokens_in, tokens_out
           FROM agent_service_results
           WHERE task_id = wt.task_id
           ORDER BY created_at DESC
           LIMIT 1
         ) r ON true
         WHERE wt.workflow_id = ANY($1::uuid[])
         ORDER BY wt.workflow_id, wt.slot`,
        [workflowIds],
      );
      workflowTasks = tasksRow.rows.map((r) => ({
        workflow_id: r.workflow_id,
        task_id: r.task_id,
        slot: r.slot,
        role: r.role,
        task_status: r.task_status,
        task_template_id: r.task_template_id,
        task_error: r.task_error,
        task_created_at: r.task_created_at,
        task_completed_at: r.task_completed_at,
        result_structured: r.result_structured,
        result_tokens_in: r.result_tokens_in,
        result_tokens_out: r.result_tokens_out,
      }));
    }

    // Group tasks by workflow_id
    const tasksByWorkflow: Record<string, typeof workflowTasks> = {};
    for (const t of workflowTasks) {
      if (!tasksByWorkflow[t.workflow_id]) {
        tasksByWorkflow[t.workflow_id] = [];
      }
      tasksByWorkflow[t.workflow_id]!.push(t);
    }

    // Build decision entries
    const decisions = workflowsRow.rows.map((wf) => {
      // Validate plan JSON — it must be an array. If it's malformed (object,
      // string, null), return an empty array so the frontend doesn't crash.
      const rawPlan = wf.plan;
      const plan = Array.isArray(rawPlan)
        ? rawPlan as Array<{ template: string; prompt: string; priority: number; rationale: string }>
        : [];
      const tasks = tasksByWorkflow[wf.id as string] ?? [];
      return {
        id: wf.id,
        brain_template: wf.brain_template,
        brain_model: wf.brain_model,
        status: wf.status,
        created_at: wf.created_at,
        completed_at: wf.completed_at,
        plan: plan ?? [],
        tasks: tasks.map((t) => ({
          task_id: t.task_id,
          slot: t.slot,
          role: t.role,
          status: t.task_status,
          template_id: t.task_template_id,
          error: t.task_error,
          created_at: t.task_created_at,
          completed_at: t.task_completed_at,
          has_outcome: t.result_structured != null,
          outcome_kind: (t.result_structured as { kind?: string } | null)?.kind ?? null,
          tokens_in: t.result_tokens_in ?? 0,
          tokens_out: t.result_tokens_out ?? 0,
        })),
      };
    });

    // Summary stats
    const totalDecisions = decisions.length;
    const completedDecisions = decisions.filter((d) => d.status === "completed").length;
    const failedDecisions = decisions.filter((d) => d.status === "failed").length;
    const runningDecisions = decisions.filter((d) => d.status === "running" || d.status === "dispatching" || d.status === "planning").length;
    const totalTasks = decisions.reduce((sum, d) => sum + d.tasks.length, 0);
    const completedTasks = decisions.reduce((sum, d) => sum + d.tasks.filter((t) => t.status === "completed").length, 0);

    return reply.send({
      days,
      since,
      decisions,
      summary: {
        total_decisions: totalDecisions,
        completed_decisions: completedDecisions,
        failed_decisions: failedDecisions,
        running_decisions: runningDecisions,
        total_tasks: totalTasks,
        completed_tasks: completedTasks,
      },
    });
  });
}
