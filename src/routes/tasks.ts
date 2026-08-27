import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbPool } from "../store/db";
import {
  createTask,
  getTask,
  listTasks,
  getResult,
} from "../store/tasks";
import { findTemplate } from "../templates/catalog";
import { findProvider, PROVIDERS } from "../providers/registry";
import { runTask } from "../agent/runner";
import { getSuggestions } from "../agent/suggestions";
import { extractWorkspaceId } from "../auth";

const createTaskSchema = z.object({
  template_id: z.string().min(1),
  model_id: z.string().min(1),
  prompt: z.string().min(1).max(8000),
  metadata: z.record(z.unknown()).optional().default({}),
});

export function registerTaskRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    encryptionKey: string;
    zenToken: string | null;
    fallbackGoogleKey: string | null;
    fallbackGroqKey: string | null;
  },
) {
  app.post("/tasks", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }

    const { template_id, model_id, prompt, metadata } = parsed.data;

    const template = findTemplate(template_id);
    if (!template) {
      return reply.code(404).send({ error: `template '${template_id}' not found` });
    }

    // Check if the model exists in any provider
    const modelExists = PROVIDERS.some((p) => p.models.some((m) => m.id === model_id));
    if (!modelExists) {
      return reply.code(404).send({ error: `model '${model_id}' not found` });
    }

    const task = await createTask(opts.pool, workspaceId, template_id, model_id, prompt, metadata);

    // Fire and forget — the task runs in the background
    runTask({
      pool: opts.pool,
      taskId: task.id,
      workspaceId,
      template,
      modelId: model_id,
      prompt,
      encryptionKey: opts.encryptionKey,
      zenToken: opts.zenToken,
      fallbackGoogleKey: opts.fallbackGoogleKey,
      fallbackGroqKey: opts.fallbackGroqKey,
    }).catch((err) => {
      console.error(`Task ${task.id} crashed:`, err);
    });

    return reply.code(202).send(task);
  });

  app.get("/tasks", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const limit = Math.min(Number((request.query as { limit?: string }).limit) || 20, 100);
    const tasks = await listTasks(opts.pool, workspaceId, limit);
    return reply.send({ tasks });
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const task = await getTask(opts.pool, request.params.id);
    if (!task || task.workspace_id !== workspaceId) {
      return reply.code(404).send({ error: "task not found" });
    }
    return reply.send(task);
  });

  app.get<{ Params: { id: string } }>("/tasks/:id/result", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const task = await getTask(opts.pool, request.params.id);
    if (!task || task.workspace_id !== workspaceId) {
      return reply.code(404).send({ error: "task not found" });
    }
    if (task.status !== "completed") {
      return reply.code(409).send({ error: `task is ${task.status}`, task });
    }

    const result = await getResult(opts.pool, request.params.id);
    if (!result) {
      return reply.code(404).send({ error: "result not found" });
    }
    return reply.send(result);
  });

  // Suggestions — data-driven task prompts the operator can click to run
  app.get("/suggestions", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const suggestions = await getSuggestions(opts.pool, workspaceId);
    return reply.send({ suggestions });
  });
}
