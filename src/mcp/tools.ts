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
