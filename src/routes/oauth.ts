import type { FastifyInstance } from "fastify";
import type { DbPool } from "../store/db.js";
import { storeCredential } from "../store/credentials.js";
import { extractWorkspaceId, AuthError } from "../auth.js";

interface OAuthConfig {
  googleClientId: string | null;
  googleClientSecret: string | null;
  googleRedirectUri: string | null;
}

interface OAuthState {
  workspaceId: string;
  csrf: string;
  provider: string;
}

// In-memory CSRF store (short-lived). For production with multiple instances,
// this should be in Postgres or Redis. For now, single-instance is fine.
const csrfStore = new Map<string, { workspaceId: string; provider: string; expires: number }>();

// Periodic cleanup of expired tokens — without this, the Map grows unboundedly
// if start is called but callback never arrives (user closes the tab).
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of csrfStore) {
    if (now > entry.expires) csrfStore.delete(key);
  }
}, 5 * 60 * 1000).unref();

function createCsrfToken(workspaceId: string, provider: string): string {
  const token = crypto.randomUUID();
  csrfStore.set(token, {
    workspaceId,
    provider,
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes
  });
  return token;
}

function consumeCsrfToken(token: string): OAuthState | null {
  const entry = csrfStore.get(token);
  if (!entry) return null;
  csrfStore.delete(token);
  if (Date.now() > entry.expires) return null;
  return {
    workspaceId: entry.workspaceId,
    csrf: token,
    provider: entry.provider,
  };
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    encryptionKey: string;
    oauth: OAuthConfig;
  },
) {
  // Start Google OAuth flow — returns the URL to redirect the browser to
  app.get("/oauth/google/start", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message });
    }

    if (!opts.oauth.googleClientId || !opts.oauth.googleRedirectUri) {
      return reply.code(503).send({ error: "Google OAuth is not configured" });
    }

    const csrfToken = createCsrfToken(workspaceId, "google");
    const params = new URLSearchParams({
      client_id: opts.oauth.googleClientId,
      redirect_uri: opts.oauth.googleRedirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/generative-language",
      state: csrfToken,
      access_type: "offline",
      prompt: "consent",
    });

    return reply.send({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    });
  });

  // Handle Google OAuth callback — exchanges code for tokens, stores refresh token
  app.get("/oauth/google/callback", async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      return reply.code(400).send({ error: "missing code or state parameter" });
    }

    const oauthState = consumeCsrfToken(state);
    if (!oauthState) {
      return reply.code(400).send({ error: "invalid or expired OAuth state" });
    }

    if (!opts.oauth.googleClientId || !opts.oauth.googleClientSecret || !opts.oauth.googleRedirectUri) {
      return reply.code(503).send({ error: "Google OAuth is not configured" });
    }

    // Exchange authorization code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: opts.oauth.googleClientId,
        client_secret: opts.oauth.googleClientSecret,
        redirect_uri: opts.oauth.googleRedirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return reply.code(502).send({ error: `Google token exchange failed: ${errorText}` });
    }

    const tokens = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!tokens.refresh_token) {
      return reply.code(400).send({
        error: "Google did not return a refresh token. The user may have already authorized this app. Revoke access at https://myaccount.google.com/permissions and try again.",
      });
    }

    // Store the refresh token encrypted
    await storeCredential(
      opts.pool,
      oauthState.workspaceId,
      "google",
      "Google OAuth",
      "oauth_refresh_token",
      tokens.refresh_token,
      opts.encryptionKey,
    );

    return reply.send({ success: true, provider: "google" });
  });
}

export { OAuthConfig };
