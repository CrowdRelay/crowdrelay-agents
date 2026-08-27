import type { FastifyInstance } from "fastify";
import { templateSummaries, findTemplate } from "../templates/catalog.js";
import { extractWorkspaceId } from "../auth.js";

export function registerTemplateRoutes(app: FastifyInstance, opts: { authKey: string }) {
  app.get("/templates", async (request, reply) => {
    try {
      extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }
    return reply.send({ templates: templateSummaries() });
  });

  app.get<{ Params: { id: string } }>(
    "/templates/:id",
    async (request, reply) => {
      try {
        extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
        return reply.code(statusCode).send({ error: (err as Error).message });
      }
      const template = findTemplate(request.params.id);
      if (!template) {
        return reply.code(404).send({ error: "template not found" });
      }
      return reply.send({
        id: template.id,
        name: template.name,
        description: template.description,
        category: template.category,
        recommendedModels: template.recommendedModels,
        dataScope: template.dataScope,
        outputFormat: template.outputFormat,
      });
    },
  );
}
