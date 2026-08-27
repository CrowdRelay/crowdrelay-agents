import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbPool } from "../store/db.js";
import {
  createTask,
  getTask,
  listTasks,
  getResult,
} from "../store/tasks.js";
import { findTemplate } from "../templates/catalog.js";
import { PROVIDERS } from "../providers/registry.js";
import { runTask } from "../agent/runner.js";
import { getSuggestions } from "../agent/suggestions.js";
import { extractWorkspaceId } from "../auth.js";

const createTaskSchema = z.object({
  template_id: z.string().min(1),
  model_id: z.string().min(1),
  prompt: z.string().min(1).max(8000),
  metadata: z.record(z.unknown()).optional().default({}),
});

// Per-workspace rate limit: max 5 concurrent running tasks, max 20 per hour.
// Without this, a single client can exhaust the free Zen quota (100 req/day)
// in seconds by spamming task creation.
const runningTaskCount = new Map<string, number>();
const taskTimestamps = new Map<string, number[]>();
const MAX_CONCURRENT = 5;
const MAX_PER_HOUR = 20;

function checkRateLimit(workspaceId: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  // Concurrent check
  const running = runningTaskCount.get(workspaceId) ?? 0;
  if (running >= MAX_CONCURRENT) {
    return { allowed: false, reason: `too many concurrent tasks (max ${MAX_CONCURRENT})` };
  }

  // Hourly check
  const timestamps = (taskTimestamps.get(workspaceId) ?? []).filter((t) => t > hourAgo);
  if (timestamps.length >= MAX_PER_HOUR) {
    return { allowed: false, reason: `rate limit exceeded (max ${MAX_PER_HOUR}/hour)` };
  }

  timestamps.push(now);
  taskTimestamps.set(workspaceId, timestamps);
  return { allowed: true };
}

// Periodic cleanup of empty timestamp arrays — prevents the Map from growing
// unboundedly as new workspaces are seen over time.
setInterval(() => {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  for (const [key, timestamps] of taskTimestamps) {
    const fresh = timestamps.filter((t) => t > hourAgo);
    if (fresh.length === 0) {
      taskTimestamps.delete(key);
    } else if (fresh.length !== timestamps.length) {
      taskTimestamps.set(key, fresh);
    }
  }
  // Also clean up zero-count running task entries
  for (const [key, count] of runningTaskCount) {
    if (count === 0) runningTaskCount.delete(key);
  }
}, 10 * 60 * 1000).unref();

function trackTaskStart(workspaceId: string): void {
  runningTaskCount.set(workspaceId, (runningTaskCount.get(workspaceId) ?? 0) + 1);
}

function trackTaskEnd(workspaceId: string): void {
  const current = runningTaskCount.get(workspaceId) ?? 0;
  runningTaskCount.set(workspaceId, Math.max(0, current - 1));
}

function refundRateLimit(workspaceId: string): void {
  const timestamps = taskTimestamps.get(workspaceId);
  if (timestamps && timestamps.length > 0) {
    timestamps.pop();
  }
}

export function registerTaskRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    encryptionKey: string;
    zenToken: string | null;
    fallbackGoogleKey: string | null;
    fallbackGroqKey: string | null;
    inFlightTasks: Set<Promise<void>>;
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

    const rateLimit = checkRateLimit(workspaceId);
    if (!rateLimit.allowed) {
      return reply.code(429).send({ error: rateLimit.reason });
    }

    let task;
    try {
      task = await createTask(opts.pool, workspaceId, template_id, model_id, prompt, metadata);
    } catch (err) {
      // DB insert failed — refund the rate-limit slot so the client isn't penalised
      refundRateLimit(workspaceId);
      throw err;
    }

    // Fire and forget — the task runs in the background
    trackTaskStart(workspaceId);
    const taskPromise = runTask({
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
    }).finally(() => {
      trackTaskEnd(workspaceId);
    });
    opts.inFlightTasks.add(taskPromise);
    void taskPromise.finally(() => opts.inFlightTasks.delete(taskPromise));

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
