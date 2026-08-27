import type { DbPool } from "../store/db.js";

/**
 * MCP tool definitions. Each tool is a read-only Postgres query scoped to
 * a single workspace_id. The LLM calls these during a session to pull
 * tenant data for seeding its prompt.
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
      limit: {
        type: "number",
        description: "Max events to return (default: 10, max: 50)",
        required: false,
      },
    },
    async execute(pool, workspaceId, params) {
      const status = (params.status as string) ?? "published";
      const rawLimit = Number(params.limit) || 10;
      const limit = Math.max(1, Math.min(rawLimit, 50));
      const validStatuses = ["published", "completed", "all"];
      const safeStatus = validStatuses.includes(status) ? status : "published";
      const statusFilter = safeStatus === "all" ? "IN ('published','completed')" : "= $2";
      const args: unknown[] = [workspaceId];
      if (safeStatus !== "all") args.push(safeStatus);
      args.push(limit);
      const limitParam = `$${args.length}`;
      const { rows } = await pool.query(
        `SELECT e.id, e.title, e.slug, e.starts_at, e.status,
                (SELECT count(*)::int FROM event_interests ei WHERE ei.event_id = e.id) AS interested_fans,
                (SELECT count(DISTINCT tord.buyer_email)::int
                 FROM ticket_orders AS tord
                 JOIN ticket_sales ts ON ts.id = tord.ticket_sale_id
                 WHERE ts.event_id = e.id AND tord.status IN ('paid','partially_refunded')) AS paid_buyers
         FROM events e
         WHERE e.workspace_id = $1 AND e.status ${statusFilter}
         ORDER BY e.starts_at DESC
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
      return rows;
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
    name: "outreach_wave_status",
    description:
      "Get outreach wave status — how many waves are drafting, active, or settled, and their target counts.",
    parameters: {},
    async execute(pool, workspaceId) {
      const { rows } = await pool.query(
        `SELECT state, target_kind, count(*)::int AS count,
                sum(capacity)::int AS total_capacity
         FROM viryaos_outreach_waves
         WHERE workspace_id = $1
         GROUP BY state, target_kind
         ORDER BY state, target_kind`,
        [workspaceId],
      );
      return rows;
    },
  },
  {
    name: "release_plans",
    description:
      "List release plans with their milestones and press/communication status. Helps the LLM write release-related content.",
    parameters: {},
    async execute(pool, workspaceId) {
      const [plans, milestones] = await Promise.all([
        pool.query(
          `SELECT id, source_key, title, release_at, active,
                  assets_ready, communication_enabled, press_enabled, version
           FROM viryaos_release_plans
           WHERE workspace_id = $1
           ORDER BY release_at DESC NULLS LAST
           LIMIT 10`,
          [workspaceId],
        ),
        pool.query(
          `SELECT rm.release_plan_id, rm.title, rm.kind, rm.target_at, rm.completed_at
           FROM viryaos_release_milestones rm
           JOIN viryaos_release_plans rp ON rp.id = rm.release_plan_id
           WHERE rp.workspace_id = $1
           ORDER BY rm.target_at DESC NULLS LAST
           LIMIT 20`,
          [workspaceId],
        ),
      ]);
      return { plans: plans.rows, milestones: milestones.rows };
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
    name: "beacon_signal_summary",
    description:
      "Get beacon signal coverage and engagement data. Shows where the band has signal presence and fan engagement.",
    parameters: {},
    async execute(pool, workspaceId) {
      const [coverage, engagements] = await Promise.all([
        pool.query(
          `SELECT platform, count(*)::int AS profiles,
                  count(*) FILTER (WHERE active = true)::int AS active_profiles
           FROM viryaos_beacon_signal_profiles
           WHERE workspace_id = $1
           GROUP BY platform
           ORDER BY profiles DESC`,
          [workspaceId],
        ),
        pool.query(
          `SELECT event_id, engagement_kind, count(*)::int AS count
           FROM viryaos_beacon_signal_event_engagements
           WHERE workspace_id = $1
             AND created_at > now() - INTERVAL '30 days'
           GROUP BY event_id, engagement_kind
           ORDER BY count DESC
           LIMIT 20`,
          [workspaceId],
        ),
      ]);
      return { signal_coverage: coverage.rows, recent_engagements: engagements.rows };
    },
  },
];

/**
 * Finds a tool by name. Returns undefined if not found.
 */
export function findTool(name: string): McpTool | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Returns tool definitions in the format an LLM expects (OpenAI function calling format).
 */
export function toolDefinitions() {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.parameters,
      },
    },
  }));
}
