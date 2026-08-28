import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DbPool } from "../store/db.js";
import { storeOAuthTokens } from "../store/credentials.js";
import {
  extractWorkspaceId,
} from "../auth.js";
import { findProvider } from "../providers/registry.js";
import {
  buildAuthorizeUrl,
  createCodeVerifier,
  exchangeCode,
  exchangeCopilotToken,
  fetchAccountLabel,
  pollDeviceFlow,
  startDeviceFlow,
  OAuthFlowError,
} from "../providers/oauth/flows.js";
import {
  configureOAuthClients,
  oauthClientId,
  oauthClientSecret,
} from "../providers/oauth/refresh.js";
import type { OAuthClientConfig } from "../config.js";

const startQuerySchema = z.object({
  redirect_uri: z.string().url().optional(),
  return_to: z.string().max(500).optional(),
});

interface OAuthStateRow {
  state: string;
  workspace_id: string;
  provider: string;
  code_verifier: string | null;
  redirect_uri: string | null;
  device_code: string | null;
  expires_at: Date;
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    encryptionKey: string;
    oauthClients: Record<string, OAuthClientConfig>;
  },
): { cleanup: () => void } {
  configureOAuthClients(opts.oauthClients);

  const STATE_TTL_MS = 10 * 60 * 1000;
  const DEVICE_STATE_TTL_MS = 15 * 60 * 1000;

  async function createStateRow(
    workspaceId: string,
    provider: string,
    fields: { codeVerifier?: string; redirectUri?: string; deviceCode?: string; ttlMs?: number },
  ): Promise<string> {
    const state = crypto.randomUUID();
    await opts.pool.query(
      `INSERT INTO agent_service_oauth_states
        (state, workspace_id, provider, code_verifier, redirect_uri, device_code, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        state,
        workspaceId,
        provider,
        fields.codeVerifier ?? null,
        fields.redirectUri ?? null,
        fields.deviceCode ?? null,
        new Date(Date.now() + (fields.ttlMs ?? STATE_TTL_MS)),
      ],
    );
    return state;
  }

  async function takeStateRow(state: string): Promise<OAuthStateRow | null> {
    // Single-use: delete on read. The row itself is the callback capability.
    const { rows } = await opts.pool.query(
      `DELETE FROM agent_service_oauth_states
       WHERE state = $1
       RETURNING state, workspace_id, provider, code_verifier, redirect_uri, device_code, expires_at`,
      [state],
    );
    const row = rows[0] as OAuthStateRow | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return row;
  }

  function providerConfigError(providerId: string): string | null {
    const provider = findProvider(providerId);
    if (!provider) return `provider '${providerId}' not found`;
    if (!provider.oauth) return `${provider.name} does not support OAuth`;
    if (!oauthClientId(providerId)) {
      return `${provider.name} OAuth is not configured on this deployment`;
    }
    return null;
  }

  // --- Start a flow ---
  app.get<{ Params: { provider: string }; Querystring: Record<string, unknown> }>(
    "/oauth/:provider/start",
    async (request, reply) => {
      let workspaceId: string;
      try {
        workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
      } catch (err) {
        return reply.code(401).send({ error: (err as Error).message });
      }

      const providerId = request.params.provider;
      const configError = providerConfigError(providerId);
      if (configError) {
        return reply.code(configError.includes("not found") ? 404 : 503).send({ error: configError });
      }
      const provider = findProvider(providerId)!;
      const oauth = provider.oauth!;

      const parsed = startQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
      }

      try {
        if (oauth.kind === "device_code") {
          const started = await startDeviceFlow({ oauth, clientId: oauthClientId(providerId) });
          const state = await createStateRow(workspaceId, providerId, {
            deviceCode: started.deviceCode,
            ttlMs: DEVICE_STATE_TTL_MS,
          });
          return reply.send({
            mode: "device",
            state,
            user_code: started.userCode,
            verification_uri: started.verificationUri,
            interval_seconds: started.intervalSeconds,
            expires_in: started.expiresInSeconds,
          });
        }

        const redirectUri = parsed.data.redirect_uri;
        if (!redirectUri) {
          return reply.code(400).send({
            error: "redirect_uri query parameter is required (the control plane's public callback URL)",
          });
        }
        const codeVerifier = oauth.kind === "authorization_code_pkce" ? createCodeVerifier() : null;
        const state = await createStateRow(workspaceId, providerId, {
          codeVerifier: codeVerifier ?? undefined,
          redirectUri,
        });
        const url = buildAuthorizeUrl({
          oauth,
          clientId: oauthClientId(providerId),
          redirectUri,
          state,
          codeVerifier: codeVerifier ?? "",
        });
        return reply.send({ mode: "redirect", url, state });
      } catch (err) {
        if (err instanceof OAuthFlowError) {
          return reply.code(502).send({ error: err.message, detail: err.detail });
        }
        throw err;
      }
    },
  );

  // --- Callback (authorization-code flows) ---
  // Auth note: the unguessable single-use state row is the capability here —
  // the same pattern the control plane's CSRF design implies. The control
  // plane proxy adds its derived token, but the flow must not depend on it.
  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/:provider/callback",
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error) {
        return reply.code(400).send({ error: `provider returned: ${error}` });
      }
      if (!code || !state) {
        return reply.code(400).send({ error: "missing code or state parameter" });
      }

      const row = await takeStateRow(state);
      if (!row) {
        return reply.code(400).send({ error: "invalid or expired OAuth state" });
      }
      const configError = providerConfigError(row.provider);
      if (configError) {
        return reply.code(503).send({ error: configError });
      }
      const provider = findProvider(row.provider)!;
      const oauth = provider.oauth!;
      if (!row.redirect_uri) {
        return reply.code(400).send({ error: "state row has no redirect_uri" });
      }

      try {
        const tokens = await exchangeCode({
          providerId: row.provider,
          oauth,
          clientId: oauthClientId(row.provider),
          clientSecret: oauthClientSecret(row.provider),
          code,
          redirectUri: row.redirect_uri,
          codeVerifier: row.code_verifier ?? "",
        });
        // Validate that the provider granted all required scopes. If the user
        // consented to fewer scopes, the credential is broken — reject early
        // instead of storing a connection that will fail on every call.
        if (oauth.scopes.length > 0 && tokens.scope) {
          const granted = new Set(tokens.scope.split(/\s+/).filter(Boolean));
          const missing = oauth.scopes.filter((s) => !granted.has(s));
          if (missing.length > 0) {
            return reply.code(422).send({
              error: `OAuth token is missing required scopes: ${missing.join(", ")}`,
            });
          }
        }
        tokens.account =
          tokens.account ?? (tokens.accessToken ? await fetchAccountLabel(row.provider, tokens.accessToken) : undefined);
        await storeOAuthTokens(opts.pool, row.workspace_id, row.provider, tokens, opts.encryptionKey);
        return reply.send({ success: true, provider: row.provider, return_to: null });
      } catch (err) {
        if (err instanceof OAuthFlowError) {
          return reply.code(502).send({ error: err.message, detail: err.detail });
        }
        throw err;
      }
    },
  );

  // --- Device-flow poll (frontend calls this every interval_seconds) ---
  app.get<{ Params: { provider: string }; Querystring: { state?: string } }>(
    "/oauth/:provider/poll",
    async (request, reply) => {
      let workspaceId: string;
      try {
        workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
      } catch (err) {
        return reply.code(401).send({ error: (err as Error).message });
      }
      const { state } = request.query;
      if (!state) return reply.code(400).send({ error: "missing state parameter" });

      const { rows } = await opts.pool.query(
        `SELECT workspace_id, provider, device_code, expires_at
         FROM agent_service_oauth_states WHERE state = $1`,
        [state],
      );
      const row = rows[0] as
        | { workspace_id: string; provider: string; device_code: string | null; expires_at: Date }
        | undefined;
      if (!row || row.workspace_id !== workspaceId) {
        return reply.code(400).send({ error: "invalid OAuth state" });
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await opts.pool.query(`DELETE FROM agent_service_oauth_states WHERE state = $1`, [state]);
        return reply.code(410).send({ error: "device flow expired, start again" });
      }
      if (!row.device_code) return reply.code(400).send({ error: "state is not a device flow" });

      const configError = providerConfigError(row.provider);
      if (configError) return reply.code(503).send({ error: configError });

      try {
        const tokens = await pollDeviceFlow({
          oauth: findProvider(row.provider)!.oauth!,
          clientId: oauthClientId(row.provider),
          deviceCode: row.device_code,
        });
        if (!tokens) {
          return reply.send({ status: "pending" });
        }
        const account = tokens.accessToken
          ? await fetchAccountLabel(row.provider, tokens.accessToken)
          : undefined;
        // Copilot's GHU from the device flow is not itself an inference
        // token — exchange it for the short-lived Copilot API token now and
        // store the GHU as the refresh side.
        const finalTokens =
          row.provider === "github-copilot" && tokens.accessToken
            ? { ...(await exchangeCopilotToken(tokens.accessToken)), account }
            : { ...tokens, account };
        await storeOAuthTokens(
          opts.pool,
          row.workspace_id,
          row.provider,
          finalTokens,
          opts.encryptionKey,
        );
        await opts.pool.query(`DELETE FROM agent_service_oauth_states WHERE state = $1`, [state]);
        return reply.send({ status: "complete", provider: row.provider });
      } catch (err) {
        if (err instanceof OAuthFlowError) {
          return reply.code(502).send({ error: err.message, detail: err.detail });
        }
        throw err;
      }
    },
  );

  // Periodic cleanup of expired state rows (same hygiene as the old in-memory
  // map, but now the store is durable and multi-instance safe).
  const cleanupTimer = setInterval(() => {
    void opts.pool
      .query(`DELETE FROM agent_service_oauth_states WHERE expires_at < now()`)
      .catch((err) => console.error("oauth state cleanup failed:", err));
  }, 5 * 60 * 1000);
  cleanupTimer.unref();

  return { cleanup: () => clearInterval(cleanupTimer) };
}