/**
 * Reddit browser client — the browser IS the API.
 *
 * Reddit sealed off every non-browser access path: public .json → 403,
 * OAuth apps → forbidden, proxy IPs → blocked. The only access path that
 * still works is a real logged-in browser session. This module keeps a
 * persistent headless Chromium logged into Reddit and drives it for every
 * Reddit operation the growth loop needs:
 *
 *   getJson        → navigate to a .json URL (authenticated → no 403)
 *   submitPost     → drive the /submit form (or the web API from the page)
 *   getPostMetrics → read a post's score/comments via its .json URL
 *   scrapeRedditQueries → subreddit search, upserted to reddit_scrape_results
 *
 * Session persistence: `chromium.launchPersistentContext` keeps cookies and
 * localStorage on disk across restarts, so a login only happens when the
 * session actually expires (measured by probing /me.json). Credentials come
 * from `agent_service_credentials` (provider `reddit-browser`), stored
 * encrypted by POST /reddit/credentials — never in a request body, never
 * logged.
 *
 * Login order: Reddit direct username/password when provided (far less bot
 * detection than Google), Google OAuth as the fallback. 2FA → hard error
 * telling the operator to provide an app password or disable 2FA.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { DbPool } from "../store/db.js";
import { decryptWithRotation, encrypt } from "../crypto.js";
import {
  parseSubredditListing,
  normalizeSubredditName,
  type ScrapeResultRow,
} from "./reddit-scrape-parse.js";

export {
  parseSubredditListing,
  normalizeSubredditName,
  type ScrapeResultRow,
} from "./reddit-scrape-parse.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REDDIT_ORIGIN = "https://www.reddit.com";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CREDENTIALS_PROVIDER = "reddit-browser";

const MAX_LOGIN_ATTEMPTS = 3;

const PAGE_TIMEOUT_MS = 30_000;

const SESSION_PROBE_TIMEOUT_MS = 20_000;

/** Politeness gap between subreddit-search queries (browser looks human). */
const SCRAPE_QUERY_SPACING_MS = 2_000;

export const MAX_SCRAPE_LIMIT = 25;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error with an HTTP status code, mapped directly onto route responses. */
export class RedditBrowserError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "RedditBrowserError";
    this.statusCode = statusCode;
  }
}

function is2faChallenge(message: string): boolean {
  return /two-factor|2fa|verify it's you|unusual activity|couldn't sign you in/i.test(message);
}

// ---------------------------------------------------------------------------
// Credentials storage (encrypted JSON blob in agent_service_credentials)
// ---------------------------------------------------------------------------

export interface RedditCredentials {
  google_email?: string;
  google_password?: string;
  reddit_username?: string;
  reddit_password?: string;
}

/**
 * Stores Reddit login credentials for a workspace as one encrypted JSON
 * blob. The whole blob is the credential value — the credentials table's
 * UNIQUE (workspace_id, provider) key means one Reddit identity per
 * workspace, which matches reality (one operator account).
 */
export async function storeRedditCredentials(
  pool: DbPool,
  workspaceId: string,
  credentials: RedditCredentials,
  encryptionKey: string,
): Promise<void> {
  const encrypted = encrypt(JSON.stringify(credentials), encryptionKey);
  await pool.query(
    `INSERT INTO agent_service_credentials
      (workspace_id, provider, label, credential_type, encrypted_value, status, last_validated_at)
     VALUES ($1, $2, 'Reddit browser login', 'api_key', $3, 'active', now())
     ON CONFLICT (workspace_id, provider) DO UPDATE SET
       label = 'Reddit browser login',
       credential_type = 'api_key',
       encrypted_value = $3,
       status = 'active',
       last_validated_at = now(),
       last_validation_error = NULL`,
    [workspaceId, CREDENTIALS_PROVIDER, encrypted],
  );
}

/** Loads and decrypts the stored Reddit credentials. Returns null if none. */
export async function getRedditCredentials(
  pool: DbPool,
  workspaceId: string,
  encryptionKey: string,
  previousEncryptionKey: string | null,
): Promise<RedditCredentials | null> {
  const { rows } = await pool.query(
    `SELECT encrypted_value FROM agent_service_credentials
     WHERE workspace_id = $1 AND provider = $2 AND status = 'active'`,
    [workspaceId, CREDENTIALS_PROVIDER],
  );
  const raw = rows[0]?.encrypted_value;
  if (typeof raw !== "string") return null;
  try {
    const { value } = decryptWithRotation(raw, encryptionKey, previousEncryptionKey);
    return JSON.parse(value) as RedditCredentials;
  } catch {
    return null;
  }
}

/** After MAX_LOGIN_ATTEMPTS failed logins the credentials are marked invalid. */
async function markRedditCredentialsFailed(
  pool: DbPool,
  workspaceId: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE agent_service_credentials
     SET status = 'invalid', last_validation_error = $3
     WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, CREDENTIALS_PROVIDER, reason],
  );
}

/**
 * True when the workspace has stored (active) Reddit credentials. Used by
 * routes and tickers to decide whether browser work can even start without
 * launching a login attempt.
 */
export async function hasRedditCredentials(
  pool: DbPool,
  workspaceId: string,
  encryptionKey: string,
  previousEncryptionKey: string | null,
): Promise<boolean> {
  return (await getRedditCredentials(pool, workspaceId, encryptionKey, previousEncryptionKey)) !== null;
}

// ---------------------------------------------------------------------------
// Scrape result persistence
// ---------------------------------------------------------------------------

async function upsertScrapeResult(
  pool: DbPool,
  workspaceId: string,
  query: string,
  row: ScrapeResultRow,
): Promise<void> {
  await pool.query(
    `INSERT INTO reddit_scrape_results
      (workspace_id, query, subreddit_name, display_name, description, subscribers, url, over18)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, query, subreddit_name) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       subscribers = EXCLUDED.subscribers,
       url = EXCLUDED.url,
       over18 = EXCLUDED.over18,
       scraped_at = now()`,
    [
      workspaceId,
      query,
      row.subreddit_name,
      row.display_name,
      row.description,
      row.subscribers,
      row.url,
      row.over18,
    ],
  );
}

// ---------------------------------------------------------------------------
// RedditBrowser
// ---------------------------------------------------------------------------

interface PostListingData {
  score?: number;
  ups?: number;
  num_comments?: number;
  upvote_ratio?: number;
}

/** The /comments/{id}.json body is [post_listing, comments_listing]. */
export function extractPostData(body: unknown): PostListingData | null {
  const listings = body as
    | Array<{ data?: { children?: Array<{ data?: PostListingData }> } }>
    | null;
  return listings?.[0]?.data?.children?.[0]?.data ?? null;
}

const DEFAULT_PROFILE_DIR = join(process.cwd(), "data", "reddit-browser-profile");

export class RedditBrowser {
  private context: BrowserContext | null = null;
  private authed = false;
  private ensurePromise: Promise<void> | null = null;
  /** Workspace whose credentials established the current session. */
  private sessionWorkspaceId: string | null = null;
  private readonly profileDir: string;

  constructor(
    private readonly pool: DbPool,
    private readonly encryptionKey: string,
    private readonly previousEncryptionKey: string | null = null,
    profileDir?: string,
  ) {
    this.profileDir = profileDir ?? process.env.REDDIT_BROWSER_PROFILE_DIR ?? DEFAULT_PROFILE_DIR;
  }

  /** Drops the current browser session so the next call re-logins. */
  async invalidate(): Promise<void> {
    this.authed = false;
    await this.closeContext();
  }

  async close(): Promise<void> {
    this.authed = false;
    await this.closeContext();
  }

  private async closeContext(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // Closing an already-dead context must not mask the real error.
      }
    }
  }

  /**
   * Returns a logged-in browser context, logging in only when needed.
   * Single-flight: concurrent callers for the same workspace await the same
   * establishment promise. If a different workspace requests a session, the
   * current session is invalidated and re-established with its credentials.
   */
  async ensureSession(workspaceId: string): Promise<BrowserContext> {
    if (this.context && this.authed && this.sessionWorkspaceId === workspaceId) {
      return this.context;
    }
    // A different workspace is requesting the session — invalidate the
    // current one so establishSession logs in with the right credentials.
    if (this.context && this.sessionWorkspaceId !== workspaceId) {
      await this.invalidate();
    }
    if (!this.ensurePromise) {
      this.ensurePromise = this.establishSession(workspaceId).finally(() => {
        this.ensurePromise = null;
      });
    }
    await this.ensurePromise;
    return this.context as BrowserContext;
  }

  private async establishSession(workspaceId: string): Promise<void> {
    const credentials = await getRedditCredentials(
      this.pool,
      workspaceId,
      this.encryptionKey,
      this.previousEncryptionKey,
    );
    if (!credentials) {
      throw new RedditBrowserError(
        "no reddit credentials stored — POST /reddit/credentials first",
        503,
      );
    }

    await this.closeContext();
    mkdirSync(this.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: true,
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      // --no-sandbox: the container runs as root. AutomationControlled off
      // keeps navigator.webdriver out of Reddit's bot heuristics.
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    // Hide the webdriver flag before any page script runs (Reddit checks it).
    await this.context.addInitScript(
      `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
    );

    const page = await this.context.newPage();
    try {
      if (await this.hasValidSession(page)) {
        this.authed = true;
        this.sessionWorkspaceId = workspaceId;
        return;
      }

      let lastError: Error = new RedditBrowserError("login did not produce a valid session");
      for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
        try {
          if (credentials.reddit_username && credentials.reddit_password) {
            await this.loginWithReddit(
              page,
              credentials.reddit_username,
              credentials.reddit_password,
            );
          } else if (credentials.google_email && credentials.google_password) {
            await this.loginWithGoogle(
              page,
              credentials.google_email,
              credentials.google_password,
            );
          } else {
            throw new RedditBrowserError(
              "stored credentials contain neither a Reddit username/password nor a Google email/password",
              400,
            );
          }
          if (await this.hasValidSession(page)) {
            this.authed = true;
            this.sessionWorkspaceId = workspaceId;
            return;
          }
          lastError = new RedditBrowserError("login completed but the session is not valid");
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (is2faChallenge(lastError.message)) break; // retries cannot fix 2FA
        }
      }

      await markRedditCredentialsFailed(
        this.pool,
        workspaceId,
        lastError.message.slice(0, 500),
      );
      // Login failed — close the browser context so we don't leave a zombie
      // Chromium process running between requests.
      await this.closeContext();
      throw new RedditBrowserError(
        `reddit login failed after ${MAX_LOGIN_ATTEMPTS} attempt(s): ${lastError.message}`,
        502,
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Probes /me.json — 200 with a username means the session is alive. */
  private async hasValidSession(page: Page): Promise<boolean> {
    try {
      const response = await page.goto(`${REDDIT_ORIGIN}/me.json`, {
        waitUntil: "domcontentloaded",
        timeout: SESSION_PROBE_TIMEOUT_MS,
      });
      if (!response || response.status() !== 200) return false;
      const body = (await response.json()) as { data?: { name?: string } };
      return typeof body?.data?.name === "string" && body.data.name.length > 0;
    } catch {
      return false;
    }
  }

  private async loginWithReddit(page: Page, username: string, password: string): Promise<void> {
    await page.goto(`${REDDIT_ORIGIN}/login/`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    const userField = page.locator(
      'input[name="username"], #loginUsername',
    ).first();
    await userField.waitFor({ timeout: 15_000 });
    await userField.fill(username);
    await page.locator('input[name="password"], #loginPassword').first().fill(password);
    await page
      .locator('button[type="submit"]:has-text("Log In"), button:has-text("Log In")')
      .first()
      .click();

    // 2FA surfaces as an OTP input right after submit — detect and abort.
    const otp = page.locator('input[name="otp"], input[placeholder*="two-factor" i]');
    try {
      await otp.waitFor({ timeout: 4_000 });
      throw new RedditBrowserError(
        "reddit login hit two-factor authentication — provide an app password or disable 2FA",
        400,
      );
    } catch (error) {
      if (error instanceof RedditBrowserError) throw error;
      // No OTP field appeared — continue waiting for the redirect.
    }

    await page.waitForURL(/reddit\.com/, { timeout: PAGE_TIMEOUT_MS });
  }

  private async loginWithGoogle(page: Page, email: string, password: string): Promise<void> {
    await page.goto(`${REDDIT_ORIGIN}/login/`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    const googleButton = page
      .locator('button:has-text("Continue with Google"), a:has-text("Continue with Google")')
      .first();
    await googleButton.waitFor({ timeout: 15_000 });
    await googleButton.click();

    await page.waitForURL(/accounts\.google\.com/, { timeout: PAGE_TIMEOUT_MS });

    const emailField = page.locator('input[type="email"]').first();
    await emailField.waitFor({ timeout: 15_000 });
    await emailField.fill(email);
    await page.locator('#identifierNext, button:has-text("Next")').first().click();

    const passwordField = page.locator('input[type="password"]:visible').first();
    await passwordField.waitFor({ timeout: 15_000 });
    await passwordField.fill(password);
    await page.locator('#passwordNext, button:has-text("Next")').first().click();

    // Google interstitials ("verify it's you", 2FA) leave us on google.com.
    await page.waitForURL(/reddit\.com/, { timeout: PAGE_TIMEOUT_MS * 2 }).catch(() => {
      throw new RedditBrowserError(
        "google login did not return to reddit — device verification, 2FA, or bot detection hit (check REDDIT_BROWSER logs)",
        400,
      );
    });
  }

  /**
   * Navigates the authenticated browser to a Reddit JSON path and returns
   * the parsed body. A 403/429 invalidates the cached session so the next
   * call re-validates (and re-logins if the session truly expired).
   */
  async getJson(workspaceId: string, path: string): Promise<unknown> {
    const context = await this.ensureSession(workspaceId);
    const page = await context.newPage();
    try {
      const response = await page.goto(`${REDDIT_ORIGIN}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });
      const status = response?.status() ?? 0;
      if (status === 403 || status === 429) {
        await this.invalidate();
        throw new RedditBrowserError(`reddit returned HTTP ${status} for ${path}`, status);
      }
      if (!response || !response.ok()) {
        throw new RedditBrowserError(`reddit returned HTTP ${status} for ${path}`, status || 502);
      }
      try {
        return await response.json();
      } catch {
        // HTML instead of JSON → Reddit served a challenge page.
        await this.invalidate();
        throw new RedditBrowserError(
          `reddit returned a non-JSON page for ${path} — session likely rejected`,
          502,
        );
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Submits a self post. Primary path: POST /api/submit from inside the
   * page (same-origin, session cookies, modhash CSRF header) — deterministic,
   * no UI selectors. Fallback: drive the actual /submit form like a human.
   */
  async submitPost(
    workspaceId: string,
    subreddit: string,
    title: string,
    body: string,
  ): Promise<{ post_id: string; post_url: string }> {
    const sr = normalizeSubredditName(subreddit);
    if (!sr) {
      throw new RedditBrowserError("subreddit name is required", 400);
    }
    if (!title.trim()) {
      throw new RedditBrowserError("title is required", 400);
    }

    const context = await this.ensureSession(workspaceId);
    const page = await context.newPage();
    try {
      // A same-origin page is required for the fetch to carry session
      // cookies and pass CSRF; the subreddit itself works for both paths.
      await page.goto(`${REDDIT_ORIGIN}/r/${sr}/`, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });

      try {
        return await this.submitViaApi(page, sr, title, body);
      } catch (apiError) {
        const message = apiError instanceof Error ? apiError.message : String(apiError);
        console.warn(`[reddit-browser] /api/submit failed (${message}), trying the submit form`);
        return await this.submitViaForm(page, sr, title, body);
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async submitViaApi(
    page: Page,
    sr: string,
    title: string,
    body: string,
  ): Promise<{ post_id: string; post_url: string }> {
    const result = await page.evaluate(
      async ({ sr, title, body }) => {
        const me = await fetch("/api/me.json", { credentials: "include" })
          .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
          .catch(() => null);
        const modhash: string | null =
          (me as { data?: { modhash?: string } | null } | null)?.data?.modhash ?? null;

        const params = new URLSearchParams({
          api_type: "json",
          kind: "self",
          sr,
          title,
          text: body,
        });
        const headers: Record<string, string> = {
          "Content-Type": "application/x-www-form-urlencoded",
        };
        if (modhash) headers["X-Modhash"] = modhash;

        const response = await fetch("/api/submit", {
          method: "POST",
          credentials: "include",
          headers,
          body: params.toString(),
        });
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        return { status: response.status, payload };
      },
      { sr, title, body },
    );

    if (result.status === 429) {
      throw new RedditBrowserError("reddit rate limited the submit", 429);
    }
    if (result.status !== 200) {
      throw new RedditBrowserError(`reddit /api/submit returned HTTP ${result.status}`, 502);
    }

    const payload = result.payload as {
      json?: { errors?: Array<[string, string]>; data?: { id?: string; url?: string } };
    } | null;
    const errors = payload?.json?.errors ?? [];
    if (errors.length > 0) {
      throw new RedditBrowserError(
        `reddit rejected the post: ${errors.map(([code, msg]) => `${code}: ${msg}`).join("; ")}`,
        400,
      );
    }
    const data = payload?.json?.data;
    if (!data?.id || !data?.url) {
      throw new RedditBrowserError("reddit /api/submit returned no post id/url", 502);
    }
    return { post_id: data.id, post_url: data.url };
  }

  private async submitViaForm(
    page: Page,
    sr: string,
    title: string,
    body: string,
  ): Promise<{ post_id: string; post_url: string }> {
    await page.goto(`${REDDIT_ORIGIN}/r/${sr}/submit?selftext=true`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    const titleField = page
      .locator(
        'textarea[name="title"], textarea[placeholder*="itle"], div[contenteditable="true"][aria-label*="itle"], input[name="title"]',
      )
      .first();
    await titleField.waitFor({ timeout: 20_000 });
    await titleField.fill(title);

    // New Reddit's body editor is a contenteditable textbox (markdown or
    // fancy tab). Old Reddit uses a plain textarea.
    const editor = page
      .locator(
        'div[contenteditable="true"][role="textbox"], textarea[name="text"], textarea[placeholder*="ext" i]',
      )
      .first();
    await editor.waitFor({ timeout: 20_000 });
    const isContenteditable = await editor.evaluate((el) =>
      (el as { isContentEditable?: boolean }).isContentEditable === true,
    );
    if (isContenteditable) {
      await editor.click();
      // insertText preserves newlines without key-by-key typing.
      await page.keyboard.insertText(body);
    } else {
      await editor.fill(body);
    }

    const postButton = page
      .locator('button[type="submit"]:has-text("Post"), button:has-text("Post")')
      .last();
    await postButton.click();

    // Reddit redirects to the new post on success.
    await page.waitForURL(/\/comments\//, { timeout: PAGE_TIMEOUT_MS * 2 });
    const url = page.url();
    const idMatch = url.match(/\/comments\/([a-z0-9]+)/i);
    if (!idMatch) {
      throw new RedditBrowserError(`post submitted but could not extract its id from ${url}`);
    }
    return { post_id: idMatch[1], post_url: url.split("?")[0] };
  }

  /** Reads score/upvotes/comments/ratio for a post via its .json URL. */
  async getPostMetrics(
    workspaceId: string,
    postId: string,
  ): Promise<{
    score: number;
    upvotes: number;
    num_comments: number;
    upvote_ratio: number | null;
  }> {
    const cleanId = postId.trim().replace(/^t3_/, "");
    const body = await this.getJson(
      workspaceId,
      `/comments/${encodeURIComponent(cleanId)}.json?raw_json=1&limit=1`,
    );
    const post = extractPostData(body);
    if (!post) {
      throw new RedditBrowserError(`could not read metrics for post ${cleanId}`, 404);
    }
    return {
      score: post.score ?? 0,
      upvotes: post.ups ?? post.score ?? 0,
      num_comments: post.num_comments ?? 0,
      upvote_ratio: typeof post.upvote_ratio === "number" ? post.upvote_ratio : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Subreddit scraping (shared by routes, the ticker, and the MCP tool)
// ---------------------------------------------------------------------------

export interface ScrapeOutcome {
  results: ScrapeResultRow[];
  errors: string[];
}

/**
 * Scrapes subreddit search results for each query through the logged-in
 * browser and upserts them into reddit_scrape_results. Partial failure is
 * fine: one bad query does not abort the rest.
 */
export async function scrapeRedditQueries(
  pool: DbPool,
  workspaceId: string,
  queries: string[],
  limit = 10,
): Promise<ScrapeOutcome> {
  const browser = getRedditBrowser(pool);
  const results: ScrapeResultRow[] = [];
  const errors: string[] = [];
  const boundedLimit = Math.max(1, Math.min(limit, MAX_SCRAPE_LIMIT));

  for (const rawQuery of queries) {
    const query = rawQuery.trim();
    if (!query) continue;
    try {
      const body = await browser.getJson(
        workspaceId,
        `/subreddits/search.json?q=${encodeURIComponent(query)}&limit=${boundedLimit}&sort=activity&raw_json=1`,
      );
      const rows = parseSubredditListing(body, boundedLimit);
      for (const row of rows) {
        await upsertScrapeResult(pool, workspaceId, query, row);
      }
      results.push(...rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${query}: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, SCRAPE_QUERY_SPACING_MS));
  }

  return { results, errors };
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let singleton: RedditBrowser | null = null;

/**
 * The Reddit session is process-wide: one operator account, one persistent
 * browser profile. Every caller (routes, ticker, MCP tool) shares it so
 * logins happen once, not per request. The encryption key is required env
 * config (validated at startup), so reading it here is safe.
 */
export function getRedditBrowser(pool: DbPool): RedditBrowser {
  if (!singleton) {
    const encryptionKey = process.env.AGENT_SERVICE_ENCRYPTION_KEY ?? "";
    const previousKey = process.env.AGENT_SERVICE_PREVIOUS_ENCRYPTION_KEY ?? null;
    singleton = new RedditBrowser(pool, encryptionKey, previousKey);
  }
  return singleton;
}

/** Test-only: drop the singleton so a test gets a fresh instance. */
export function resetRedditBrowserForTests(): void {
  singleton = null;
}
