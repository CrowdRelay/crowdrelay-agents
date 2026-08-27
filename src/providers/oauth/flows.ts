import { createHash, randomBytes } from "node:crypto";
import type { OAuthDef, TokenFlavor } from "../registry.js";

/**
 * Normalized result of any provider's token exchange. Which fields are
 * present follows `flavor`:
 * - refresh_token:         accessToken + refreshToken (+ expiresInSeconds)
 * - api_key_returned:      apiKey (no expiry)
 * - short_lived_exchange:  refreshToken = long-lived user token (GHU),
 *                          accessToken = short-lived service token
 */
export interface ExchangedTokens {
  flavor: TokenFlavor;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresInSeconds?: number;
  scope?: string;
  /** Provider account label (login/email) for the UI, when cheaply available. */
  account?: string;
}

export class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

// --- PKCE helpers ---

export function createCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function createCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// --- Authorization URL builders ---

export function buildAuthorizeUrl(params: {
  oauth: OAuthDef;
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}): string {
  const { oauth, clientId, redirectUri, state, codeVerifier } = params;
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauth.scopes.join(" "),
    state,
    ...(oauth.kind === "authorization_code_pkce"
      ? {
          code_challenge: createCodeChallenge(codeVerifier),
          code_challenge_method: "S256",
        }
      : {}),
    ...oauth.extraAuthorizeParams,
  });
  const separator = oauth.authorizeUrl.includes("?") ? "&" : "?";
  return `${oauth.authorizeUrl}${separator}${query.toString()}`;
}

// --- Token exchanges ---

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postForm(url: string, body: URLSearchParams, headers?: Record<string, string>): Promise<TokenEndpointResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: TokenEndpointResponse;
  try {
    json = JSON.parse(text) as TokenEndpointResponse;
  } catch {
    throw new OAuthFlowError(`token endpoint returned non-JSON response (${res.status})`, url);
  }
  if (!res.ok || json.error) {
    throw new OAuthFlowError(
      `token exchange failed (${res.status})`,
      url,
      json.error_description ?? json.error ?? text.slice(0, 200),
    );
  }
  return json;
}

/** Standard OAuth2 authorization-code exchange (with or without PKCE). */
export async function exchangeAuthorizationCode(params: {
  oauth: OAuthDef;
  clientId: string;
  clientSecret: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ExchangedTokens> {
  const { oauth, clientId, clientSecret, code, redirectUri, codeVerifier } = params;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    ...(oauth.kind === "authorization_code_pkce" ? { code_verifier: codeVerifier } : {}),
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  });
  const json = await postForm(oauth.tokenUrl, body);
  if (!json.access_token && oauth.tokenFlavor !== "api_key_returned") {
    throw new OAuthFlowError("token exchange returned no access_token", oauth.tokenUrl);
  }
  return {
    flavor: "refresh_token",
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSeconds: json.expires_in,
    scope: json.scope,
  };
}

/**
 * OpenRouter's OAuth exchange is not an OAuth token endpoint: it takes the
 * authorization code plus the PKCE verifier and returns a long-lived API key.
 */
export async function exchangeOpenRouterCode(params: {
  code: string;
  codeVerifier: string;
}): Promise<ExchangedTokens> {
  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: params.code, code_verifier: params.codeVerifier }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OAuthFlowError(`OpenRouter key exchange failed (${res.status})`, "openrouter", text.slice(0, 200));
  }
  let json: { key?: string };
  try {
    json = JSON.parse(text) as { key?: string };
  } catch {
    throw new OAuthFlowError("OpenRouter key exchange returned non-JSON response", "openrouter");
  }
  if (!json.key) {
    throw new OAuthFlowError("OpenRouter key exchange returned no key", "openrouter");
  }
  return { flavor: "api_key_returned", apiKey: json.key };
}

/** Provider-specific exchange dispatch. Call after the callback arrives. */
export async function exchangeCode(params: {
  providerId: string;
  oauth: OAuthDef;
  clientId: string;
  clientSecret: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ExchangedTokens> {
  const { providerId, oauth } = params;
  if (providerId === "openrouter") {
    return exchangeOpenRouterCode({ code: params.code, codeVerifier: params.codeVerifier });
  }
  return exchangeAuthorizationCode({
    oauth,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    code: params.code,
    redirectUri: params.redirectUri,
    codeVerifier: params.codeVerifier,
  });
}

// --- Device flow (GitHub Copilot) ---

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export async function startDeviceFlow(params: {
  oauth: OAuthDef;
  clientId: string;
}): Promise<DeviceFlowStart> {
  const res = await fetch(params.oauth.authorizeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: params.clientId,
      scope: params.oauth.scopes.join(" "),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new OAuthFlowError(`device flow start returned non-JSON response (${res.status})`, "github-copilot");
  }
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new OAuthFlowError(
      "device flow start failed",
      "github-copilot",
      json.error_description ?? json.error ?? text.slice(0, 200),
    );
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    expiresInSeconds: json.expires_in ?? 900,
    intervalSeconds: json.interval ?? 5,
  };
}

/**
 * One poll of the device-flow token endpoint. Returns the exchanged tokens
 * when the user has finished, or `null` while they have not.
 */
export async function pollDeviceFlow(params: {
  oauth: OAuthDef;
  clientId: string;
  deviceCode: string;
}): Promise<ExchangedTokens | null> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: params.clientId,
    device_code: params.deviceCode,
  });
  const res = await fetch(params.oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  let json: TokenEndpointResponse;
  try {
    json = (await res.json()) as TokenEndpointResponse;
  } catch {
    throw new OAuthFlowError("device flow poll returned non-JSON response", "github-copilot");
  }
  if (json.error === "authorization_pending" || json.error === "slow_down") {
    return null;
  }
  if (!res.ok || json.error || !json.access_token) {
    throw new OAuthFlowError(
      "device flow poll failed",
      "github-copilot",
      json.error_description ?? json.error,
    );
  }
  return { flavor: "refresh_token", accessToken: json.access_token, scope: json.scope };
}

/**
 * Exchanges a GitHub user access token for a short-lived Copilot API token.
 * The GHU stays the stored refresh token; Copilot tokens live ~30 minutes.
 */
export async function exchangeCopilotToken(ghuToken: string): Promise<ExchangedTokens> {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${ghuToken}`,
      "User-Agent": "crowdrelay-agents",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OAuthFlowError(`Copilot token exchange failed (${res.status})`, "github-copilot", text.slice(0, 200));
  }
  let json: { token?: string; expires_at?: number };
  try {
    json = JSON.parse(text) as { token?: string; expires_at?: number };
  } catch {
    throw new OAuthFlowError("Copilot token exchange returned non-JSON response", "github-copilot");
  }
  if (!json.token || !json.expires_at) {
    throw new OAuthFlowError("Copilot token exchange returned no token", "github-copilot");
  }
  return {
    flavor: "short_lived_exchange",
    accessToken: json.token,
    refreshToken: ghuToken,
    expiresInSeconds: Math.max(0, json.expires_at - Math.floor(Date.now() / 1000)),
  };
}

/** Best-effort account label for the UI. Never blocks the flow. */
export async function fetchAccountLabel(providerId: string, token: string): Promise<string | undefined> {
  try {
    if (providerId === "github-copilot") {
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "crowdrelay-agents",
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { login?: string };
      return json.login ? `github:${json.login}` : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
