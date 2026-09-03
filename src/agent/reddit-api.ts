/**
 * Reddit through the official OAuth API.
 *
 * Everything Reddit-shaped in this service went through a headless Chromium
 * logged into reddit.com. That path is structurally fragile from a server:
 * Reddit fingerprints datacenter IPs, shows them challenges, and blocks their
 * unauthenticated JSON outright. Production proved it — the credential sat
 * `invalid` for a month behind "the password was rejected or a challenge is
 * being shown", and every subreddit observation, post and join was dead
 * behind it.
 *
 * The measurement that settles the design, taken from the production host:
 *
 *     POST https://www.reddit.com/api/v1/access_token   401
 *     GET  https://oauth.reddit.com/r/Metal/about       403   (no bearer)
 *     GET  https://www.reddit.com/r/Metal/about.json    403   (IP blocked)
 *     GET  https://old.reddit.com/r/Metal/about.json    403   (IP blocked)
 *
 * A 401 from the token endpoint is the interesting one: it means "you sent no
 * valid credentials", not "we do not serve your IP". Public JSON is blocked
 * from this host and the OAuth API is not. So the API is the route that works,
 * and it works without a browser, without a proxy, and without anything that
 * can be shown a CAPTCHA.
 *
 * This module is the token half. It holds a script-app credential, exchanges
 * it for a bearer token, keeps that token until shortly before it expires, and
 * hands out authenticated fetches against `oauth.reddit.com`.
 *
 * # What an operator has to do once
 *
 * Create a **script** app at https://www.reddit.com/prefs/apps under the
 * account that will post, then store the pair as the `reddit-api` credential.
 * The account username and password are the ones already stored for
 * `reddit-browser`; a script app's password grant needs both halves.
 *
 * Nothing here reads or logs a secret value.
 */

import type { DbPool } from "../store/db.js";
import { decryptWithRotation, encrypt } from "../crypto.js";
import { getRedditCredentials } from "./reddit-browser.js";

const CREDENTIALS_PROVIDER = "reddit-api";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_ORIGIN = "https://oauth.reddit.com";

/**
 * Reddit asks that the User-Agent identify the platform, app and author. A
 * generic browser string is what gets script traffic rate-limited hardest,
 * so this says what it actually is.
 */
const USER_AGENT = "server:crowdrelay-agents:1.0 (by /u/crowdrelay)";

/**
 * How early a token is treated as expired.
 *
 * Reddit issues one-hour tokens. Renewing a minute early costs one extra
 * token request an hour and removes the class of failure where a request is
 * authorized when it is sent and expired when it arrives.
 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Error carrying the status the route should answer with. */
export class RedditApiError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "RedditApiError";
    this.statusCode = statusCode;
  }
}

export interface RedditApiCredentials {
  client_id: string;
  client_secret: string;
}

/** Stores the script-app client id and secret, encrypted. */
export async function storeRedditApiCredentials(
  pool: DbPool,
  workspaceId: string,
  credentials: RedditApiCredentials,
  encryptionKey: string,
): Promise<void> {
  const encrypted = encrypt(JSON.stringify(credentials), encryptionKey);
  await pool.query(
    `INSERT INTO agent_service_credentials
      (workspace_id, provider, label, credential_type, encrypted_value, status, last_validated_at)
     VALUES ($1, $2, 'Reddit script app', 'api_key', $3, 'active', now())
     ON CONFLICT (workspace_id, provider) DO UPDATE SET
       label = 'Reddit script app',
       credential_type = 'api_key',
       encrypted_value = $3,
       status = 'active',
       last_validated_at = now(),
       last_validation_error = NULL`,
    [workspaceId, CREDENTIALS_PROVIDER, encrypted],
  );
}

async function getRedditApiCredentials(
  pool: DbPool,
  workspaceId: string,
  encryptionKey: string,
  previousEncryptionKey: string | null,
): Promise<RedditApiCredentials | null> {
  const { rows } = await pool.query(
    `SELECT encrypted_value FROM agent_service_credentials
     WHERE workspace_id = $1 AND provider = $2 AND status = 'active'`,
    [workspaceId, CREDENTIALS_PROVIDER],
  );
  const raw = rows[0]?.encrypted_value;
  if (typeof raw !== "string") return null;
  try {
    const { value } = decryptWithRotation(raw, encryptionKey, previousEncryptionKey);
    const parsed = JSON.parse(value) as Partial<RedditApiCredentials>;
    if (!parsed.client_id || !parsed.client_secret) return null;
    return { client_id: parsed.client_id, client_secret: parsed.client_secret };
  } catch {
    return null;
  }
}

async function markApiCredentialsFailed(
  pool: DbPool,
  workspaceId: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE agent_service_credentials
     SET status = 'invalid', last_validation_error = $3, last_validated_at = now()
     WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, CREDENTIALS_PROVIDER, reason.slice(0, 500)],
  );
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Holds bearer tokens per workspace and performs authenticated calls.
 *
 * One instance per process. Tokens are kept in memory only: they last an hour,
 * a restart costs one token request, and writing them to the database would
 * put a live credential in a second place for no gain.
 */
export class RedditApiClient {
  private readonly tokens = new Map<string, CachedToken>();

  constructor(
    private readonly pool: DbPool,
    private readonly encryptionKey: string,
    private readonly previousEncryptionKey: string | null,
  ) {}

  /** Whether this workspace has a usable script-app credential. */
  async isConfigured(workspaceId: string): Promise<boolean> {
    const api = await getRedditApiCredentials(
      this.pool,
      workspaceId,
      this.encryptionKey,
      this.previousEncryptionKey,
    );
    return api !== null;
  }

  /**
   * Returns a bearer token, fetching one when the cached token is missing or
   * about to expire.
   *
   * The password grant needs four things: the script app's id and secret, and
   * the account's username and password. The account half is the credential
   * already stored for the browser path, so configuring the API does not mean
   * entering the password a second time.
   */
  private async bearerToken(workspaceId: string): Promise<string> {
    const cached = this.tokens.get(workspaceId);
    if (cached && cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return cached.token;
    }

    const api = await getRedditApiCredentials(
      this.pool,
      workspaceId,
      this.encryptionKey,
      this.previousEncryptionKey,
    );
    if (!api) {
      throw new RedditApiError(
        "no reddit script-app credential stored — create a script app at " +
          "https://www.reddit.com/prefs/apps and POST /reddit/api-credentials",
        503,
      );
    }
    const account = await getRedditCredentials(
      this.pool,
      workspaceId,
      this.encryptionKey,
      this.previousEncryptionKey,
    );
    if (!account?.reddit_username || !account.reddit_password) {
      throw new RedditApiError(
        "the script-app password grant needs the reddit account username and " +
          "password — POST /reddit/credentials first",
        503,
      );
    }

    const body = new URLSearchParams({
      grant_type: "password",
      username: account.reddit_username,
      password: account.reddit_password,
    });
    const basic = Buffer.from(`${api.client_id}:${api.client_secret}`).toString("base64");
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
    });

    if (!response.ok) {
      // 401 here means the app credentials or the account password are wrong,
      // and no amount of retrying fixes either. Anything else — a 429, a 5xx —
      // is Reddit having a moment and must not latch the credential off.
      const detail = `reddit token request failed: HTTP ${response.status}`;
      if (response.status === 401) {
        await markApiCredentialsFailed(this.pool, workspaceId, detail);
        throw new RedditApiError(
          `${detail} — the script app id/secret or the account password is wrong`,
          503,
        );
      }
      throw new RedditApiError(detail, 502);
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!payload.access_token) {
      throw new RedditApiError(
        `reddit token response carried no access_token${payload.error ? `: ${payload.error}` : ""}`,
        502,
      );
    }
    const lifetimeMs = (payload.expires_in ?? 3_600) * 1_000;
    this.tokens.set(workspaceId, {
      token: payload.access_token,
      expiresAtMs: Date.now() + lifetimeMs,
    });
    return payload.access_token;
  }

  /**
   * Performs one authenticated API call.
   *
   * A 401 mid-session means the token was revoked rather than expired, so the
   * cached token is dropped and the call retried once with a fresh one. A
   * second 401 is a real failure and is reported.
   */
  private async call(
    workspaceId: string,
    path: string,
    init?: { method?: string; form?: Record<string, string> },
  ): Promise<unknown> {
    const perform = async (token: string): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      };
      let body: string | undefined;
      if (init?.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(init.form).toString();
      }
      return fetch(`${API_ORIGIN}${path}`, {
        method: init?.method ?? "GET",
        headers,
        body,
      });
    };

    let response = await perform(await this.bearerToken(workspaceId));
    if (response.status === 401) {
      this.tokens.delete(workspaceId);
      response = await perform(await this.bearerToken(workspaceId));
    }
    if (response.status === 429) {
      throw new RedditApiError("reddit rate limit reached — retry later", 429);
    }
    if (!response.ok) {
      throw new RedditApiError(`reddit api ${path} failed: HTTP ${response.status}`, 502);
    }
    return response.json();
  }

  /** `GET /r/{subreddit}/about` — community size and description. */
  async subredditAbout(workspaceId: string, subreddit: string): Promise<Record<string, unknown>> {
    const payload = (await this.call(workspaceId, `/r/${subreddit}/about`)) as {
      data?: Record<string, unknown>;
    } | null;
    return payload?.data ?? {};
  }

  /** `GET /r/{subreddit}/hot` — a sample of what the community is reading. */
  async subredditHot(
    workspaceId: string,
    subreddit: string,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const payload = (await this.call(
      workspaceId,
      `/r/${subreddit}/hot?limit=${limit}&raw_json=1`,
    )) as { data?: { children?: Array<{ data?: Record<string, unknown> }> } } | null;
    return (payload?.data?.children ?? []).map((child) => child.data ?? {});
  }

  /**
   * `POST /api/submit` — a self (text) post.
   *
   * Reddit answers 200 with an errors array rather than an HTTP error for
   * things it refuses: a subreddit that bans links, a rate limit on the
   * account, a rule the post breaks. Those have to be read out of the body or
   * a refused post is recorded as a successful one.
   */
  async submitSelfPost(
    workspaceId: string,
    subreddit: string,
    title: string,
    body: string,
  ): Promise<{ id: string | null; url: string | null }> {
    const payload = (await this.call(workspaceId, "/api/submit", {
      method: "POST",
      form: {
        sr: subreddit,
        kind: "self",
        title,
        text: body,
        api_type: "json",
        resubmit: "true",
        sendreplies: "true",
      },
    })) as {
      json?: {
        errors?: Array<[string, string, string?]>;
        data?: { id?: string; url?: string; name?: string };
      };
    };

    const errors = payload.json?.errors ?? [];
    if (errors.length > 0) {
      const [code, explanation] = errors[0] ?? [];
      throw new RedditApiError(
        `reddit refused the post${code ? ` (${code})` : ""}${explanation ? `: ${explanation}` : ""}`,
        422,
      );
    }
    const data = payload.json?.data ?? {};
    return {
      id: typeof data.id === "string" ? data.id : null,
      url: typeof data.url === "string" ? data.url : null,
    };
  }

  /** `POST /api/subscribe` — join a community. */
  async joinSubreddit(workspaceId: string, subreddit: string): Promise<void> {
    await this.call(workspaceId, "/api/subscribe", {
      method: "POST",
      form: { action: "sub", sr_name: subreddit, api_type: "json" },
    });
  }

  /** `GET /api/info` — current score and comment count for one post. */
  async postMetrics(
    workspaceId: string,
    postId: string,
  ): Promise<Record<string, unknown> | null> {
    const fullname = postId.startsWith("t3_") ? postId : `t3_${postId}`;
    const payload = (await this.call(
      workspaceId,
      `/api/info?id=${encodeURIComponent(fullname)}&raw_json=1`,
    )) as { data?: { children?: Array<{ data?: Record<string, unknown> }> } } | null;
    return payload?.data?.children?.[0]?.data ?? null;
  }
}

let sharedClient: RedditApiClient | null = null;

/** The process-wide client, so one token serves every request. */
export function getRedditApiClient(
  pool: DbPool,
  encryptionKey: string,
  previousEncryptionKey: string | null,
): RedditApiClient {
  if (!sharedClient) {
    sharedClient = new RedditApiClient(pool, encryptionKey, previousEncryptionKey);
  }
  return sharedClient;
}
