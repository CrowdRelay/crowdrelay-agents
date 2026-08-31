/**
 * Reddit routes.
 *
 * Two eras coexist here:
 *  - Cookie management (/reddit/status, /reddit/cookies):
 *    cookies for the Rust worker's reqwest calls. Kept as a fallback path.
 *  - Browser-as-API (/reddit/credentials, /reddit/scrape, /reddit/post,
 *    /reddit/metrics, /reddit/scrape/results): the preferred path. A
 *    persistent logged-in browser in this service does all Reddit work;
 *    the Rust worker and MCP tools only read the DB or call these endpoints.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { extractWorkspaceId } from "../auth.js";
import type { DbPool } from "../store/db.js";
import {
  getRedditCookies,
  getRedditCookieStatus,
} from "../agent/reddit-scraper.js";
import {
  RedditBrowserError,
  MAX_SCRAPE_LIMIT,
  getRedditBrowser,
  scrapeRedditQueries,
  storeRedditCredentials,
  type RedditCredentials,
} from "../agent/reddit-browser.js";

// Reddit usernames are 3-20 chars of [A-Za-z0-9_-]. Validating the shape here
// keeps a typo from becoming a login attempt (and a failed-credential mark)
// and bounds what gets sealed into the encrypted blob.
const redditCredentialsSchema = z.object({
  reddit_username: z.string().trim().min(3).max(20).regex(
    /^[A-Za-z0-9_-]+$/,
    "reddit_username may only contain letters, digits, underscores and hyphens",
  ),
  reddit_password: z.string().min(1).max(200),
});

const scrapeSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  limit: z.number().int().positive().optional(),
});

const postSchema = z.object({
  subreddit: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(40_000),
});

const metricsSchema = z.object({
  post_id: z.string().trim().min(1).max(50),
});

export function registerRedditRoutes(
  app: FastifyInstance,
  opts: {
    pool: DbPool;
    authKey: string;
    encryptionKey: string;
    previousEncryptionKey: string | null;
  },
) {
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

  // -------------------------------------------------------------------------
  // Browser-as-API endpoints
  // -------------------------------------------------------------------------

  /**
   * POST /reddit/credentials — stores Reddit login credentials (encrypted).
   * Accepts a Reddit username/password (preferred: fewer bot checks).
   * Never returns secrets.
   */
  app.post("/reddit/credentials", async (request, reply) => {
    const { workspaceId, errorReply } = requireWorkspaceId(request);
    if (errorReply) return reply.code(errorReply.statusCode).send({ error: errorReply.message });

    const parsed = redditCredentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "provide reddit_username + reddit_password",
      });
    }

    const credentials: RedditCredentials = {
      reddit_username: parsed.data.reddit_username,
      reddit_password: parsed.data.reddit_password,
    };

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

    const parsed = scrapeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "queries (1-10 non-empty strings) is required",
      });
    }

    try {
      const outcome = await scrapeRedditQueries(
        opts.pool,
        workspaceId as string,
        parsed.data.queries,
        Math.min(parsed.data.limit ?? 10, MAX_SCRAPE_LIMIT),
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

    const parsed = postSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "subreddit, title and body are required",
      });
    }

    try {
      const result = await getRedditBrowser(opts.pool).submitPost(
        workspaceId as string,
        parsed.data.subreddit,
        parsed.data.title,
        parsed.data.body,
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

    const parsed = metricsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? "post_id is required",
      });
    }

    try {
      const metrics = await getRedditBrowser(opts.pool).getPostMetrics(
        workspaceId as string,
        parsed.data.post_id,
      );
      return reply.send(metrics);
    } catch (error) {
      return browserErrorReply(reply, error);
    }
  });
}
