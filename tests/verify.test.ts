import { test } from "node:test";
import assert from "node:assert/strict";
// json-extract.ts is import-free, so node:test can load the real parser.
// verify.ts itself uses .js-extension imports and cannot be loaded here, but
// its decision logic lives entirely in parseVerdict.
import { extractJson, parseVerdict } from "../src/agent/json-extract.ts";

// ---------------------------------------------------------------------------
// extractJson — the balanced-object scanner both parsers depend on
// ---------------------------------------------------------------------------

test("extractJson reads a bare JSON object", () => {
  assert.deepEqual(extractJson('{"kind":"press_pitch","items":[]}'), {
    kind: "press_pitch",
    items: [],
  });
});

test("extractJson prefers a fenced block over surrounding prose", () => {
  const raw = 'Here you go:\n```json\n{"passed":true,"issues":[]}\n```\nHope that helps.';
  assert.deepEqual(extractJson(raw), { passed: true, issues: [] });
});

test("extractJson survives braces and quotes inside string values", () => {
  const raw = '{"detail":"use {curly} braces and a \\" quote","n":1}';
  assert.deepEqual(extractJson(raw), {
    detail: 'use {curly} braces and a " quote',
    n: 1,
  });
});

test("extractJson handles nested objects and arrays", () => {
  const raw = 'prose {"a":{"b":[{"c":2}]},"d":"}"} trailing';
  assert.deepEqual(extractJson(raw), { a: { b: [{ c: 2 }] }, d: "}" });
});

test("extractJson returns null for truncated output", () => {
  // The signature of a model that hit its output token limit mid-object.
  assert.equal(extractJson('{"kind":"press_pitch","items":[{"subject":"Nowy'), null);
});

test("extractJson returns null when there is no object at all", () => {
  assert.equal(extractJson("I cannot help with that request."), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson("[1,2,3]"), null);
});

// ---------------------------------------------------------------------------
// parseVerdict — decides whether an outcome ships
// ---------------------------------------------------------------------------

test("parseVerdict reads a passing verdict", () => {
  assert.deepEqual(parseVerdict('{"passed":true,"issues":[]}'), {
    passed: true,
    issues: [],
  });
});

test("parseVerdict reads a rejection with its issues", () => {
  const verdict = parseVerdict(
    '```json\n{"passed":false,"issues":["invented venue Klub X","email not in data"]}\n```',
  );
  assert.equal(verdict?.passed, false);
  assert.deepEqual(verdict?.issues, ["invented venue Klub X", "email not in data"]);
});

test("parseVerdict caps the issue list and drops non-string entries", () => {
  const issues = Array.from({ length: 25 }, (_, i) => `issue ${i}`);
  const verdict = parseVerdict(
    JSON.stringify({ passed: false, issues: [...issues, 42, null, { a: 1 }] }),
  );
  assert.equal(verdict?.issues.length, 10);
  assert.equal(verdict?.issues[0], "issue 0");
});

test("parseVerdict tolerates a missing or malformed issues field", () => {
  assert.deepEqual(parseVerdict('{"passed":true}'), { passed: true, issues: [] });
  assert.deepEqual(parseVerdict('{"passed":false,"issues":"nope"}'), {
    passed: false,
    issues: [],
  });
});

test("parseVerdict returns null when `passed` is not a boolean", () => {
  // Anything unusable must fail OPEN in the runner: an unparseable verifier
  // must never be able to block a run it could not actually evaluate.
  assert.equal(parseVerdict('{"passed":"yes"}'), null);
  assert.equal(parseVerdict('{"verdict":"ok"}'), null);
  assert.equal(parseVerdict('{"passed":1}'), null);
  assert.equal(parseVerdict("The output looks fine to me."), null);
  assert.equal(parseVerdict('{"passed":true'), null);
});
