import type { FastifyInstance } from "fastify";
import type { DbPool } from "../store/db.js";
import { extractWorkspaceId } from "../auth.js";

/**
 * Growth funnel routes. The control plane frontend calls these to render the
 * growth funnel dashboard — the full fan journey from community discovery to
 * ticket sales.
 *
 * The agent service owns the early funnel stages (communities discovered,
 * worker runs dispatched by the brain). The later stages (outreach targets,
 * community posts, smart link clicks, Signal signups, ticket sales) live in
 * CrowdRelay and are already exposed via the control plane's operations read
 * model. The frontend combines both sources.
 */
export function registerGrowthRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
  },
) {
  /**
   * GET /growth/funnel — Returns the agent-service side of the growth funnel
   * for this workspace, scoped to an optional time range (days, default 30).
   *
   * Returns:
   * - communities_discovered: count from reddit_scrape_results
   * - worker_runs: per-template counts (reddit-scanner, community-engager,
   *   signal-inviter, press-pitch, social-post) with status breakdown
   * - brain_workflows: count and status breakdown of brain-dispatched plans
   * - recent_worker_runs: last 20 worker runs with template, status, outcome
   */
  app.get("/growth/funnel", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(
        opts.authKey,
        request.headers as Record<string, string | string[] | undefined>,
      );
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message });
    }

    const days = Math.max(1, Math.min(Math.trunc(Number((request.query as { days?: string }).days) || 30), 365));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const workerTemplates = [
      "reddit-scanner",
      "community-engager",
      "signal-inviter",
      "press-pitch",
      "social-post",
      "audience-research",
      "campaign-analysis",
      "growth-strategist",
    ];

    // Run all 4 independent queries in parallel to stay well under the
    // control plane's 10s proxy timeout.
    const [communitiesRow, workerRunsRow, workflowsRow, recentRow] = await Promise.all([
      // Communities discovered (from Reddit scraper)
      opts.pool.query(
        `SELECT COUNT(DISTINCT subreddit_name) AS count
         FROM reddit_scrape_results
         WHERE workspace_id = $1 AND scraped_at >= $2`,
        [workspaceId, since],
      ),
      // Worker runs per template, with status breakdown
      opts.pool.query(
        `SELECT template_id, status, COUNT(*) AS count
         FROM agent_service_tasks
         WHERE workspace_id = $1
           AND created_at >= $2
           AND template_id = ANY($3::text[])
         GROUP BY template_id, status`,
        [workspaceId, since, workerTemplates],
      ),
      // Brain-dispatched workflows
      opts.pool.query(
        `SELECT status, COUNT(*) AS count
         FROM agent_service_workflows
         WHERE workspace_id = $1 AND created_at >= $2
         GROUP BY status`,
        [workspaceId, since],
      ),
      // Recent worker runs (last 20) with outcome summary.
      // LATERAL join ensures exactly one result row per task (the latest),
      // avoiding row duplication when a task has multiple result rows.
      opts.pool.query(
        `SELECT t.id, t.template_id, t.status, t.created_at, t.completed_at,
                r.structured, r.tokens_in, r.tokens_out
         FROM agent_service_tasks t
         LEFT JOIN LATERAL (
           SELECT structured, tokens_in, tokens_out
           FROM agent_service_results
           WHERE task_id = t.id
           ORDER BY created_at DESC
           LIMIT 1
         ) r ON true
         WHERE t.workspace_id = $1
           AND t.created_at >= $2
           AND t.template_id = ANY($3::text[])
         ORDER BY t.created_at DESC
         LIMIT 20`,
        [workspaceId, since, workerTemplates],
      ),
    ]);

    const communitiesDiscovered = Math.min(
      Number(communitiesRow.rows[0]?.count ?? 0),
      Number.MAX_SAFE_INTEGER,
    );

    const workerRuns: Record<string, { total: number; completed: number; failed: number; running: number; queued: number }> = {};
    for (const row of workerRunsRow.rows) {
      const tpl = row.template_id as string;
      const status = row.status as string;
      const count = Math.min(Number(row.count), Number.MAX_SAFE_INTEGER);
      if (!workerRuns[tpl]) {
        workerRuns[tpl] = { total: 0, completed: 0, failed: 0, running: 0, queued: 0 };
      }
      workerRuns[tpl].total += count;
      if (status === "completed") workerRuns[tpl].completed += count;
      else if (status === "failed") workerRuns[tpl].failed += count;
      else if (status === "running") workerRuns[tpl].running += count;
      else if (status === "queued") workerRuns[tpl].queued += count;
    }

    const brainWorkflows: Record<string, number> = {};
    let totalWorkflows = 0;
    for (const row of workflowsRow.rows) {
      const status = row.status as string;
      const count = Math.min(Number(row.count), Number.MAX_SAFE_INTEGER);
      brainWorkflows[status] = count;
      totalWorkflows += count;
    }

    const recentWorkerRuns = recentRow.rows.map((r) => ({
      id: r.id,
      template_id: r.template_id,
      status: r.status,
      created_at: r.created_at,
      completed_at: r.completed_at,
      has_outcome: r.structured != null,
      outcome_kind: r.structured?.kind ?? null,
      tokens_in: r.tokens_in ?? 0,
      tokens_out: r.tokens_out ?? 0,
    }));

    return reply.send({
      days,
      since,
      communities_discovered: communitiesDiscovered,
      worker_runs: workerRuns,
      brain_workflows: {
        total: totalWorkflows,
        by_status: brainWorkflows,
      },
      recent_worker_runs: recentWorkerRuns,
    });
  });
}
