import type { DbPool } from "../../store/db.js";
import {
  getOAuthCredentialRow,
  updateOAuthTokens,
  updateCredentialStatus,
  type OAuthCredentialRow,
} from "../../store/credentials.js";
import { exchangeCopilotToken } from "./flows.js";
import { findProvider, type TokenFlavor } from "../registry.js";

/**
 * Resolves a credential row into a bearer token usable *right now*,
 * refreshing on the way if the stored one is expired or about to expire.
 *
 * Refresh policy:
 * - api_key / api_key_returned: the stored value is long-lived; return it.
 * - refresh_token: refresh when `expires_at` is missing (we cannot trust it)
 *   or within the 60s skew window.
 * - short_lived_exchange: re-derive the service token when within 5 minutes
 *   of expiry (Copilot tokens live ~30 minutes).
 *
 * On refresh failure the credential is marked invalid so the UI surfaces it;
 * the error propagates to the runner, which records the attempt and moves to
 * the next model in the fallback chain.
 */
export interface ResolvedToken {
  provider: string;
  token: string;
  flavor: TokenFlavor | "api_key";
  credential: OAuthCredentialRow;
}

const REFRESH_SKEW_MS = 60_000;
const SHORT_LIVED_SKEW_MS = 5 * 60_000;

// Per-(workspace, provider) single-flight lock. Without this, concurrent
// tasks needing the same OAuth credential all read the same refresh token,
// all call the token endpoint, and providers that rotate refresh tokens
// invalidate the first one — causing the second refresh to fail with
// invalid_grant. The lock ensures only one refresh happens at a time.
const refreshInFlight = new Map<string, Promise<ResolvedToken | null>>();

function refreshKey(workspaceId: string, providerId: string): string {
  return `${workspaceId}:${providerId}`;
}

export async function ensureFreshToken(
  pool: DbPool,
  workspaceId: string,
  providerId: string,
  encryptionKey: string,
  previousEncryptionKey: string | null,
  options: { force?: boolean } = {},
): Promise<ResolvedToken | null> {
  // Single-flight: if a refresh is already in progress for this
  // (workspace, provider), wait for it and reuse the result.
  const key = refreshKey(workspaceId, providerId);
  const existing = refreshInFlight.get(key);
  if (existing) return existing;

  const promise = doEnsureFreshToken(
    pool,
    workspaceId,
    providerId,
    encryptionKey,
    previousEncryptionKey,
    options,
  ).finally(() => {
    refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, promise);
  return promise;
}

async function doEnsureFreshToken(
  pool: DbPool,
  workspaceId: string,
  providerId: string,
  encryptionKey: string,
  previousEncryptionKey: string | null,
  options: { force?: boolean } = {},
): Promise<ResolvedToken | null> {
  const cred = await getOAuthCredentialRow(
    pool,
    workspaceId,
    providerId,
    encryptionKey,
    previousEncryptionKey,
  );
  if (!cred) return null;

  const fail = async (message: string): Promise<never> => {
    await updateCredentialStatus(pool, workspaceId, providerId, "invalid", message);
    throw new Error(`${providerId} credential unusable: ${message}`);
  };

  if (cred.flavor === "api_key" || cred.flavor === "api_key_returned") {
    if (!cred.apiKey) return fail("stored key is empty");
    return { provider: providerId, token: cred.apiKey, flavor: cred.flavor as TokenFlavor | "api_key", credential: cred };
  }

  if (cred.flavor === "short_lived_exchange") {
    if (!cred.refreshToken) return fail("no underlying user token stored");
    if (!options.force && cred.accessToken && !expiresWithin(cred.expiresAt, SHORT_LIVED_SKEW_MS)) {
      return { provider: providerId, token: cred.accessToken, flavor: cred.flavor as TokenFlavor | "api_key", credential: cred };
    }
    const refreshed = await exchangeCopilotToken(cred.refreshToken);
    if (!refreshed.accessToken) return fail("Copilot token exchange returned no token");
    await updateOAuthTokens(
      pool,
      workspaceId,
      providerId,
      {
        accessToken: refreshed.accessToken,
        expiresInSeconds: refreshed.expiresInSeconds ?? 0,
      },
      encryptionKey,
    );
    return { provider: providerId, token: refreshed.accessToken, flavor: cred.flavor, credential: cred };
  }

  // flavor === "refresh_token"
  if (!cred.refreshToken) return fail("no refresh token stored");
  if (!options.force && cred.accessToken && !expiresWithin(cred.expiresAt, REFRESH_SKEW_MS)) {
    return { provider: providerId, token: cred.accessToken, flavor: cred.flavor as TokenFlavor | "api_key", credential: cred };
  }

  const providerDef = findProvider(providerId);
  const oauth = providerDef?.oauth;
  if (!oauth) return fail("provider has no OAuth definition");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cred.refreshToken,
    client_id: oauthClientId(providerId),
  });
  const clientSecret = oauthClientSecret(providerId);
  if (clientSecret) body.set("client_secret", clientSecret);

  const res = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return fail(`refresh failed (${res.status}): ${detail.slice(0, 120)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) return fail("refresh returned no access token");

  await updateOAuthTokens(
    pool,
    workspaceId,
    providerId,
    {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresInSeconds: json.expires_in ?? 3600,
    },
    encryptionKey,
  );
  return {
    provider: providerId,
    token: json.access_token,
    flavor: cred.flavor as TokenFlavor,
    credential: cred,
  };
}

function expiresWithin(expiresAt: Date | null, skewMs: number): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - Date.now() <= skewMs;
}

// Client resolution. The runner module does not see the process env — these
// helpers are wired with the actual values at route/runner construction time
// via configureOAuthClients below.
let clients: Record<string, { clientId: string; clientSecret: string | null }> = {};

export function configureOAuthClients(configured: Record<string, { clientId: string; clientSecret: string | null }>): void {
  clients = configured;
}

export function oauthClientId(providerId: string): string {
  return clients[providerId]?.clientId ?? "";
}

export function oauthClientSecret(providerId: string): string | null {
  return clients[providerId]?.clientSecret ?? null;
}
