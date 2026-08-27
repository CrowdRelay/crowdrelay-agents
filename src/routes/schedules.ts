import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbPool } from "../store/db.js";
import { extractWorkspaceId } from "../auth.js";
import {
  listSchedules,
  createSchedule,
  deleteSchedule,
  setScheduleEnabled,
} from "../agent/schedules.js";

const createScheduleSchema = z.object({
  template_id: z.string().min(1),
  model_id: z.string().min(1),
  instruction: z.string().max(8000).optional().default(""),
  interval_minutes: z.number().int().min(60).max(20160),
});

export function registerScheduleRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
  },
) {
  app.get("/schedules", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }
    const schedules = await listSchedules(opts.pool, workspaceId);
    return reply.send({ schedules });
  });

  app.post("/schedules", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }
    const parsed = createScheduleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }
    const result = await createSchedule(opts.pool, workspaceId, parsed.data);
    if ("error" in result) {
      return reply.code(404).send({ error: result.error });
    }
    return reply.code(201).send(result);
  });

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }
    const deleted = await deleteSchedule(opts.pool, workspaceId, request.params.id);
    if (!deleted) return reply.code(404).send({ error: "schedule not found" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/schedules/:id/enable", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }
    const ok = await setScheduleEnabled(opts.pool, workspaceId, request.params.id, true);
    if (!ok) return reply.code(404).send({ error: "schedule not found" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/schedules/:id/disable", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }
    const ok = await setScheduleEnabled(opts.pool, workspaceId, request.params.id, false);
    if (!ok) return reply.code(404).send({ error: "schedule not found" });
    return reply.code(204).send();
  });
}
