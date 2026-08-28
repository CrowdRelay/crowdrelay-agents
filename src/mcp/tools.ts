import type { DbPool } from "../store/db.js";
import { scrapeRedditQueries } from "../agent/reddit-browser.js";

/**
 * Masks an email for LLM consumption: ab.cd@domain.tld → ab***@domain.tld.
 * The model never needs a raw address — the autopilot resolves recipients. */
export function maskEmail(email: string | null): string | null {
  if (!email || !email.includes("@")) return email;
  const [local, domain] = email.split("@");
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***@${domain}`;
}

/** Masks emails in an arbitrary row object (mutates a copy). */
function maskRowEmails<T extends Record<string, unknown>>(row: T, keys: string[] = ["contact_email"]): T {
  const copy: Record<string, unknown> = { ...row };
  for (const key of keys) {
    const value = copy[key];
    if (typeof value === "string") {
      copy[key] = maskEmail(value) ?? value;
    }
  }
  return copy as T;
}

/**
 * MCP tool definitions. Tools are read-only Postgres queries scoped to a
 * single workspace_id. `search_reddit_communities` reads the browser-scraped
 * reddit_scrape_results table (and triggers a scrape when the query is
 * new) instead of calling Reddit directly — Reddit 403s everything that is
 * not a real browser.
 */

export interface McpTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (pool: DbPool, workspaceId: string, params: Record<string, unknown>) => Promise<unknown>;
}

export const tools: McpTool[] = [
  {
    name: "list_events",
    description:
      "List upcoming or past events for the tenant. Returns title, date, status, and ticket sale counts.",
    parameters: {
      status: {
        type: "string",
        description: "Filter by event status: 'published', 'completed', or 'all' (default: 'published')",
        required: false,
      },
      upcoming: {
        type: "boolean",
        description: "Only return events whose starts_at is in the future (default: false)",
        required: false,
      },
      limit: {
        type: "number",
        description: "Max events to return (default: 10, max: 50)",
        required: false,
      },
    },
    async execute(pool, workspaceId, params) {
      const status = (params.status as string) ?? "published";
      const upcoming = params.upcoming === true || params.upcoming === "true";
      const rawLimit = Number(params.limit) || 10;
      const limit = Math.max(1, Math.min(rawLimit, 50));
      const validStatuses = ["published", "completed", "all"];
      const safeStatus = validStatuses.includes(status) ? status : "published";
      const conditions: string[] = ["e.workspace_id = $1"];
      const args: unknown[] = [workspaceId];
      let paramIdx = 2;
      if (safeStatus === "all") {
        conditions.push("e.status IN ('published','completed')");
      } else {
        conditions.push(`e.status = $${paramIdx}`);
        args.push(safeStatus);
        paramIdx++;
      }
      if (upcoming) {
        conditions.push("e.starts_at > now()");
      }
      args.push(limit);
      const limitParam = `$${paramIdx}`;
      const where = conditions.join(" AND ");
      const { rows } = await pool.query(
        `SELECT e.id, e.title, e.slug, e.starts_at, e.status,
                (SELECT count(*)::int FROM event_interests ei WHERE ei.event_id = e.id) AS interested_fans,
                (SELECT count(DISTINCT tord.buyer_email)::int
                 FROM ticket_orders AS tord
                 JOIN ticket_sales ts ON ts.id = tord.ticket_sale_id
                 WHERE ts.event_id = e.id AND tord.status IN ('paid','partially_refunded')) AS paid_buyers
         FROM events e
         WHERE ${where}
         ORDER BY e.starts_at ${upcoming ? "ASC" : "DESC"}
         LIMIT ${limitParam}`,
        args,
      );
      return rows;
    },
  },
  {
    name: "list_outreach_targets",
    description:
      "List outreach targets (media, radio, playlists, etc.) with their status, kind, and relationship score.",
    parameters: {
      kind: {
        type: "string",
        description: "Filter by target kind: 'press', 'radio', 'playlist', 'media_patronage', 'endorsement', 'creator', or 'all' (default: 'all')",
        required: false,
      },
      active_only: {
        type: "boolean",
        description: "Only return active targets (default: true)",
        required: false,
      },
    },
    async execute(pool, workspaceId, params) {
      const rawKind = params.kind as string | undefined;
      const validKinds = ["press", "radio", "playlist", "media_patronage", "endorsement", "creator", "all"];
      const kind = rawKind && validKinds.includes(rawKind) ? rawKind : undefined;
      const activeOnly = (params.active_only as boolean) ?? true;
      const conditions = ["workspace_id = $1"];
      const args: unknown[] = [workspaceId];
      if (kind && kind !== "all") {
        args.push(kind);
        conditions.push(`target_kind = $${args.length}`);
      }
      if (activeOnly) {
        conditions.push("active = true");
      }
      const { rows } = await pool.query(
        `SELECT id, target_kind, display_name, contact_email,
                verified, accepts_outreach, do_not_contact,
                relationship_score, last_reply_disposition, last_reply_at,
                active, created_at
         FROM viryaos_outreach_targets
         WHERE ${conditions.join(" AND ")}
         ORDER BY relationship_score DESC NULLS LAST, display_name
         LIMIT 50`,
        args,
      );
      // Emails are masked: the LLM references targets by id; the autopilot
      // (never the model) resolves the real recipient at execution time.
      return rows.map((row) => maskRowEmails(row as Record<string, unknown>));
    },
  },
  {
    name: "fan_stats",
    description:
      "Get aggregate fan statistics: total, active, new in last 7/30 days, breakdown by acquisition source.",
    parameters: {},
    async execute(pool, workspaceId) {
      const [totals, sources, recent] = await Promise.all([
        pool.query(
          `SELECT
             count(*)::int AS total_fans,
             count(*) FILTER (WHERE status = 'active')::int AS active_fans,
             count(*) FILTER (WHERE created_at > now() - INTERVAL '7 days')::int AS new_7d,
             count(*) FILTER (WHERE created_at > now() - INTERVAL '30 days')::int AS new_30d
           FROM fans WHERE workspace_id = $1`,
          [workspaceId],
        ),
        pool.query(
          `SELECT source, count(*)::int AS count
           FROM fan_acquisition_events
           WHERE workspace_id = $1
           GROUP BY source ORDER BY count DESC`,
          [workspaceId],
        ),
        pool.query(
          `SELECT count(*)::int AS total_referrals,
                  count(*) FILTER (WHERE status = 'qualified')::int AS qualified,
                  count(*) FILTER (WHERE status = 'converted')::int AS converted
           FROM referral_attributions
           WHERE workspace_id = $1`,
          [workspaceId],
        ),
      ]);
      return {
        totals: totals.rows[0],
        acquisition_sources: sources.rows,
        referrals: recent.rows[0],
      };
    },
  },
  {
    name: "list_merch_sales",
    description:
      "List recent merch orders with product details, revenue, and fulfillment status. Useful for analyzing what sells and where.",
    parameters: {
      limit: {
        type: "number",
        description: "Max orders to return (default: 20, max: 50)",
        required: false,
      },
    },
    async execute(pool, workspaceId, params) {
      const rawLimit = Number(params.limit) || 20;
      const limit = Math.max(1, Math.min(rawLimit, 50));
      // A merch order fact points at an inventory_reservations row, not a
      // merch_variants row. The variant is reached through the
      // inventory_reservation_items join table (one order can hold several
      // variants, so we aggregate quantity and concatenate product names).
      const { rows } = await pool.query(
        `SELECT mof.id, mof.fulfillment_mode, mof.currency, mof.amount_gross_minor,
                mof.goods_gross_minor, mof.shipping_gross_minor, mof.confirmed_at,
                string_agg(DISTINCT mp.name, ', ') AS product_names,
                string_agg(DISTINCT mv.label, ', ') AS variant_labels,
                sum(item.quantity)::int AS total_quantity,
                e.title AS event_title
         FROM merch_order_facts mof
         LEFT JOIN inventory_reservation_items item
           ON item.workspace_id = mof.workspace_id
          AND item.reservation_id = mof.inventory_reservation_id
         LEFT JOIN merch_variants mv
           ON mv.workspace_id = item.workspace_id AND mv.id = item.variant_id
         LEFT JOIN merch_products mp
           ON mp.workspace_id = mv.workspace_id AND mp.id = mv.product_id
         LEFT JOIN events e ON e.id = mof.event_id
         WHERE mof.workspace_id = $1
         GROUP BY mof.id, mof.fulfillment_mode, mof.currency, mof.amount_gross_minor,
                  mof.goods_gross_minor, mof.shipping_gross_minor, mof.confirmed_at,
                  mof.created_at, e.title
         ORDER BY mof.created_at DESC
         LIMIT $2`,
        [workspaceId, limit],
      );
      return rows;
    },
  },
  {
    name: "campaign_performance",
    description:
      "Get communication campaign performance: delivery rates, open/click stats, and active campaigns. Helps the LLM suggest campaign improvements.",
    parameters: {},
    async execute(pool, workspaceId) {
      const [active, stats] = await Promise.all([
        pool.query(
          `SELECT id, title, status, created_at
           FROM communication_campaigns
           WHERE workspace_id = $1 AND status IN ('draft', 'sending', 'active')
           ORDER BY created_at DESC LIMIT 10`,
          [workspaceId],
        ),
        pool.query(
          `SELECT cc.title,
                  count(d.id)::int AS total_deliveries,
                  count(d.id) FILTER (WHERE d.status = 'delivered')::int AS delivered,
                  count(d.id) FILTER (WHERE d.status = 'failed')::int AS failed,
                  count(d.id) FILTER (WHERE d.status = 'pending')::int AS pending
           FROM communication_campaigns cc
           LEFT JOIN communication_campaign_deliveries d ON d.campaign_id = cc.id
           WHERE cc.workspace_id = $1
           GROUP BY cc.title
           ORDER BY total_deliveries DESC
           LIMIT 10`,
          [workspaceId],
        ),
      ]);
      return { active_campaigns: active.rows, performance: stats.rows };
    },
  },
  {
    name: "growth_metrics",
    description:
      "Get growth metric series and recent data points. Shows what the autopilot is tracking and recent trends.",
    parameters: {},
    async execute(pool, workspaceId) {
      const [series, recentPoints] = await Promise.all([
        pool.query(
          `SELECT platform, metric_key, display_name, direction, value_tier, active
           FROM viryaos_growth_metric_series
           WHERE workspace_id = $1 AND active = true
           ORDER BY platform, metric_key`,
          [workspaceId],
        ),
        pool.query(
          `SELECT s.platform, s.metric_key, s.display_name,
                  p.value, p.observed_at
           FROM viryaos_growth_metric_points p
           JOIN viryaos_growth_metric_series s ON s.id = p.series_id
           WHERE s.workspace_id = $1 AND s.active = true
             AND p.observed_at > now() - INTERVAL '30 days'
           ORDER BY p.observed_at DESC
           LIMIT 50`,
          [workspaceId],
        ),
      ]);
      return {
        tracked_series: series.rows,
        recent_points: recentPoints.rows,
      };
    },
  },
  {
    name: "ticket_sales_summary",
    description:
      "Get ticket sales summary by event: total sold, revenue, and remaining capacity. Useful for writing urgency-driven content.",
    parameters: {},
    async execute(pool, workspaceId) {
      const { rows } = await pool.query(
        `SELECT e.id, e.title, e.starts_at,
                count(DISTINCT tord.id)::int AS total_orders,
                sum(tord.total_minor)::bigint AS revenue_minor,
                count(DISTINCT tord.buyer_email)::int AS unique_buyers,
                max(tord.created_at) AS last_sale_at
         FROM events e
         LEFT JOIN ticket_sales ts ON ts.event_id = e.id
         LEFT JOIN ticket_orders tord ON tord.ticket_sale_id = ts.id
              AND tord.status IN ('paid', 'partially_refunded')
         WHERE e.workspace_id = $1 AND e.status = 'published'
         GROUP BY e.id, e.title, e.starts_at
         ORDER BY e.starts_at ASC
         LIMIT 15`,
        [workspaceId],
      );
      return rows;
    },
  },
  {
    name: "get_workspace_profile",
    description:
      "Workspace identity: name, slug, market locale hints from tenant settings. Use to match output language and tone.",
    parameters: {},
    async execute(pool, workspaceId) {
      const { rows } = await pool.query(
        `SELECT w.id, w.slug, w.name,
                COALESCE(
                  (SELECT jsonb_object_agg(key, value) FROM tenant_settings ts WHERE ts.workspace_id = w.id),
                  '{}'::jsonb
                ) AS settings
         FROM workspaces w WHERE w.id = $1`,
        [workspaceId],
      );
      return rows[0] ?? { error: "workspace not found" };
    },
  },
  {
    name: "get_opportunity_board",
    description:
      "Open autopilot decisions and actions awaiting operator attention: what the system is considering, with confidence and reasons. Use to align suggestions with existing plans instead of duplicating them.",
    parameters: {},
    async execute(pool, workspaceId) {
      const [decisions, awaiting] = await Promise.all([
        pool.query(
          `SELECT decision_key, context, decision_kind, subject_kind,
                  confidence_basis_points, disposition, reason, evaluated_at
           FROM viryaos_autopilot_decisions
           WHERE workspace_id = $1
             AND disposition IN ('require_approval', 'recommend_only')
             AND evaluated_at > now() - INTERVAL '14 days'
           ORDER BY evaluated_at DESC
           LIMIT 15`,
          [workspaceId],
        ),
        pool.query(
          `SELECT action_kind, subject_kind, status, created_at
           FROM viryaos_autopilot_actions
           WHERE workspace_id = $1 AND status = 'awaiting_approval'
           ORDER BY created_at DESC
           LIMIT 15`,
          [workspaceId],
        ),
      ]);
      return { open_decisions: decisions.rows, awaiting_approval: awaiting.rows };
    },
  },
  {
    name: "list_recent_action_outcomes",
    description:
      "What the autopilot executed recently and whether it worked: finished actions with status and last errors, from the last 30 days.",
    parameters: {},
    async execute(pool, workspaceId) {
      const { rows } = await pool.query(
        `SELECT action_kind, subject_kind, status, finished_at, last_error_kind, created_at
         FROM viryaos_autopilot_actions
         WHERE workspace_id = $1
           AND status IN ('succeeded', 'failed')
           AND finished_at > now() - INTERVAL '30 days'
         ORDER BY finished_at DESC
         LIMIT 10`,
        [workspaceId],
      );
      return rows;
    },
  },
  {
    name: "get_agent_history",
    description:
      "Recent agent (LLM) task runs and what happened to their outcomes: template, model, status, and whether the outcome was processed or rejected. This is the feedback loop — study it to improve proposals.",
    parameters: {
      limit: {
        type: "number",
        description: "Max runs to return (default: 10, max: 20)",
        required: false,
      },
    },
    async execute(pool, workspaceId, params) {
      const limit = Math.max(1, Math.min(Number(params.limit) || 10, 20));
      const { rows } = await pool.query(
        `SELECT t.template_id, t.model_id, t.status, t.created_at,
                o.kind AS outcome_kind, o.status AS outcome_status,
                o.confidence_basis_points, o.rejection_reason
         FROM agent_service_tasks t
         LEFT JOIN agent_outcomes o ON o.task_id = t.id AND o.workspace_id = t.workspace_id
         WHERE t.workspace_id = $1
         ORDER BY t.created_at DESC
         LIMIT $2`,
        [workspaceId, limit],
      );
      return rows;
    },
  },
  {
    name: "list_fan_segments",
    description:
      "Fan segments proposed by agents and accepted into the workspace: name, description, size estimate, criteria.",
    parameters: {},
    async execute(pool, workspaceId) {
      const { rows } = await pool.query(
        `SELECT name, description, size_estimate, criteria, created_at
         FROM agent_fan_segments
         WHERE workspace_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [workspaceId],
      );
      return rows;
    },
  },
  {
    name: "list_community_post_metrics",
    description:
      "Get aggregated performance history for community posts (Reddit). Shows average upvotes, comments, and score per subreddit from recent posts. Use this to avoid posting to communities with near-zero engagement and to match what worked in communities that responded well.",
    parameters: {},
    async execute(pool, workspaceId) {
      const { rows } = await pool.query(
        `WITH latest_per_post AS (
            SELECT DISTINCT ON (cpm.community_post_id)
                cpm.community_post_id,
                cpm.score,
                cpm.upvotes,
                cpm.num_comments,
                cpm.upvote_ratio,
                cp.subreddit
            FROM community_post_metrics cpm
            JOIN community_posts cp ON cp.id = cpm.community_post_id
            WHERE cp.workspace_id = $1
              AND cp.posted_at > now() - INTERVAL '30 days'
            ORDER BY cpm.community_post_id, cpm.measured_at DESC
        )
        SELECT subreddit,
               COUNT(*)::int AS post_count,
               AVG(score)::double precision AS avg_score,
               AVG(upvotes)::double precision AS avg_upvotes,
               AVG(num_comments)::double precision AS avg_comments,
               AVG(upvote_ratio)::double precision AS avg_upvote_ratio
        FROM latest_per_post
        GROUP BY subreddit
        ORDER BY avg_score DESC`,
        [workspaceId],
      );
      return rows;
    },
  },
  {
    name: "search_reddit_communities",
    description:
      "Search Reddit for subreddits matching a query. Returns real subreddit names, subscriber counts, descriptions, and URLs. Results come from the browser-scraped reddit_scrape_results table; if the query has no stored results yet, a scrape is triggered first (may take up to a minute on first run). Use this to find communities where the band could engage — do NOT hallucinate subreddit names.",
    parameters: {
      query: {
        type: "string",
        description: "Search query (e.g. 'metal polska', 'alternative rock europe', 'doom metal')",
        required: true,
      },
      limit: {
        type: "number",
        description: "Max subreddits to return (default: 10, max: 25)",
        required: false,
      },
    },
    async execute(pool, workspaceId, params) {
      const rawQuery = typeof params.query === "string"
        ? params.query
        : params.query != null ? String(params.query) : "";
      const query = rawQuery.trim();
      if (!query) {
        return { error: "query is required", results: [] };
      }
      const rawLimit = Number(params.limit ?? 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(1, Math.floor(rawLimit)), 25)
        : 10;

      const readResults = async () =>
        (
          await pool.query(
            `SELECT subreddit_name, display_name, description, subscribers, url
             FROM reddit_scrape_results
             WHERE workspace_id = $1 AND query = $2 AND over18 = false
             ORDER BY subscribers DESC
             LIMIT $3`,
            [workspaceId, query, limit],
          )
        ).rows;

      let rows = await readResults();
      if (rows.length === 0) {
        // First time this query is used — scrape it now through the
        // browser. Results land in reddit_scrape_results and are reused
        // by every later reader (worker, ticker, other agents).
        const outcome = await scrapeRedditQueries(pool, workspaceId, [query], limit);
        if (outcome.results.length === 0 && outcome.errors.length > 0) {
          return { query, error: outcome.errors.join(" | "), results: [] };
        }
        rows = await readResults();
      }
      return {
        query,
        results: rows.map((row) => ({
          name: `r/${row.subreddit_name}`,
          title: row.display_name || row.subreddit_name,
          description: (row.description ?? "").slice(0, 200),
          subscribers: row.subscribers,
          url: row.url,
        })),
      };
    },
  },
];

/**
 * Finds a tool by name. Returns undefined if not found.
 */
export function findTool(name: string): McpTool | undefined {
  return tools.find((t) => t.name === name);
}


