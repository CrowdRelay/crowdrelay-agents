/**
 * Reddit routes.
 *
 * Two eras coexist here:
 *  - Cookie management (/reddit/status, /reddit/cookies, /reddit/login):
 *    cookies for the Rust worker's reqwest calls. Kept as a fallback path.
 *  - Browser-as-API (/reddit/credentials, /reddit/scrape, /reddit/post,
 *    /reddit/metrics, /reddit/scrape/results): the preferred path. A
 *    persistent logged-in browser in this service does all Reddit work;
 *    the Rust worker and MCP tools only read the DB or call these endpoints.
 */

import type { FastifyInstance } from "fastify";
import { extractWorkspaceId } from "../auth.js";
import type { DbPool } from "../store/db.js";
import type { OAuthClientConfig } from "../config.js";
import {
  getRedditCookies,
  getRedditCookieStatus,
  refreshRedditCookies,
} from "../agent/reddit-scraper.js";
import {
  RedditBrowserError,
  MAX_SCRAPE_LIMIT,
  getRedditBrowser,
  scrapeRedditQueries,
  storeRedditCredentials,
  type RedditCredentials,
} from "../agent/reddit-browser.js";

export function registerRedditRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    encryptionKey: string;
    previousEncryptionKey: string | null;
    oauthClients: Record<string, OAuthClientConfig>;
  },
) {
  const googleClient = opts.oauthClients["google"] ?? null;

  function requireWorkspaceId(request: {
    headers: Record<string, string | string[] | undefined>;
  }): { workspaceId?: string; errorReply?: { statusCode: number; message: string } } {
    try {
      return {
        workspaceId: extractWorkspaceId(
          opts.authKey,
          request.headers as Record<string, string | string[] | undefined>,
        ),
      };
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return { errorReply: { statusCode, message: (err as Error).message } };
    }
  }

  function browserErrorReply(reply: { code(code: number): { send(body: unknown): unknown } }, error: unknown) {
    if (error instanceof RedditBrowserError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    const message = error instanceof Error ? error.message : "unknown error";
    return reply.code(502).send({ error: `reddit browser error: ${message}` });
  }

  /**
   * GET /reddit/status — quick health check, no cookies in response.
   * Returns whether cookies are active, expired, or missing.
   */
  app.get("/reddit/status", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    const status = await getRedditCookieStatus(opts.pool, workspaceId as string);
    return reply.send(status);
  });

  /**
   * GET /reddit/cookies — returns current Reddit session cookies.
   * If cookies are expired, returns them with status 'expired' so the
   * caller can decide whether to trigger a refresh.
   */
  app.get("/reddit/cookies", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    const cookies = await getRedditCookies(opts.pool, workspaceId as string);
    if (!cookies) return reply.code(404).send({ error: "no reddit cookies found" });
    return reply.send(cookies);
  });

  /**
   * POST /reddit/login — triggers a manual cookie refresh.
   * Launches a headless browser, logs into Reddit via Google OAuth,
   * and stores fresh cookies. Requires Google OAuth client + credentials.
   */
  app.post("/reddit/login", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    if (!googleClient) {
      return reply.code(503).send({ error: "google oauth client not configured" });
    }

    // Credentials are passed in the request body (operator-initiated).
    // In production, these come from the operator's Google account that
    // is linked to the Reddit account.
    const body = request.body as { google_email?: string; google_password?: string } | null;
    if (!body?.google_email || !body?.google_password) {
      return reply.code(400).send({ error: "google_email and google_password are required" });
    }

    try {
      const result = await refreshRedditCookies(
        opts.pool,
        workspaceId as string,
        googleClient,
        body.google_email,
        body.google_password,
      );
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return reply.code(502).send({ error: `reddit login failed: ${message}` });
    }
  });

  // -------------------------------------------------------------------------
  // Browser-as-API endpoints
  // -------------------------------------------------------------------------

  /**
   * POST /reddit/credentials — stores Reddit login credentials (encrypted).
   * Accepts either a Reddit username/password (preferred: fewer bot checks)
   * or a Google email/password (OAuth fallback). Never returns secrets.
   */
  app.post("/reddit/credentials", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    const body = request.body as RedditCredentials | null;
    const hasReddit = !!body?.reddit_username && !!body?.reddit_password;
    const hasGoogle = !!body?.google_email && !!body?.google_password;
    if (!hasReddit && !hasGoogle) {
      return reply.code(400).send({
        error:
          "provide reddit_username + reddit_password (preferred) or google_email + google_password",
      });
    }

    const credentials: RedditCredentials = {};
    if (hasReddit) {
      credentials.reddit_username = body?.reddit_username;
      credentials.reddit_password = body?.reddit_password;
    }
    if (hasGoogle) {
      credentials.google_email = body?.google_email;
      credentials.google_password = body?.google_password;
    }

    await storeRedditCredentials(opts.pool, workspaceId as string, credentials, opts.encryptionKey);
    // Force the shared browser session to re-establish with the new creds.
    await getRedditBrowser(opts.pool).invalidate();
    return reply.send({ status: "stored", provider: "reddit-browser" });
  });

  /**
   * POST /reddit/scrape — scrapes subreddit search results through the
   * logged-in browser and upserts them into reddit_scrape_results.
   * Body: { queries: string[], limit?: number } (limit ≤ 25).
   */
  app.post("/reddit/scrape", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    const body = request.body as { queries?: unknown; limit?: unknown } | null;
    const queries = Array.isArray(body?.queries)
      ? body?.queries.filter((q): q is string => typeof q === "string")
      : [];
    if (queries.length === 0) {
      return reply.code(400).send({ error: "queries (non-empty string array) is required" });
    }
    if (queries.length > 10) {
      return reply.code(400).send({ error: "max 10 queries per scrape call" });
    }
    const rawLimit = Number(body?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 10;

    try {
      const outcome = await scrapeRedditQueries(
        opts.pool,
        workspaceId as string,
        queries,
        Math.min(limit, MAX_SCRAPE_LIMIT),
      );
      return reply.send(outcome);
    } catch (error) {
      return browserErrorReply(reply, error);
    }
  });

  /**
   * GET /reddit/scrape/results — reads stored scrape results from the DB
   * (no browser involvement). The Rust worker calls this first and only
   * falls back to POST /reddit/scrape when the answer is empty.
   */
  app.get("/reddit/scrape/results", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    const query = (request.query ?? {}) as { query?: string; limit?: string };
    const rawLimit = Number(query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 25;
    const params: unknown[] = [workspaceId, limit];
    let where = "workspace_id = $1";
    if (typeof query.query === "string" && query.query.trim() !== "") {
      params.push(query.query.trim());
      where += ` AND query = $${params.length}`;
    }
    const { rows } = await opts.pool.query(
      `SELECT subreddit_name, display_name, description, subscribers, url, over18, scraped_at
       FROM reddit_scrape_results
       WHERE ${where}
       ORDER BY subscribers DESC
       LIMIT $2`,
      params,
    );
    return reply.send(rows);
  });

  /**
   * POST /reddit/post — submits a self post through the logged-in browser.
   * Body: { subreddit, title, body } → { post_id, post_url }.
   */
  app.post("/reddit/post", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    const body = request.body as { subreddit?: string; title?: string; body?: string } | null;
    if (
      typeof body?.subreddit !== "string" || !body.subreddit.trim() ||
      typeof body?.title !== "string" || !body.title.trim() ||
      typeof body?.body !== "string"
    ) {
      return reply.code(400).send({ error: "subreddit, title and body are required" });
    }

    try {
      const result = await getRedditBrowser(opts.pool).submitPost(
        workspaceId as string,
        body.subreddit,
        body.title,
        body.body,
      );
      return reply.send(result);
    } catch (error) {
      return browserErrorReply(reply, error);
    }
  });

  /**
   * POST /reddit/metrics — reads a post's score/upvotes/comments through
   * the logged-in browser. Body: { post_id }.
   */
  app.post("/reddit/metrics", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    const body = request.body as { post_id?: string } | null;
    if (typeof body?.post_id !== "string" || !body.post_id.trim()) {
      return reply.code(400).send({ error: "post_id is required" });
    }

    try {
      const metrics = await getRedditBrowser(opts.pool).getPostMetrics(
        workspaceId as string,
        body.post_id,
      );
      return reply.send(metrics);
    } catch (error) {
      return browserErrorReply(reply, error);
    }
  });
}
