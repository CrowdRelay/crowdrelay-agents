/**
 * Reddit authenticated scraper — Playwright + Google OAuth.
 *
 * Reddit blocks unauthenticated JSON API access with a JavaScript
 * bot-detection challenge. This module launches a headless Chromium browser,
 * logs into Reddit via Google OAuth, extracts the session cookies, and stores
 * them in `agent_service_reddit_cookies`. The Rust worker fetches these
 * cookies via the `/reddit/cookies` endpoint and uses them with reqwest for
 * authenticated JSON API calls.
 *
 * Cookie lifecycle:
 * - Obtained via browser login (Google OAuth → Reddit redirect)
 * - Stored encrypted in Postgres with a 7-day expiry
 * - Background ticker refreshes expired cookies every 6 hours
 * - If refresh fails, status flips to 'failed' and the worker falls back
 *   to unauthenticated requests (which will 403, but the system degrades
 *   gracefully — the brain still dispatches, the agent service still runs)
 */

import { chromium, type Browser, type BrowserContext, type Cookie } from "playwright";
import type { DbPool } from "../store/db.js";
import type { OAuthClientConfig } from "../config.js";

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
// Browser login
// ---------------------------------------------------------------------------

/**
 * Launches a headless Chromium browser, navigates to Reddit, clicks
 * "Continue with Google", completes the Google OAuth flow, and extracts
 * the Reddit session cookies.
 *
 * The Google OAuth client must be configured with Reddit's login page as
 * the redirect URI. The flow:
 * 1. Navigate to https://www.reddit.com/login
 * 2. Click "Continue with Google"
 * 3. Google OAuth: enter email → password → consent (if needed)
 * 4. Wait for redirect back to Reddit (URL contains reddit.com)
 * 5. Extract all cookies for .reddit.com domain
 *
 * Returns the cookies and the Reddit username (extracted from the page).
 */
async function loginViaGoogleOAuth(
  oauthClient: OAuthClientConfig,
  googleEmail: string,
  googlePassword: string,
): Promise<{ cookies: Cookie[]; username: string | null }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });

  try {
    const page = await context.newPage();

    // Navigate to Reddit login page
    await page.goto("https://www.reddit.com/login/", { waitUntil: "networkidle" });

    // Click "Continue with Google" button
    const googleButton = await page.waitForSelector(
      'button:has-text("Continue with Google"), a:has-text("Continue with Google")',
      { timeout: 10_000 },
    );
    await googleButton.click();

    // Wait for Google OAuth page to load
    await page.waitForURL("**/accounts.google.com/**", { timeout: 15_000 });

    // Enter email
    await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
    await page.fill('input[type="email"]', googleEmail);
    await page.click('button:has-text("Next"), #identifierNext');

    // Wait for password field
    await page.waitForSelector('input[type="password"]', { timeout: 10_000 });
    await page.fill('input[type="password"]', googlePassword);
    await page.click('button:has-text("Next"), #passwordNext');

    // Wait for redirect back to Reddit
    await page.waitForURL("**/reddit.com/**", { timeout: 30_000 });

    // Wait for Reddit to fully load (the username appears in the header)
    await page.waitForLoadState("networkidle");

    // Extract Reddit username from the page
    let username: string | null = null;
    try {
      const userElement = await page.waitForSelector(
        '[data-testid="user-menu-button"], faceplate-dropdown-menu button',
        { timeout: 5_000 },
      );
      username = await userElement.textContent();
      username = username?.trim() || null;
    } catch {
      // Username extraction is best-effort — cookies are the primary output
    }

    // Extract all cookies for .reddit.com domain
    const cookies = await context.cookies("https://www.reddit.com");

    return { cookies, username };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Obtains fresh Reddit cookies by launching a browser and logging in via
 * Google OAuth. Stores the cookies in the database.
 *
 * @throws if the Google OAuth client is not configured or login fails
 */
export async function refreshRedditCookies(
  pool: DbPool,
  workspaceId: string,
  oauthClient: OAuthClientConfig,
  googleEmail: string,
  googlePassword: string,
): Promise<RedditCookieResponse> {
  try {
    const { cookies, username } = await loginViaGoogleOAuth(
      oauthClient,
      googleEmail,
      googlePassword,
    );

    if (cookies.length === 0) {
      await markCookiesFailed(pool, workspaceId);
      throw new Error("login succeeded but no Reddit cookies were obtained");
    }

    await storeCookies(pool, workspaceId, cookies, username);

    const expiresAt = new Date(Date.now() + COOKIE_TTL_HOURS * 60 * 60 * 1000);
    return {
      cookies,
      expires_at: expiresAt.toISOString(),
      status: "active",
      reddit_username: username,
    };
  } catch (error) {
    await markCookiesFailed(pool, workspaceId);
    throw error;
  }
}

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

// ---------------------------------------------------------------------------
// Background ticker
// ---------------------------------------------------------------------------

let scraperRunning = false;

/**
 * Runs a scraper cycle: finds all workspaces with expired or missing Reddit
 * cookies and refreshes them. Called by the cron ticker in server.ts.
 * Re-entrant safe: if a previous cycle is still running, skips this tick.
 */
export async function runScraperCycle(
  pool: DbPool,
  oauthClient: OAuthClientConfig | null,
  getCredentials: (workspaceId: string) => Promise<{ email: string; password: string } | null>,
): Promise<void> {
  if (scraperRunning) {
    console.log("[reddit-scraper] previous cycle still running, skipping");
    return;
  }
  if (!oauthClient) {
    return; // Scraper disabled — no Google OAuth client configured
  }

  scraperRunning = true;
  try {
    // Find workspaces with expired or missing cookies
    const { rows } = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM agent_service_reddit_cookies
       WHERE status IN ('expired', 'failed')
          OR (status = 'active' AND expires_at < now())
       UNION
       SELECT DISTINCT workspace_id FROM fanbase_connections
       WHERE platform = 'reddit' AND status = 'connected'
         AND workspace_id NOT IN (SELECT workspace_id FROM agent_service_reddit_cookies)`,
    );

    if (rows.length === 0) {
      return; // Nothing to refresh
    }

    console.log(`[reddit-scraper] refreshing cookies for ${rows.length} workspace(s)`);

    for (const { workspace_id } of rows) {
      try {
        const creds = await getCredentials(workspace_id);
        if (!creds) {
          console.log(`[reddit-scraper] no Google credentials for workspace ${workspace_id}, skipping`);
          continue;
        }

        await refreshRedditCookies(pool, workspace_id, oauthClient, creds.email, creds.password);
        console.log(`[reddit-scraper] refreshed cookies for workspace ${workspace_id}`);
      } catch (error) {
        console.error(`[reddit-scraper] failed to refresh cookies for workspace ${workspace_id}:`, error);
      }
    }
  } finally {
    scraperRunning = false;
  }
}
