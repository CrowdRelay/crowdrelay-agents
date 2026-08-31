/**
 * Trace-id handling for the cross-service trace spine.
 *
 * `agent_outcomes.trace_id` is a `uuid` column (CrowdRelay migration 0183).
 * The id reaches us from outside — an `X-Trace-Id` header on POST /tasks, or
 * `metadata.trace_id` on a task the Rust autopilot queued — so it is
 * untrusted input. Anything that is not a UUID makes the INSERT fail, and
 * since that insert shares a transaction with the result row it would take
 * the whole run down with it: the model output would be discarded and the
 * task marked failed over a malformed header.
 *
 * Dropping an unusable trace id costs correlation. Keeping it costs the run.
 *
 * No imports here so the node:test runner can load this module directly.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the trace id when it is a well-formed UUID, otherwise null. */
export function normalizeTraceId(traceId: unknown): string | null {
  if (typeof traceId !== "string") return null;
  const trimmed = traceId.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}
