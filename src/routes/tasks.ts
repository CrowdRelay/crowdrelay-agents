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
import { PROVIDERS, findProvider } from "../providers/registry.js";
import { runTask } from "../agent/runner.js";
import { getSuggestions } from "../agent/suggestions.js";
import { checkBudgetForTask } from "../agent/usage.js";
import { extractWorkspaceId } from "../auth.js";

const createTaskSchema = z.object({
  template_id: z.string().min(1),
  model_id: z.string().min(1),
  prompt: z.string().min(1).max(8000),
  suggestion_id: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

// Per-workspace rate limit: max 5 concurrent running tasks, max 20 per hour.
// Without this, a single client can exhaust the free Zen quota (100 req/day)
// in seconds by spamming task creation.
const runningTaskCount = new Map<string, number>();
const taskTimestamps = new Map<string, number[]>();
const MAX_CONCURRENT = 5;
const MAX_PER_HOUR = 20;

function checkRateLimit(workspaceId: string): { allowed: boolean; reason?: string; stamp?: number } {
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

  // Use a unique stamp so refundRateLimit removes exactly this entry, not
  // whatever happens to be last when the refund runs (another concurrent
  // request for the same workspace may have pushed its own stamp in between).
  const stamp = now + Math.random();
  timestamps.push(stamp);
  taskTimestamps.set(workspaceId, timestamps);
  return { allowed: true, stamp };
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

function refundRateLimit(workspaceId: string, stamp: number): void {
  const timestamps = taskTimestamps.get(workspaceId);
  if (!timestamps) return;
  const index = timestamps.lastIndexOf(stamp);
  if (index >= 0) {
    timestamps.splice(index, 1);
  }
}

export function registerTaskRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    encryptionKey: string;
    previousEncryptionKey: string | null;
    zenToken: string | null;
    fallbackGoogleKey: string | null;
    fallbackGroqKey: string | null;
    outcomesEnabled: boolean;
    defaultMonthlyBudgetMicroUsd: number;
    inFlightTasks: Set<Promise<void>>;
    instanceId: string;
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

    let { template_id, model_id, prompt, metadata } = parsed.data;
    const { suggestion_id } = parsed.data;

    // suggestion_id resolves template + model + prefill from the suggestions
    // engine — the operator never picks a model manually for a one-click run.
    if (suggestion_id) {
      const suggestions = await getSuggestions(opts.pool, workspaceId);
      const suggestion = suggestions.find((s) => s.id === suggestion_id);
      if (!suggestion) {
        return reply.code(404).send({ error: `suggestion '${suggestion_id}' not found` });
      }
      template_id = suggestion.template_id;
      model_id = suggestion.model_id;
      // Operator prompt overrides the prefill; prefill is the fallback.
      if (!prompt || prompt.trim().length === 0) {
        prompt = suggestion.prefill_prompt;
      }
      metadata = { ...metadata, source: "suggestion", suggestion_id };
    }

    const template = findTemplate(template_id);
    if (!template) {
      return reply.code(404).send({ error: `template '${template_id}' not found` });
    }

    // Check if the model exists in any provider
    const modelExists = PROVIDERS.some((p) => p.models.some((m) => m.id === model_id));
    if (!modelExists) {
      return reply.code(404).send({ error: `model '${model_id}' not found` });
    }

    // Budget pre-check — paid models are rejected when the monthly budget is
    // exhausted. Free models always pass.
    const provider = findProvider(PROVIDERS.find((p) => p.models.some((m) => m.id === model_id))?.id ?? "");
    if (provider) {
      const budget = await checkBudgetForTask(
        opts.pool,
        workspaceId,
        provider.id,
        model_id,
        opts.defaultMonthlyBudgetMicroUsd,
      );
      if (!budget.allowed) {
        return reply.code(429).send({
          error: "budget_exhausted",
          spent: budget.state.spentMonthMicroUsd,
          limit: budget.state.limitMicroUsd,
        });
      }
    }

    const rateLimit = checkRateLimit(workspaceId);
    if (!rateLimit.allowed || rateLimit.stamp === undefined) {
      return reply.code(429).send({ error: rateLimit.reason });
    }
    const rateStamp = rateLimit.stamp;

    let task;
    try {
      task = await createTask(opts.pool, workspaceId, template_id, model_id, prompt, metadata, opts.instanceId);
    } catch (err) {
      // DB insert failed — refund the exact rate-limit slot so the client
      // isn't penalised. Pass the stamp to remove the right entry, not
      // whatever happens to be last (another request may have pushed since).
      refundRateLimit(workspaceId, rateStamp);
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
      previousEncryptionKey: opts.previousEncryptionKey,
      zenToken: opts.zenToken,
      fallbackGoogleKey: opts.fallbackGoogleKey,
      fallbackGroqKey: opts.fallbackGroqKey,
      outcomesEnabled: opts.outcomesEnabled,
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

    const limit = Math.max(1, Math.min(Number((request.query as { limit?: string }).limit) || 20, 100));
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
