/**
 * Reddit authenticated scraper — cookie storage and status.
 *
 * Reddit blocks unauthenticated JSON API access with a JavaScript
 * bot-detection challenge. The browser-as-API path (reddit-browser.ts) keeps
 * a persistent logged-in Chromium and handles all Reddit work. This module
 * stores and reports the session cookies that the Rust worker fetches via
 * the `/reddit/cookies` endpoint for authenticated reqwest calls.
 *
 * Cookie lifecycle:
 * - Obtained via the persistent browser session (reddit-browser.ts)
 * - Stored encrypted in Postgres with a 7-day expiry
 * - Status flips to 'expired' when the TTL elapses
 */

import { type Cookie } from "playwright";
import type { DbPool } from "../store/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RedditCookieRow {
  workspace_id: string;
  cookies: Cookie[];
  reddit_username: string | null;
  obtained_at: Date;
  expires_at: Date;
  status: "active" | "expired" | "failed";
}

export interface RedditCookieResponse {
  cookies: Cookie[];
  expires_at: string;
  status: "active" | "expired" | "failed";
  reddit_username: string | null;
}

// ---------------------------------------------------------------------------
// Cookie storage
// ---------------------------------------------------------------------------

const COOKIE_TTL_HOURS = 7 * 24; // 7 days — Reddit session cookie lifetime

async function storeCookies(
  pool: DbPool,
  workspaceId: string,
  cookies: Cookie[],
  redditUsername: string | null,
): Promise<void> {
  const expiresAt = new Date(Date.now() + COOKIE_TTL_HOURS * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO agent_service_reddit_cookies
      (workspace_id, cookies, reddit_username, obtained_at, expires_at, status)
     VALUES ($1, $2, $3, now(), $4, 'active')
     ON CONFLICT (workspace_id) DO UPDATE SET
       cookies = EXCLUDED.cookies,
       reddit_username = EXCLUDED.reddit_username,
       obtained_at = now(),
       expires_at = EXCLUDED.expires_at,
       status = 'active'`,
    [workspaceId, JSON.stringify(cookies), redditUsername, expiresAt],
  );
}

async function getStoredCookies(
  pool: DbPool,
  workspaceId: string,
): Promise<RedditCookieRow | null> {
  const { rows } = await pool.query<RedditCookieRow>(
    `SELECT workspace_id, cookies, reddit_username, obtained_at, expires_at, status
     FROM agent_service_reddit_cookies
     WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

async function markCookiesExpired(pool: DbPool, workspaceId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_service_reddit_cookies SET status = 'expired' WHERE workspace_id = $1`,
    [workspaceId],
  );
}

async function markCookiesFailed(pool: DbPool, workspaceId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_service_reddit_cookies SET status = 'failed' WHERE workspace_id = $1`,
    [workspaceId],
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current Reddit cookies for a workspace. If cookies are expired,
 * returns them with status 'expired' — the caller can trigger a refresh.
 * If no cookies exist, returns null.
 */
export async function getRedditCookies(
  pool: DbPool,
  workspaceId: string,
): Promise<RedditCookieResponse | null> {
  const row = await getStoredCookies(pool, workspaceId);
  if (!row) return null;

  const now = new Date();
  const isExpired = row.expires_at < now || row.status === "expired";

  // Auto-mark expired in the DB if the row is stale
  if (isExpired && row.status === "active") {
    await markCookiesExpired(pool, workspaceId);
  }

  return {
    cookies: row.cookies,
    expires_at: row.expires_at.toISOString(),
    status: isExpired ? "expired" : row.status,
    reddit_username: row.reddit_username,
  };
}

/**
 * Returns the cookie status without returning the cookies themselves.
 * Used by the /reddit/status endpoint for quick health checks.
 */
export async function getRedditCookieStatus(
  pool: DbPool,
  workspaceId: string,
): Promise<{ status: "active" | "expired" | "failed" | "missing"; expires_at: string | null; reddit_username: string | null }> {
  const row = await getStoredCookies(pool, workspaceId);
  if (!row) {
    return { status: "missing", expires_at: null, reddit_username: null };
  }

  const now = new Date();
  const isExpired = row.expires_at < now || row.status === "expired";

  if (isExpired && row.status === "active") {
    await markCookiesExpired(pool, workspaceId);
  }

  return {
    status: isExpired ? "expired" : row.status,
    expires_at: row.expires_at.toISOString(),
    reddit_username: row.reddit_username,
  };
}
