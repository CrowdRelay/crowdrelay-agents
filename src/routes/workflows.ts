import type { FastifyInstance } from "fastify";
import type { DbPool } from "../store/db.js";
import { extractWorkspaceId } from "../auth.js";
import {
  listWorkflows,
  getWorkflow,
  getWorkflowTasks,
} from "../store/workflows.js";

/**
 * Workflow observation routes (read-only).
 *
 * The brain is the deterministic Rust autopilot. It dispatches LLM workers
 * via `RequestAgentRun` actions. These routes let the control panel observe
 * which worker runs the brain has dispatched and their status.
 *
 * There is no POST endpoint — the brain creates workflows and tasks via
 * the Rust autopilot, not via this TS API.
 */
export function registerWorkflowRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
  },
) {
  // List workflows for this workspace.
  app.get("/workflows", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const limit = Math.max(1, Math.min(Number((request.query as { limit?: string }).limit) || 20, 100));
    const workflows = await listWorkflows(opts.pool, workspaceId, limit);
    return reply.send({ workflows });
  });

  // Get a single workflow with its sub-tasks.
  app.get<{ Params: { id: string } }>("/workflows/:id", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const workflow = await getWorkflow(opts.pool, request.params.id);
    if (!workflow || workflow.workspace_id !== workspaceId) {
      return reply.code(404).send({ error: "workflow not found" });
    }

    const tasks = await getWorkflowTasks(opts.pool, workflow.id);
    return reply.send({ workflow, tasks });
  });
}
