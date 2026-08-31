import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTraceId } from "../src/agent/trace.ts";

// agent_outcomes.trace_id is a `uuid` column and the value arrives from
// outside (an X-Trace-Id header, or metadata on an autopilot-queued task).
// A non-UUID reaching the INSERT aborts the transaction that also carries the
// result row — the model output would be thrown away and the task marked
// failed because of a malformed header. Everything unusable must become null.

test("normalizeTraceId accepts a well-formed UUID", () => {
  const id = "0195f2c1-8b3a-7c4d-9e2f-1a2b3c4d5e6f";
  assert.equal(normalizeTraceId(id), id);
});

test("normalizeTraceId is case-insensitive and trims surrounding space", () => {
  assert.equal(
    normalizeTraceId("  0195F2C1-8B3A-7C4D-9E2F-1A2B3C4D5E6F  "),
    "0195F2C1-8B3A-7C4D-9E2F-1A2B3C4D5E6F",
  );
});

test("normalizeTraceId rejects values that would break the uuid column", () => {
  for (const bad of [
    "",
    "   ",
    "not-a-uuid",
    "0195f2c1-8b3a-7c4d-9e2f",              // too short
    "0195f2c1-8b3a-7c4d-9e2f-1a2b3c4d5e6f7", // too long
    "0195f2c1-8b3a-7c4d-9e2f-1a2b3c4d5e6g",  // non-hex digit
    "0195f2c18b3a7c4d9e2f1a2b3c4d5e6f",      // unhyphenated
    "'; DROP TABLE agent_outcomes; --",
  ]) {
    assert.equal(normalizeTraceId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("normalizeTraceId rejects non-string inputs", () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(normalizeTraceId(bad), null);
  }
});
