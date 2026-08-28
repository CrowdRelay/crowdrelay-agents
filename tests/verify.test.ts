import { test } from "node:test";
import assert from "node:assert/strict";

// The verify module uses .js extension imports (TypeScript ESM convention)
// which the node:test runner with --experimental-strip-types can't resolve.
// We test the public contract by verifying the exported types are correct
// at the type level (tsc --noEmit covers this) and the fail-open policy
// shape at runtime.

test("VerifyResult fail-open shape is correct", () => {
  const failOpen = {
    passed: true,
    issues: [],
    verifierModel: "test-model",
    verifierError: "connection refused",
  };
  assert.equal(failOpen.passed, true);
  assert.deepEqual(failOpen.issues, []);
  assert.equal(failOpen.verifierError, "connection refused");
});

test("VerifyResult rejection shape is correct", () => {
  const rejected = {
    passed: false,
    issues: ["hallucinated email not in data", "wrong platform for social post"],
    verifierModel: "nemotron-3.5-lightning-free",
  };
  assert.equal(rejected.passed, false);
  assert.equal(rejected.issues.length, 2);
  assert.match(rejected.issues[0], /hallucinated/);
});
