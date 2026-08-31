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
import { createRateLimiter, startRateLimitSweeper } from "./rate-limit.js";

const createTaskSchema = z.object({
  template_id: z.string().min(1),
  model_id: z.string().min(1),
  prompt: z.string().min(1).max(8000),
  suggestion_id: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional().default({}),
  tier: z.enum(["basic", "premium"]).optional().default("basic"),
});

// Per-workspace rate limit: max 5 concurrent running tasks, max 20 per hour.
// Without this, a single client can exhaust the free Zen quota (100 req/day)
// in seconds by spamming task creation.
const taskRateLimiter = createRateLimiter({
  maxConcurrent: 5,
  maxPerWindow: 20,
  label: "tasks",
});
startRateLimitSweeper([taskRateLimiter]);

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

    const rateLimit = taskRateLimiter.check(workspaceId);
    if (!rateLimit.allowed || rateLimit.stamp === undefined) {
      return reply.code(429).send({ error: rateLimit.reason });
    }
    const rateStamp = rateLimit.stamp;

    let task;
    try {
      task = await createTask(opts.pool, workspaceId, template_id, model_id, prompt, metadata, opts.instanceId, parsed.data.tier);
    } catch (err) {
      // DB insert failed — refund the concurrent slot and the hourly stamp
      // so the client isn't penalised for a server-side failure.
      taskRateLimiter.refundSlot(workspaceId);
      taskRateLimiter.refundStamp(workspaceId, rateStamp);
      throw err;
    }

    // Fire and forget — the task runs in the background.
    // Note: the concurrent count was already incremented in checkRateLimit
    // (before any await) to close the race window.
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
      tier: parsed.data.tier,
      defaultMonthlyBudgetMicroUsd: opts.defaultMonthlyBudgetMicroUsd,
      // Non-UUID trace ids are dropped by emitOutcomes rather than failing
      // the outcome insert — see normalizeTraceId.
      traceId: typeof request.headers["x-trace-id"] === "string" ? request.headers["x-trace-id"] : null,
    }).catch((err) => {
      console.error(`Task ${task.id} crashed:`, err);
    }).finally(() => {
      taskRateLimiter.release(workspaceId);
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
