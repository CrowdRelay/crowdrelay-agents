import type { FastifyInstance } from "fastify";
import { templateSummaries, findTemplate } from "../templates/catalog.js";

export function registerTemplateRoutes(app: FastifyInstance, opts: { authKey: string }) {
  app.get("/templates", async (request, reply) => {
    return reply.send({ templates: templateSummaries() });
  });

  app.get<{ Params: { id: string } }>(
    "/templates/:id",
    async (request, reply) => {
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
