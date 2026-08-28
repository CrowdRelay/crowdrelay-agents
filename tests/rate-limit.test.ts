import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Rate limit race condition — contract test
//
// The fix changed checkRateLimit to increment runningTaskCount BEFORE any
// await (inside the function itself), not after createTask resolves. This
// test verifies the contract: calling checkRateLimit N times for the same
// workspace in a tight loop (no awaits between calls) must reject the 6th
// call, even if trackTaskEnd hasn't been called yet.
//
// We can't import the private functions from routes/tasks.ts (it uses .js
// imports that node:test can't resolve), so we replicate the exact logic
// here and test it. If the logic in tasks.ts changes, this test must be
// updated to match.
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 5;
const MAX_PER_HOUR = 20;

function createRateLimiter() {
  const runningTaskCount = new Map<string, number>();
  const taskTimestamps = new Map<string, number[]>();

  function checkRateLimit(workspaceId: string): { allowed: boolean; reason?: string; stamp?: number } {
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;

    const running = runningTaskCount.get(workspaceId) ?? 0;
    if (running >= MAX_CONCURRENT) {
      return { allowed: false, reason: `too many concurrent tasks (max ${MAX_CONCURRENT})` };
    }
    // KEY FIX: increment immediately, before any await
    runningTaskCount.set(workspaceId, running + 1);

    const timestamps = (taskTimestamps.get(workspaceId) ?? []).filter((t) => t > hourAgo);
    if (timestamps.length >= MAX_PER_HOUR) {
      runningTaskCount.set(workspaceId, running); // refund
      return { allowed: false, reason: `rate limit exceeded (max ${MAX_PER_HOUR}/hour)` };
    }

    const stamp = now + Math.random();
    timestamps.push(stamp);
    taskTimestamps.set(workspaceId, timestamps);
    return { allowed: true, stamp };
  }

  function trackTaskEnd(workspaceId: string): void {
    const current = runningTaskCount.get(workspaceId) ?? 0;
    runningTaskCount.set(workspaceId, Math.max(0, current - 1));
  }

  function refundConcurrentSlot(workspaceId: string): void {
    const current = runningTaskCount.get(workspaceId) ?? 0;
    runningTaskCount.set(workspaceId, Math.max(0, current - 1));
  }

  return { checkRateLimit, trackTaskEnd, refundConcurrentSlot };
}

test("rate limit: allows up to MAX_CONCURRENT concurrent tasks", () => {
  const { checkRateLimit } = createRateLimiter();
  const ws = "ws-test-1";

  for (let i = 0; i < MAX_CONCURRENT; i++) {
    const result = checkRateLimit(ws);
    assert.equal(result.allowed, true, `task ${i + 1} should be allowed`);
  }
});

test("rate limit: rejects the 6th concurrent task (race-free)", () => {
  const { checkRateLimit } = createRateLimiter();
  const ws = "ws-test-2";

  // Fill up to max concurrent — no awaits between calls
  for (let i = 0; i < MAX_CONCURRENT; i++) {
    checkRateLimit(ws);
  }

  // The 6th must be rejected even though trackTaskEnd hasn't been called
  const result = checkRateLimit(ws);
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /too many concurrent/);
});

test("rate limit: allows new task after one completes", () => {
  const { checkRateLimit, trackTaskEnd } = createRateLimiter();
  const ws = "ws-test-3";

  for (let i = 0; i < MAX_CONCURRENT; i++) checkRateLimit(ws);
  assert.equal(checkRateLimit(ws).allowed, false);

  trackTaskEnd(ws);
  const result = checkRateLimit(ws);
  assert.equal(result.allowed, true);
});

test("rate limit: refundConcurrentSlot restores a slot on failure", () => {
  const { checkRateLimit, refundConcurrentSlot } = createRateLimiter();
  const ws = "ws-test-4";

  // Simulate: checkRateLimit passes, then createTask fails, refund the slot
  const r1 = checkRateLimit(ws);
  assert.equal(r1.allowed, true);

  refundConcurrentSlot(ws);

  // Slot should be available again
  const r2 = checkRateLimit(ws);
  assert.equal(r2.allowed, true);
});

test("rate limit: different workspaces have independent limits", () => {
  const { checkRateLimit } = createRateLimiter();
  const ws1 = "ws-a";
  const ws2 = "ws-b";

  for (let i = 0; i < MAX_CONCURRENT; i++) checkRateLimit(ws1);

  // ws1 is full, ws2 should still have room
  const result = checkRateLimit(ws2);
  assert.equal(result.allowed, true);
});

test("rate limit: concurrent count never exceeds MAX_CONCURRENT under burst", () => {
  const { checkRateLimit } = createRateLimiter();
  const ws = "ws-burst";

  let allowed = 0;
  let rejected = 0;

  // Simulate 20 simultaneous requests (no awaits between them)
  for (let i = 0; i < 20; i++) {
    if (checkRateLimit(ws).allowed) allowed++;
    else rejected++;
  }

  assert.equal(allowed, MAX_CONCURRENT, "exactly MAX_CONCURRENT should be allowed");
  assert.equal(rejected, 20 - MAX_CONCURRENT, "the rest should be rejected");
});
