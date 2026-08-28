import type { DbPool } from "./db.js";

/**
 * Workflow observation store (read-only from the TS side).
 *
 * The brain is the deterministic Rust autopilot. It creates workflows and
 * dispatches worker tasks via `RequestAgentRun` actions, writing directly
 * to the `agent_service_workflows` and `agent_service_workflow_tasks` tables.
 *
 * This module provides read-only queries for the control panel to observe
 * which worker runs the brain has dispatched and their status.
 */

export interface Workflow {
  id: string;
  workspace_id: string;
  brain_template: string;
  brain_model: string | null;
  status: "planning" | "dispatching" | "running" | "completed" | "failed";
  plan: GrowthPlanItem[] | null;
  parent_task_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface GrowthPlanItem {
  template: string;
  prompt: string;
  priority: number;
  rationale: string;
}

export interface WorkflowTask {
  workflow_id: string;
  task_id: string;
  slot: number;
  role: "brain" | "muscle";
  task_status: string;
  task_template_id: string;
  task_error: string | null;
}

export async function getWorkflow(pool: DbPool, workflowId: string): Promise<Workflow | null> {
  const { rows } = await pool.query(
    `SELECT * FROM agent_service_workflows WHERE id = $1`,
    [workflowId],
  );
  return rows[0] ? rowToWorkflow(rows[0]) : null;
}

export async function listWorkflows(
  pool: DbPool,
  workspaceId: string,
  limit = 20,
): Promise<Workflow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM agent_service_workflows
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map(rowToWorkflow);
}

export async function getWorkflowTasks(
  pool: DbPool,
  workflowId: string,
): Promise<WorkflowTask[]> {
  const { rows } = await pool.query(
    `SELECT wt.workflow_id, wt.task_id, wt.slot, wt.role,
            t.status AS task_status, t.template_id AS task_template_id,
            t.error AS task_error
     FROM agent_service_workflow_tasks wt
     JOIN agent_service_tasks t ON t.id = wt.task_id
     WHERE wt.workflow_id = $1
     ORDER BY wt.slot`,
    [workflowId],
  );
  return rows.map((r) => ({
    workflow_id: r.workflow_id,
    task_id: r.task_id,
    slot: r.slot,
    role: r.role,
    task_status: r.task_status,
    task_template_id: r.task_template_id,
    task_error: r.task_error,
  }));
}

function rowToWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    brain_template: row.brain_template as string,
    brain_model: row.brain_model as string | null,
    status: row.status as Workflow["status"],
    plan: row.plan as GrowthPlanItem[] | null,
    parent_task_id: row.parent_task_id as string | null,
    created_at: row.created_at as string,
    completed_at: row.completed_at as string | null,
  };
}
