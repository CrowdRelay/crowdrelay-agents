import type { DbPool } from "../store/db.js";
import { findTemplate } from "../templates/catalog.js";

/**
 * Schedule ticker state. Runs one task per due schedule; the actual task
 * execution reuses the normal POST /tasks path invariants (rate limits,
 * budgets) because schedule-driven work is not special — it just has no
 * human clicking "run".
 */

export interface Schedule {
  id: string;
  workspace_id: string;
  template_id: string;
  model_id: string;
  instruction: string;
  interval_minutes: number;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
}

export async function listSchedules(pool: DbPool, workspaceId: string): Promise<Schedule[]> {
  const { rows } = await pool.query(
    `SELECT * FROM agent_service_schedules WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows as unknown as Schedule[];
}

export async function createSchedule(
  pool: DbPool,
  workspaceId: string,
  input: { template_id: string; model_id: string; instruction: string; interval_minutes: number },
): Promise<Schedule | { error: string }> {
  const template = findTemplate(input.template_id);
  if (!template) return { error: `template '${input.template_id}' not found` };
  const { rows } = await pool.query(
    `INSERT INTO agent_service_schedules (workspace_id, template_id, model_id, instruction, interval_minutes, next_run_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $5))
     ON CONFLICT (workspace_id, template_id)
     DO UPDATE SET model_id = $3, instruction = $4, interval_minutes = $5,
                   enabled = true, next_run_at = now() + make_interval(mins => $5)
     RETURNING *`,
    [workspaceId, input.template_id, input.model_id, input.instruction, input.interval_minutes],
  );
  return rows[0] as unknown as Schedule;
}

export async function deleteSchedule(pool: DbPool, workspaceId: string, scheduleId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM agent_service_schedules WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, scheduleId],
  );
  return (rowCount ?? 0) > 0;
}

export async function setScheduleEnabled(
  pool: DbPool,
  workspaceId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE agent_service_schedules SET enabled = $3
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, scheduleId, enabled],
  );
  return (rowCount ?? 0) > 0;
}

export interface DueSchedule extends Schedule {}

/** Claims due schedules atomically (FOR UPDATE SKIP LOCKED) and advances
 *  next_run_at so a concurrent ticker cannot double-fire. Uses a MATERIALIZED
 *  CTE to ensure the FOR UPDATE locks the selected rows before the UPDATE
 *  touches them — a plain `WHERE id IN (SELECT ... FOR UPDATE ... LIMIT)`
 *  may not lock all matched rows reliably. */
export async function claimDueSchedules(pool: DbPool, limit = 5): Promise<DueSchedule[]> {
  const { rows } = await pool.query(
    `WITH due AS MATERIALIZED (
       SELECT id FROM agent_service_schedules
       WHERE enabled AND next_run_at <= now()
       ORDER BY next_run_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE agent_service_schedules
     SET next_run_at = now() + make_interval(mins => interval_minutes),
         last_run_at = now()
     WHERE id IN (SELECT id FROM due)
     RETURNING *`,
    [limit],
  );
  return rows as unknown as DueSchedule[];
}
