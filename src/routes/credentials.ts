import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbPool } from "../store/db.js";
import {
  storeCredential,
  listCredentials,
  deleteCredential,
  updateCredentialStatus,
  getConnectedProviders,
} from "../store/credentials.js";
import { findProvider, providerSummaries, availableModels } from "../providers/registry.js";
import { ensureFreshToken } from "../providers/oauth/refresh.js";
import type { OAuthClientConfig } from "../config.js";
import { decrypt } from "../crypto.js";
import { extractWorkspaceId } from "../auth.js";

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
    previousEncryptionKey: string | null;
    oauthClients: Record<string, OAuthClientConfig>;
  },
) {
  // List providers (no auth — provider catalog is static)
  app.get("/providers", async (_request, reply) => {
    const summaries = providerSummaries().map((p) => ({
      ...p,
      oauthAvailable: Boolean(opts.oauthClients[p.id]),
    }));
    return reply.send({ providers: summaries });
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

  // Paste an API key and validate it. Allowed for every provider that ships a
  // validator — including OAuth providers, where a pasted key is the
  // deliberate fallback for plan-quota flows.
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
    if (!provider.validateApiKey) {
      return reply.code(400).send({ error: `${provider.name} does not support API keys — use the connect flow` });
    }

    // Validate the key
    const result = await provider.validateApiKey(api_key);
    if (!result.valid) {
      return reply.code(422).send({ error: result.error ?? "API key validation failed" });
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

  // Re-validate an existing credential. API keys run the provider's test
  // call; OAuth credentials force a token refresh, which fails loudly on a
  // revoked grant.
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
      if (!provider) {
        return reply.code(404).send({ error: "provider not found" });
      }

      try {
        if (provider.validateApiKey) {
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
        }

        if (provider.oauth) {
          await ensureFreshToken(
            opts.pool,
            workspaceId,
            provider.id,
            opts.encryptionKey,
            opts.previousEncryptionKey,
            { force: true },
          );
          await updateCredentialStatus(opts.pool, workspaceId, provider.id, "active", null);
          return reply.send({ valid: true });
        }

        return reply.code(400).send({ error: "provider does not support validation" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "validation failed";
        await updateCredentialStatus(
          opts.pool,
          workspaceId,
          request.params.provider,
          "invalid",
          message,
        );
        return reply.code(422).send({ valid: false, error: message });
      }
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
