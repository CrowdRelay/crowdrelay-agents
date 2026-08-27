import type { DbPool } from "../store/db.js";
import type { OutcomeEnvelopeParsed } from "./structured.js";

/**
 * Emits structured LLM outcomes into the `agent_outcomes` handoff table.
 *
 * Ownership contract: the agents service is the ONLY writer of this table.
 * The Rust AgentOutcomeWorker is the only reader/mapper. Rows are keyed by
 * (workspace_id, idempotency_key) so worker retries and task re-runs can
 * never double-create autopilot decisions.
 *
 * The table itself is created by CrowdRelay migration 0124 — the agents
 * service shares the database but does not own this schema.
 */
export async function emitOutcomes(params: {
  pool: DbPool;
  workspaceId: string;
  taskId: string;
  resultId: string;
  envelope: OutcomeEnvelopeParsed;
  client: import("pg").PoolClient;
}): Promise<number> {
  const { workspaceId, taskId, resultId, envelope, client } = params;
  let emitted = 0;

  if (envelope.items.length === 0) {
    await client.query(
      `INSERT INTO agent_outcomes
        (id, workspace_id, task_id, result_id, kind, schema_version, payload,
         confidence_basis_points, idempotency_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
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
      ],
    );
    return 1;
  }

  for (let index = 0; index < envelope.items.length; index++) {
    const item = envelope.items[index];
    const result = await client.query(
      `INSERT INTO agent_outcomes
        (id, workspace_id, task_id, result_id, kind, schema_version, payload,
         confidence_basis_points, idempotency_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [
        workspaceId,
        taskId,
        resultId,
        envelope.kind,
        envelope.schema_version ?? 1,
        JSON.stringify({ item, rationale: envelope.rationale }),
        envelope.confidence_basis_points,
        `agent:${taskId}:${index}`,
      ],
    );
    emitted += result.rowCount ?? 0;
  }
  return emitted;
}
