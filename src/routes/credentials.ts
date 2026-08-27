import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbPool } from "../store/db";
import {
  storeCredential,
  listCredentials,
  deleteCredential,
  updateCredentialStatus,
  getConnectedProviders,
} from "../store/credentials";
import { findProvider, providerSummaries, availableModels } from "../providers/registry";
import { decrypt } from "../crypto";
import { extractWorkspaceId } from "../auth";

const pasteKeySchema = z.object({
  provider: z.string().min(1),
  api_key: z.string().min(1),
  label: z.string().max(100).optional().default(""),
});

export function registerCredentialRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    encryptionKey: string;
  },
) {
  // List providers (no auth — provider catalog is static)
  app.get("/providers", async (_request, reply) => {
    return reply.send({ providers: providerSummaries() });
  });

  // List connected credentials for this workspace
  app.get("/credentials", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message });
    }
    const credentials = await listCredentials(opts.pool, workspaceId);
    return reply.send({ credentials });
  });

  // Paste an API key and validate it
  app.post("/credentials", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message });
    }

    const parsed = pasteKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }

    const { provider: providerId, api_key, label } = parsed.data;
    const provider = findProvider(providerId);
    if (!provider) {
      return reply.code(404).send({ error: `provider '${providerId}' not found` });
    }
    if (provider.authMethod === "none") {
      return reply.code(400).send({ error: `${provider.name} does not require an API key` });
    }
    if (provider.authMethod === "oauth") {
      return reply.code(400).send({ error: `${provider.name} requires OAuth, use the OAuth flow instead` });
    }

    // Validate the key
    if (provider.validateApiKey) {
      const result = await provider.validateApiKey(api_key);
      if (!result.valid) {
        return reply.code(422).send({ error: result.error ?? "API key validation failed" });
      }
    }

    // Store encrypted
    const credential = await storeCredential(
      opts.pool,
      workspaceId,
      providerId,
      label,
      "api_key",
      api_key,
      opts.encryptionKey,
    );

    return reply.code(201).send(credential);
  });

  // Delete a credential (revoke provider access)
  app.delete<{ Params: { provider: string } }>(
    "/credentials/:provider",
    async (request, reply) => {
      let workspaceId: string;
      try {
        workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
      } catch (err) {
        return reply.code(401).send({ error: (err as Error).message });
      }

      const deleted = await deleteCredential(opts.pool, workspaceId, request.params.provider);
      if (!deleted) {
        return reply.code(404).send({ error: "credential not found" });
      }
      return reply.code(204).send();
    },
  );

  // Re-validate an existing credential
  app.post<{ Params: { provider: string } }>(
    "/credentials/:provider/validate",
    async (request, reply) => {
      let workspaceId: string;
      try {
        workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
      } catch (err) {
        return reply.code(401).send({ error: (err as Error).message });
      }

      const provider = findProvider(request.params.provider);
      if (!provider || !provider.validateApiKey) {
        return reply.code(400).send({ error: "provider does not support validation" });
      }

      // Load the encrypted key, decrypt, validate
      const { rows } = await opts.pool.query(
        `SELECT encrypted_value FROM agent_service_credentials
         WHERE workspace_id = $1 AND provider = $2`,
        [workspaceId, request.params.provider],
      );
      if (!rows[0]) {
        return reply.code(404).send({ error: "credential not found" });
      }

      const apiKey = decrypt(rows[0].encrypted_value as string, opts.encryptionKey);
      const result = await provider.validateApiKey(apiKey);

      await updateCredentialStatus(
        opts.pool,
        workspaceId,
        request.params.provider,
        result.valid ? "active" : "invalid",
        result.error ?? null,
      );

      return reply.send(result);
    },
  );

  // List available models for this workspace (free + connected)
  app.get("/models", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message });
    }

    const connected = await getConnectedProviders(opts.pool, workspaceId);
    const models = availableModels(connected);
    return reply.send({ models, connectedProviders: connected });
  });
}
