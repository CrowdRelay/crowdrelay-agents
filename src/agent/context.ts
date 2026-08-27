import type { DbPool } from "../store/db.js";
import { findTool } from "../mcp/tools.js";

/**
 * Budgeted tenant-context builder.
 *
 * Replaces the earlier whole-payload JSON.stringify + string-slice approach:
 * every block is rendered independently, truncation happens by dropping whole
 * rows (never mid-string), higher-priority blocks are filled first, and the
 * report of what was (or wasn't) included is returned so it can be stored in
 * task metadata and debugged later.
 */

export interface DataScopeItem {
  tool: string;
  params?: Record<string, unknown>;
}

export interface ContextBlockResult {
  tool: string;
  label: string;
  priority: number;
  /** 0 when the block was skipped for budget. */
  chars: number;
  truncated: boolean;
  droppedRows: number;
  error?: string;
}

export interface ContextBundle {
  blocks: ContextBlockResult[];
  budgetChars: number;
  usedChars: number;
  /** Tool name → rendered JSON, ready for prompt assembly. */
  data: Record<string, unknown>;
  truncationReport: Array<{ tool: string; chars: number; truncated: boolean; droppedRows: number; error?: string }>;
}

interface BlockPlan {
  priority: 1 | 2 | 3 | 4;
  /** Fraction of the total budget this block may use. */
  share: number;
  maxRows: number;
  label: string;
}

const BLOCK_DEFAULTS: Record<string, BlockPlan> = {
  get_workspace_profile: { priority: 1, share: 0.04, maxRows: 1, label: "Workspace" },
  list_events: { priority: 1, share: 0.16, maxRows: 15, label: "Upcoming & Recent Events" },
  ticket_sales_summary: { priority: 1, share: 0.08, maxRows: 15, label: "Ticket Sales" },
  list_outreach_targets: { priority: 2, share: 0.16, maxRows: 50, label: "Outreach Targets" },
  fan_stats: { priority: 2, share: 0.05, maxRows: 1, label: "Fan Statistics" },
  outreach_wave_status: { priority: 2, share: 0.04, maxRows: 20, label: "Outreach Waves" },
  list_fan_segments: { priority: 2, share: 0.05, maxRows: 20, label: "Fan Segments" },
  campaign_performance: { priority: 2, share: 0.10, maxRows: 10, label: "Campaign Performance" },
  growth_metrics: { priority: 3, share: 0.08, maxRows: 40, label: "Growth Metrics" },
  get_opportunity_board: { priority: 3, share: 0.10, maxRows: 15, label: "Opportunity Board" },
  list_recent_action_outcomes: { priority: 3, share: 0.08, maxRows: 10, label: "Recent Autopilot Outcomes" },
  release_plans: { priority: 3, share: 0.08, maxRows: 10, label: "Release Plans" },
  list_release_campaigns: { priority: 3, share: 0.06, maxRows: 10, label: "Release Campaigns" },
  list_merch_sales: { priority: 3, share: 0.08, maxRows: 20, label: "Recent Merch Sales" },
  beacon_signal_summary: { priority: 4, share: 0.05, maxRows: 20, label: "Beacon Signals" },
  get_agent_history: { priority: 4, share: 0.10, maxRows: 20, label: "Recent Agent Runs" },
};

const UNKNOWN_BLOCK: BlockPlan = { priority: 3, share: 0.06, maxRows: 20, label: "Tenant Data" };

/** Rough chars-per-token for mixed JSON/English content. */
const CHARS_PER_TOKEN = 4;
/** Fraction of the model window usable for seeded context. The rest is
 *  system prompt + operator instruction + generated output. */
const CONTEXT_WINDOW_FRACTION = 0.45;
/** Below this, executing another block is pointless. */
const MIN_BLOCK_BUDGET_CHARS = 600;

export function contextBudgetChars(contextWindow: number): number {
  return Math.floor((contextWindow / CHARS_PER_TOKEN) * CONTEXT_WINDOW_FRACTION);
}

/**
 * Renders one tool result within a character budget. Arrays are truncated
 * from the tail (the SQL already orders rows by relevance); oversized single
 * values are replaced with a marker. Output is always valid JSON.
 */
export function renderBlock(
  value: unknown,
  maxChars: number,
  maxRows: number,
): { rendered: string; truncated: boolean; droppedRows: number } {
  if (JSON.stringify(value).length <= maxChars) {
    return { rendered: JSON.stringify(value), truncated: false, droppedRows: 0 };
  }

  if (Array.isArray(value)) {
    const rows = value.slice(0, maxRows);
    let dropped = value.length - rows.length;
    let candidate = JSON.stringify(rows);
    // Halve until it fits — deterministic, terminates at one row.
    while (candidate.length > maxChars && rows.length > 1) {
      const keep = Math.max(1, Math.floor(rows.length / 2));
      dropped += rows.length - keep;
      rows.length = keep;
      candidate = JSON.stringify(rows);
    }
    if (candidate.length > maxChars) {
      // A single row is too big: keep the shape, not the payload.
      return {
        rendered: JSON.stringify({ note: "row too large to include", sample_keys: rows.length > 0 ? Object.keys(rows[0] as object) : [] }),
        truncated: true,
        droppedRows: dropped,
      };
    }
    if (dropped > 0) {
      // Signal the cut explicitly instead of letting the model assume the
      // list was complete.
      const annotated = { rows, note: `showing ${rows.length} of ${rows.length + dropped} rows` };
      const annotatedJson = JSON.stringify(annotated);
      if (annotatedJson.length <= maxChars) {
        return { rendered: annotatedJson, truncated: true, droppedRows: dropped };
      }
    }
    return { rendered: candidate, truncated: dropped > 0, droppedRows: dropped };
  }

  const compact = JSON.stringify(value);
  if (compact.length <= maxChars) {
    return { rendered: compact, truncated: false, droppedRows: 0 };
  }
  return {
    rendered: JSON.stringify({ note: "value truncated to fit context budget", keys: typeof value === "object" && value !== null ? Object.keys(value) : [] }),
    truncated: true,
    droppedRows: 0,
  };
}

export async function buildContext(params: {
  pool: DbPool;
  workspaceId: string;
  scope: Array<string | DataScopeItem>;
  contextWindow: number;
}): Promise<ContextBundle> {
  const { pool, workspaceId, scope, contextWindow } = params;
  const budget = contextBudgetChars(contextWindow);

  const items: DataScopeItem[] = scope.map((entry) =>
    typeof entry === "string" ? { tool: entry } : entry,
  );

  // Priority order wins the budget; ties keep template order.
  const planned = items.map((item, index) => ({
    item,
    index,
    plan: BLOCK_DEFAULTS[item.tool] ?? UNKNOWN_BLOCK,
  }));
  planned.sort((a, b) => a.plan.priority - b.plan.priority || a.index - b.index);

  const blocks: ContextBlockResult[] = [];
  const data: Record<string, unknown> = {};
  const truncationReport: ContextBundle["truncationReport"] = [];
  let remaining = budget;

  for (const { item, plan } of planned) {
    if (remaining < MIN_BLOCK_BUDGET_CHARS) {
      blocks.push({ tool: item.tool, label: plan.label, priority: plan.priority, chars: 0, truncated: false, droppedRows: 0, error: "skipped: context budget exhausted" });
      truncationReport.push({ tool: item.tool, chars: 0, truncated: true, droppedRows: 0, error: "skipped: context budget exhausted" });
      continue;
    }

    const tool = findTool(item.tool);
    if (!tool) {
      blocks.push({ tool: item.tool, label: plan.label, priority: plan.priority, chars: 0, truncated: false, droppedRows: 0, error: "unknown tool" });
      truncationReport.push({ tool: item.tool, chars: 0, truncated: false, droppedRows: 0, error: "unknown tool" });
      continue;
    }

    try {
      const value = await tool.execute(pool, workspaceId, item.params ?? {});
      const blockBudget = Math.min(Math.floor(budget * plan.share), remaining);
      const { rendered, truncated, droppedRows } = renderBlock(value, blockBudget, plan.maxRows);
      remaining -= rendered.length;
      data[item.tool] = JSON.parse(rendered) as unknown;
      blocks.push({ tool: item.tool, label: plan.label, priority: plan.priority, chars: rendered.length, truncated, droppedRows });
      truncationReport.push({ tool: item.tool, chars: rendered.length, truncated, droppedRows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      blocks.push({ tool: item.tool, label: plan.label, priority: plan.priority, chars: 0, truncated: false, droppedRows: 0, error: "data unavailable" });
      truncationReport.push({ tool: item.tool, chars: 0, truncated: false, droppedRows: 0, error: message });
    }
  }

  const usedChars = Object.values(data).reduce<number>((sum, value) => sum + JSON.stringify(value ?? null).length, 0);
  return { blocks, budgetChars: budget, usedChars, data, truncationReport };
}

/** Renders the bundle into the `## Section` blocks of the user prompt. */
export function renderContextSections(bundle: ContextBundle): string {
  const sections: string[] = [];
  for (const block of bundle.blocks) {
    const value = bundle.data[block.tool];
    if (value === undefined) continue;
    sections.push(`## ${block.label}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  }
  return sections.join("\n\n");
}
