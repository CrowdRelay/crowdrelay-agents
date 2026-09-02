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

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { DbPool } from "../store/db.js";
import { decryptWithRotation, encrypt } from "../crypto.js";
import {
  parseSubredditListing,
  normalizeSubredditName,
  type ScrapeResultRow,
} from "./reddit-scrape-parse.js";
import {
  PAGE_TIMEOUT_MS,
  SESSION_PROBE_TIMEOUT_MS,
  ELEMENT_TIMEOUT_MS,
} from "./reddit-timeouts.js";

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


/**
 * Removes the singleton lock a previous Chromium left in the profile.
 *
 * The profile lives on a persistent volume and the container does not. When a
 * container is replaced — every deploy — Chromium never gets to close, and its
 * `SingletonLock` survives pointing at a hostname and pid that no longer
 * exist. The next launch then refuses the profile outright:
 *
 *   The profile appears to be in use by another Chromium process (99867)
 *   on another computer (0159b55e1e9f).
 *
 * Playwright surfaces that as "Target page, context or browser has been
 * closed", which describes the symptom and hides the cause. Nothing recovers
 * on its own, so Reddit stayed unreadable across every deploy after the first.
 *
 * Safe to do unconditionally here: this service runs one Chromium against one
 * profile, and `closeContext()` has already run, so any lock still present
 * belongs to a process that is gone. Chromium recreates all three entries on
 * launch.
 */
function releaseStaleProfileLock(profileDir: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch {
      // A lock we cannot remove is not worth failing the launch over —
      // Chromium will report it far more precisely than we could here.
    }
  }
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
  /** Workspace the in-flight establishSession belongs to. */
  private pendingWorkspaceId: string | null = null;
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
    this.sessionWorkspaceId = null;
    await this.closeContext();
  }

  async close(): Promise<void> {
    this.authed = false;
    this.sessionWorkspaceId = null;
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
   *
   * Single-flight per workspace: concurrent callers for the SAME workspace
   * share one establishment promise. A caller for a *different* workspace
   * must not join it — the in-flight login belongs to whoever started it, and
   * joining would hand this caller a browser logged into another tenant's
   * Reddit account. Those callers wait the establishment out and then
   * establish their own.
   */
  async ensureSession(workspaceId: string): Promise<BrowserContext> {
    while (this.ensurePromise) {
      const inFlight = this.ensurePromise;
      if (this.pendingWorkspaceId === workspaceId) {
        await inFlight;
        if (this.context && this.authed && this.sessionWorkspaceId === workspaceId) {
          return this.context;
        }
        break; // it was invalidated in the meantime — establish our own
      }
      // Another workspace's login: let it finish, but its outcome is not ours.
      await inFlight.catch(() => {});
    }

    if (this.context && this.authed && this.sessionWorkspaceId === workspaceId) {
      return this.context;
    }
    // A different workspace holds the session — invalidate it so
    // establishSession logs in with the right credentials.
    if (this.context && this.sessionWorkspaceId !== workspaceId) {
      await this.invalidate();
    }

    this.pendingWorkspaceId = workspaceId;
    this.ensurePromise = this.establishSession(workspaceId).finally(() => {
      this.ensurePromise = null;
      this.pendingWorkspaceId = null;
    });
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
    releaseStaleProfileLock(this.profileDir);
    // Reddit blocks headless Chromium (403 on .json, empty search results).
    // Run headed inside Xvfb when DISPLAY is set (container); fall back to
    // headless only when no display is available (local dev without Xvfb).
    const hasDisplay = !!process.env.DISPLAY;
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: !hasDisplay,
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      // --no-sandbox: the container runs as root. AutomationControlled off
      // keeps navigator.webdriver out of Reddit's bot heuristics.
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        // Chromium keeps its renderer shared memory in /dev/shm, and Docker
        // gives a container 64 MB of it by default. That is not enough: the
        // renderer dies during startup and Playwright reports
        // "browserType.launchPersistentContext: Target page, context or
        // browser has been closed", which reads as a Playwright fault rather
        // than a container one. This moves that allocation to a temp file,
        // which is slower and always large enough.
        "--disable-dev-shm-usage",
        // A headless-shaped container has no GPU, and probing for one is
        // another way the renderer falls over on launch.
        "--disable-gpu",
      ],
    });
    // Hide the webdriver flag before any page script runs (Reddit checks it).
    await this.context.addInitScript(
      `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
    );

    const page = await this.context.newPage();
    try {
      if (await this.hasValidSession(page, credentials.reddit_username)) {
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
          if (await this.hasValidSession(page, credentials.reddit_username)) {
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

  /**
   * Probes whether the browser session is authenticated. Tries /me.json
   * first (fast, works on Mac/residential). If that 403s (container
   * fingerprinting), falls back to checking the HTML homepage for a
   * logged-in indicator (the "Log In" button is absent when authenticated).
   *
   * `expectedUsername` guards the shared browser profile: the profile
   * directory persists one Reddit login across workspaces, so a session left
   * behind by another tenant would otherwise be accepted and used to act as
   * the wrong account. When /me.json names a different user we report the
   * session invalid and force a fresh login. The HTML fallback cannot read
   * the account name, so that path can only answer "logged in or not".
   */
  private async hasValidSession(page: Page, expectedUsername?: string): Promise<boolean> {
    const expected = expectedUsername?.trim().toLowerCase();
    try {
      // Fast path: JSON API (works outside containers)
      const response = await page.goto(`${REDDIT_ORIGIN}/me.json`, {
        waitUntil: "domcontentloaded",
        timeout: SESSION_PROBE_TIMEOUT_MS,
      });
      if (response && response.status() !== 200) {
        console.warn(
          `[reddit-browser] session probe: /me.json returned ${response.status()}`,
        );
      }
      if (response && response.status() === 200) {
        try {
          const body = (await response.json()) as { data?: { name?: string } };
          const name = body?.data?.name;
          if (typeof name === "string" && name.length > 0) {
            if (expected && name.toLowerCase() !== expected) {
              console.warn(
                `[reddit-browser] cached profile is signed in as u/${name}, expected u/${expectedUsername} — forcing re-login`,
              );
              return false;
            }
            return true;
          }
        } catch {
          // Non-JSON response — fall through to HTML check
        }
      }
      // Fallback: check HTML homepage for login state
      const htmlResp = await page.goto(`${REDDIT_ORIGIN}/`, {
        waitUntil: "domcontentloaded",
        timeout: SESSION_PROBE_TIMEOUT_MS,
      });
      if (!htmlResp || htmlResp.status() !== 200) return false;
      // When logged out, Reddit shows a "Log In" / "Zarejestruj się" button.
      // When logged in, the homepage shows the feed with no login prompt.
      const hasLoginButton = await page
        .locator('a[href*="/login"], button:has-text("Log In"), button:has-text("Zaloguj")')
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (hasLoginButton) {
        console.warn(
          "[reddit-browser] session probe: homepage still shows a login button",
        );
      }
      return !hasLoginButton;
    } catch (error) {
      // Say why. A bare `return false` here surfaces as "login completed but
      // the session is not valid" with nothing to act on, and after three of
      // those the credential is marked invalid — so the one place that knows
      // whether this was a timeout, a 403 or a redirect was also the one place
      // throwing that away.
      console.warn(
        `[reddit-browser] session probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async loginWithReddit(page: Page, username: string, password: string): Promise<void> {
    await page.goto(`${REDDIT_ORIGIN}/login/`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    // Reddit renders login inputs inside <faceplate-text-input> custom
    // elements with shadow DOM. Playwright pierces open shadow roots,
    // so input[name="username"] works directly.
    const userField = page.locator('input[name="username"]').first();
    await userField.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
    await userField.fill(username);
    await page.locator('input[name="password"]').first().fill(password);
    await page
      .locator('button:has-text("Log In")')
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

    // Wait to leave the login page, not to be on reddit.com.
    //
    // This was `waitForURL(/reddit\.com/)`, and the login page is already
    // `reddit.com/login/` — so the pattern matched the URL the browser was
    // standing on and returned immediately, without waiting for anything at
    // all. The session probe then ran before the login had completed and
    // reported "login completed but the session is not valid", three times,
    // which marked working credentials invalid.
    //
    // A wrong password keeps the browser on /login, so this now times out
    // there instead of racing past it, and the error says which happened.
    await page
      .waitForURL((url) => !/\/login/.test(url.pathname), { timeout: PAGE_TIMEOUT_MS })
      .catch(() => {
        throw new RedditBrowserError(
          "reddit login did not leave the login page — the password was rejected " +
            "or a challenge is being shown",
          400,
        );
      });
  }

  private async loginWithGoogle(page: Page, email: string, password: string): Promise<void> {
    await page.goto(`${REDDIT_ORIGIN}/login/`, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    // Reddit renders "Continue with Google" as a Google Identity Services
    // (SIW) button inside an iframe, not as a Reddit-native button.
    // The iframe src contains "accounts.google.com/gsi".
    const gsiFrame = page.frameLocator(
      'iframe[src*="accounts.google.com/gsi"]',
    ).first();
    const googleButton = gsiFrame.locator('[role="button"]').first();
    await googleButton.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
    await googleButton.click();

    // Google may open a popup or navigate the page to accounts.google.com.
    // Handle both: wait for either a popup or a URL change.
    const popupPromise = page.waitForEvent("popup", { timeout: 5_000 })
      .catch(() => null);
    await page.waitForURL(/accounts\.google\.com/, { timeout: ELEMENT_TIMEOUT_MS })
      .catch(async () => {
        // No navigation — check if a popup opened.
      });
    const popup = await popupPromise;
    const googlePage = popup ?? page;

    const emailField = googlePage.locator('input[type="email"]').first();
    await emailField.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
    await emailField.fill(email);
    await googlePage.locator('#identifierNext, button:has-text("Next")').first().click();

    const passwordField = googlePage.locator('input[type="password"]:visible').first();
    await passwordField.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
    await passwordField.fill(password);
    await googlePage.locator('#passwordNext, button:has-text("Next")').first().click();

    // Google interstitials ("verify it's you", 2FA) leave us on google.com.
    // On success, the popup closes and the original page navigates to reddit.
    if (popup) {
      await popup.waitForEvent("close", { timeout: PAGE_TIMEOUT_MS * 2 }).catch(() => {});
      await page.waitForURL(/reddit\.com/, { timeout: PAGE_TIMEOUT_MS * 2 }).catch(() => {
        throw new RedditBrowserError(
          "google login did not return to reddit — device verification, 2FA, or bot detection hit (check REDDIT_BROWSER logs)",
          400,
        );
      });
    } else {
      await page.waitForURL(/reddit\.com/, { timeout: PAGE_TIMEOUT_MS * 2 }).catch(() => {
        throw new RedditBrowserError(
          "google login did not return to reddit — device verification, 2FA, or bot detection hit (check REDDIT_BROWSER logs)",
          400,
        );
      });
    }
  }

  /**
   * Navigates the authenticated browser to a Reddit JSON path and returns
   * the parsed body. A 403/429 invalidates the cached session so the next
   * call re-validates (and re-logins if the session truly expired).
   *
   * Note: Reddit blocks .json endpoints from container environments even
   * with a valid session. Use searchSubredditsHtml for subreddit search.
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
   * Scrapes subreddit search results from the HTML search page.
   * Used instead of getJson for subreddit search because Reddit blocks
   * .json endpoints from container environments.
   */
  async searchSubredditsHtml(
    workspaceId: string,
    query: string,
    limit: number,
  ): Promise<ScrapeResultRow[]> {
    const context = await this.ensureSession(workspaceId);
    const page = await context.newPage();
    try {
      const url = `${REDDIT_ORIGIN}/search/?q=${encodeURIComponent(query)}&type=sr`;
      const response = await page.goto(url, {
        waitUntil: "networkidle",
        timeout: PAGE_TIMEOUT_MS,
      });
      const status = response?.status() ?? 0;
      if (status === 403 || status === 429) {
        await this.invalidate();
        throw new RedditBrowserError(
          `reddit returned HTTP ${status} for search HTML`,
          status,
        );
      }
      if (!response || !response.ok()) {
        throw new RedditBrowserError(
          `reddit returned HTTP ${status} for search HTML`,
          status || 502,
        );
      }
      // Wait for search results to render
      await page.waitForTimeout(3000);

      const rows = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (maxLimit: number) => {
          const results: Array<{
            subreddit_name: string;
            display_name: string;
            description: string;
            subscribers: number;
            url: string;
            over18: boolean;
          }> = [];
          const seen = new Set<string>();
          // Nav links to skip
          const navNames = new Set([
            "popular", "all", "AskReddit", "pics", "funny", "movies",
            "gaming", "worldnews", "news", "todayilearned", "nottheonion",
            "explainlikeimfive", "mildlyinteresting", "DIY", "videos",
            "OldSchoolCool", "europe", "TwoXChromosomes", "tifu", "Music",
            "books", "LifeProTips", "dataisbeautiful", "aww", "science",
            "space", "Showerthoughts", "askscience", "Jokes", "poland",
            "Art", "IAmA", "Futurology", "sports", "UpliftingNews", "food",
            "nosleep", "creepy", "history", "gifs", "philosophy",
            "Documentaries", "EarthPorn", "announcements", "writing",
          ]);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = (globalThis as any).document;
          const links = doc.querySelectorAll('a[href^="/r/"]');
          for (const link of links) {
            if (results.length >= maxLimit) break;
            const href = link.getAttribute("href") || "";
            const match = href.match(/^\/r\/([^/]+)\/?$/);
            if (!match) continue;
            const name = match[1];
            if (seen.has(name) || navNames.has(name)) continue;
            seen.add(name);

            // Walk up to find the card container with description
            let card = link;
            for (let i = 0; i < 10; i++) {
              if (!card?.parentElement) break;
              card = card.parentElement;
              const text = card.textContent || "";
              if (text.length > 100) break;
            }
            const cardText = card?.textContent?.trim() || "";

            // Extract description: text after the subreddit name
            const nameIdx = cardText.indexOf(name);
            let description = "";
            if (nameIdx >= 0) {
              description = cardText
                .substring(nameIdx + name.length)
                .replace(/^\s*r\/\s*\S+\s*/, "")
                .trim()
                .substring(0, 300);
            }

            // Extract subscriber count from text like "427 tys." or "1.2M"
            let subscribers = 0;
            const subMatch = cardText.match(
              /([\d,.]+)\s*(tys|k|m|mln)\b/i,
            );
            if (subMatch) {
              const num = parseFloat(subMatch[1].replace(",", "."));
              const unit = subMatch[2].toLowerCase();
              if (unit === "tys" || unit === "k") subscribers = Math.round(num * 1000);
              else if (unit === "m" || unit === "mln") subscribers = Math.round(num * 1_000_000);
            }

            results.push({
              subreddit_name: name.toLowerCase(),
              display_name: name,
              description,
              subscribers,
              url: href,
              over18: false,
            });
          }
          return results;
        },
        limit,
      );
      return rows;
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
    await titleField.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
    await titleField.fill(title);

    // New Reddit's body editor is a contenteditable textbox (markdown or
    // fancy tab). Old Reddit uses a plain textarea.
    const editor = page
      .locator(
        'div[contenteditable="true"][role="textbox"], textarea[name="text"], textarea[placeholder*="ext" i]',
      )
      .first();
    await editor.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
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
  const pending = queries.map((q) => q.trim()).filter(Boolean);

  for (let i = 0; i < pending.length; i++) {
    const query = pending[i];
    try {
      // Use HTML scraping — Reddit blocks .json endpoints from containers.
      const rows = await browser.searchSubredditsHtml(
        workspaceId,
        query,
        boundedLimit,
      );
      for (const row of rows) {
        await upsertScrapeResult(pool, workspaceId, query, row);
      }
      results.push(...rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${query}: ${message}`);
    }
    // Space out queries so the browser looks human — but not after the last
    // one, where it only delays the caller (the MCP tool runs this inline).
    if (i < pending.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, SCRAPE_QUERY_SPACING_MS));
    }
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
