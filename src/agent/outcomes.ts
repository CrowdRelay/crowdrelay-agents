import { createHash } from "node:crypto";
import type { DbPool } from "../store/db.js";
import type { OutcomeEnvelopeParsed } from "./structured.js";
import { normalizeTraceId } from "./trace.js";

/**
 * Emits structured LLM outcomes into the `agent_outcomes` handoff table.
 *
 * Ownership contract: the agents service is the ONLY writer of this table.
 * The Rust AgentOutcomeWorker is the only reader/mapper. Rows are keyed by
 * (workspace_id, idempotency_key) so worker retries and task re-runs can
 * never double-create autopilot decisions.
 *
 * Content-hash deduplication: each item gets a short hash of its semantic key
 * fields. If a live (unconsumed) row with the same hash already exists for
 * this workspace, the insert is silently skipped — this prevents two
 * different tasks from producing the same idea (e.g. pitching the same event
 * to the same outlet). The brain marks rows as consumed after processing
 * them; consumed rows are deleted by a retention job after 7 days, at which
 * point the same topic can be re-evaluated.
 *
 * The table itself is created by CrowdRelay migration 0125 — the agents
 * service shares the database but does not own this schema.
 */

/**
 * Computes a deterministic content hash from the semantic key fields of an
 * outcome item. The hash identifies "the same idea" across different task
 * runs — two items with the same hash are considered duplicates.
 */
function contentHashForItem(kind: string, item: Record<string, unknown>): string {
  let key: string;
  switch (kind) {
    case "press_pitch":
      key = [
        "press_pitch",
        String(item.subject ?? "").slice(0, 200).toLowerCase().trim(),
        ...(Array.isArray(item.target_refs) ? (item.target_refs as string[]).slice().sort() : []),
      ].join("|");
      break;
    case "social_post":
      key = [
        "social_post",
        String(item.platform ?? ""),
        String(item.text ?? "").slice(0, 200).toLowerCase().trim(),
        String(item.subreddit ?? "").toLowerCase().trim(),
      ].join("|");
      break;
    case "signal_push":
      key = [
        "signal_push",
        String(item.title ?? "").slice(0, 80).toLowerCase().trim(),
        String(item.body ?? "").slice(0, 200).toLowerCase().trim(),
        String(item.event_id ?? "").toLowerCase().trim(),
      ].join("|");
      break;
    case "audience_segments":
      key = ["fan_segment", String(item.name ?? "").toLowerCase().trim()].join("|");
      break;
    case "outreach_targets":
      key = [
        "outreach_target",
        String(item.target_kind ?? ""),
        String(item.display_name ?? "").toLowerCase().trim(),
      ].join("|");
      break;
    case "campaign_insight":
    case "release_plan_note":
    case "generic_insight":
      key = [kind, String(item.headline ?? "").slice(0, 200).toLowerCase().trim()].join("|");
      break;
    default:
      key = `${kind}|${JSON.stringify(item).slice(0, 64)}`;
  }
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export async function emitOutcomes(params: {
  pool: DbPool;
  workspaceId: string;
  taskId: string;
  resultId: string;
  envelope: OutcomeEnvelopeParsed;
  client: import("pg").PoolClient;
  traceId?: string | null;
}): Promise<number> {
  const { workspaceId, taskId, resultId, envelope, client, traceId } = params;
  const traceUuid = normalizeTraceId(traceId);
  let emitted = 0;

  if (envelope.items.length === 0) {
    const envelopeOnly = await client.query(
      `INSERT INTO agent_outcomes
        (id, workspace_id, task_id, result_id, kind, schema_version, payload,
         confidence_basis_points, idempotency_key, trace_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [
        workspaceId,
        taskId,
        resultId,
        envelope.kind,
        envelope.schema_version ?? 1,
        JSON.stringify({ rationale: envelope.rationale, kind: envelope.kind }),
        envelope.confidence_basis_points,
        `agent:${taskId}:envelope`,
        traceUuid,
      ],
    );
    // A re-run of the same task hits the idempotency key and inserts nothing;
    // reporting 1 there would tell the operator an outcome was emitted when
    // none was.
    return envelopeOnly.rowCount ?? 0;
  }

  for (let index = 0; index < envelope.items.length; index++) {
    const item = envelope.items[index];
    const contentHash = contentHashForItem(envelope.kind, item as Record<string, unknown>);
    const result = await client.query(
      `INSERT INTO agent_outcomes
        (id, workspace_id, task_id, result_id, kind, schema_version, payload,
         confidence_basis_points, idempotency_key, content_hash, trace_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING`,
      [
        workspaceId,
        taskId,
        resultId,
        envelope.kind,
        envelope.schema_version ?? 1,
        JSON.stringify({ item, rationale: envelope.rationale }),
        envelope.confidence_basis_points,
        `agent:${taskId}:${index}`,
        contentHash,
        traceUuid,
      ],
    );
    emitted += result.rowCount ?? 0;
  }
  return emitted;
}
