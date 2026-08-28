import type { DbPool } from "./db.js";

export interface Task {
  id: string;
  workspace_id: string;
  template_id: string;
  model_id: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed";
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  tier: "basic" | "premium";
}

export interface TaskResult {
  id: string;
  task_id: string;
  content: string;
  format: string;
  model_used: string;
  tokens_in: number | null;
  tokens_out: number | null;
  duration_ms: number | null;
  created_at: string;
}

export async function createTask(
  pool: DbPool,
  workspaceId: string,
  templateId: string,
  modelId: string,
  prompt: string,
  metadata: Record<string, unknown>,
  instanceId: string,
  tier: "basic" | "premium" = "basic",
): Promise<Task> {
  const { rows } = await pool.query(
    `INSERT INTO agent_service_tasks (workspace_id, template_id, model_id, prompt, metadata, instance_id, tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [workspaceId, templateId, modelId, prompt, JSON.stringify(metadata), instanceId, tier],
  );
  return rowToTask(rows[0]);
}

export async function getTask(pool: DbPool, taskId: string): Promise<Task | null> {
  const { rows } = await pool.query(
    `SELECT * FROM agent_service_tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0] ? rowToTask(rows[0]) : null;
}

/**
 * Claims a queued task for execution. Tasks created by the autopilot brain
 * (via `agent.run.request` actions) are written with `instance_id = NULL`
 * and `status = 'queued'`. This function atomically claims one such task
 * by setting its instance_id and status, so multiple agent-service instances
 * don't double-process.
 *
 * Returns the claimed task, or null if no queued tasks are available.
 */
export async function claimQueuedTask(
  pool: DbPool,
  instanceId: string,
): Promise<Task | null> {
  const { rows } = await pool.query(
    `UPDATE agent_service_tasks
     SET status = 'running', started_at = now(), instance_id = $1
     WHERE id = (
       SELECT id FROM agent_service_tasks
       WHERE status = 'queued'
         AND (instance_id IS NULL OR instance_id = '')
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [instanceId],
  );
  return rows[0] ? rowToTask(rows[0]) : null;
}

export async function listTasks(
  pool: DbPool,
  workspaceId: string,
  limit = 20,
): Promise<Task[]> {
  const { rows } = await pool.query(
    `SELECT * FROM agent_service_tasks
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map(rowToTask);
}

export async function updateTaskStatus(
  pool: DbPool,
  taskId: string,
  status: "running" | "completed" | "failed",
  error?: string | null,
): Promise<void> {
  if (status === "running") {
    await pool.query(
      `UPDATE agent_service_tasks SET status = $2, started_at = now() WHERE id = $1`,
      [taskId, status],
    );
  } else {
    await pool.query(
      `UPDATE agent_service_tasks SET status = $2, completed_at = now(), error = $3 WHERE id = $1`,
      [taskId, status, error ?? null],
    );
  }
}

/**
 * Shallow-merges keys into a task's metadata JSON. Used by the runner to
 * record fallback attempts, context truncation reports, and structured-parse
 * outcomes without clobbering creation-time metadata (source, suggestion_id).
 */
export async function setTaskMetadata(
  pool: DbPool,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `UPDATE agent_service_tasks
     SET metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [taskId, JSON.stringify(patch)],
  );
}

/**
 * On startup, mark tasks left "running" or "queued" by THIS instance's
 * previous process as failed. Without this, a container restart mid-task
 * leaks the task forever — the UI shows it as in-progress eternally and the
 * operator cannot retry. "queued" is included because runTask is
 * fire-and-forget: if the process dies between createTask and runTask, the
 * task stays queued forever.
 *
 * Scoped to the current instance_id so a multi-instance deployment does not
 * fail tasks actively being processed by other instances.
 */
export async function recoverStaleTasks(pool: DbPool, instanceId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE agent_service_tasks
     SET status = 'failed', completed_at = now(), error = 'process restarted mid-task'
     WHERE status IN ('running', 'queued') AND instance_id = $1`,
    [instanceId],
  );
  return rowCount ?? 0;
}

export async function saveResult(
  pool: DbPool,
  taskId: string,
  workspaceId: string,
  result: {
    content: string;
    format: string;
    model_used: string;
    tokens_in?: number;
    tokens_out?: number;
    duration_ms?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_service_results
      (task_id, workspace_id, content, format, model_used, tokens_in, tokens_out, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      taskId,
      workspaceId,
      result.content,
      result.format,
      result.model_used,
      result.tokens_in ?? null,
      result.tokens_out ?? null,
      result.duration_ms ?? null,
    ],
  );
}

export async function getResult(
  pool: DbPool,
  taskId: string,
): Promise<TaskResult | null> {
  const { rows } = await pool.query(
    `SELECT * FROM agent_service_results WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  return rows[0] ?? null;
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    template_id: row.template_id as string,
    model_id: row.model_id as string,
    prompt: row.prompt as string,
    status: row.status as Task["status"],
    error: row.error as string | null,
    created_at: row.created_at as string,
    started_at: row.started_at as string | null,
    completed_at: row.completed_at as string | null,
    metadata: row.metadata as Record<string, unknown>,
    tier: (row.tier as "basic" | "premium") ?? "basic",
  };
}
