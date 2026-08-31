import { test } from "node:test";
import assert from "node:assert/strict";
// The real implementation, not a copy of it: rate-limit.ts is import-free so
// the node:test runner can load it directly. An earlier version of this file
// re-implemented the logic inline, which meant the tests kept passing no
// matter what the shipped limiter did.
import { createRateLimiter } from "../src/routes/rate-limit.ts";

const MAX_CONCURRENT = 5;
const MAX_PER_HOUR = 20;

function limiter() {
  return createRateLimiter({
    maxConcurrent: MAX_CONCURRENT,
    maxPerWindow: MAX_PER_HOUR,
    label: "tasks",
  });
}

test("rate limit: allows up to MAX_CONCURRENT concurrent tasks", () => {
  const rl = limiter();
  const ws = "ws-test-1";

  for (let i = 0; i < MAX_CONCURRENT; i++) {
    assert.equal(rl.check(ws).allowed, true, `task ${i + 1} should be allowed`);
  }
});

test("rate limit: rejects the 6th concurrent task (race-free)", () => {
  const rl = limiter();
  const ws = "ws-test-2";

  // Fill up to max concurrent — no awaits between calls. The slot must be
  // claimed inside check(), before the caller's first await, or a burst of
  // requests all read the same pre-increment count and all pass.
  for (let i = 0; i < MAX_CONCURRENT; i++) rl.check(ws);

  const result = rl.check(ws);
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /too many concurrent/);
});

test("rate limit: allows a new task after one completes", () => {
  const rl = limiter();
  const ws = "ws-test-3";

  for (let i = 0; i < MAX_CONCURRENT; i++) rl.check(ws);
  assert.equal(rl.check(ws).allowed, false);

  rl.release(ws);
  assert.equal(rl.check(ws).allowed, true);
});

test("rate limit: refundSlot restores a slot on failure", () => {
  const rl = limiter();
  const ws = "ws-test-4";

  // check() passes, then the DB insert fails and the caller refunds.
  assert.equal(rl.check(ws).allowed, true);
  rl.refundSlot(ws);
  assert.equal(rl.concurrent(ws), 0);
  assert.equal(rl.check(ws).allowed, true);
});

test("rate limit: refundStamp removes exactly this request's window entry", () => {
  const rl = createRateLimiter({ maxConcurrent: 100, maxPerWindow: 3 });
  const ws = "ws-refund";

  const first = rl.check(ws);
  const second = rl.check(ws);
  rl.check(ws);
  assert.equal(rl.check(ws).allowed, false, "window is full");

  // Refund the FIRST request's stamp, not the most recent one.
  rl.refundStamp(ws, first.stamp!);
  assert.equal(rl.check(ws).allowed, true, "a window slot was freed");

  // A stamp that was never issued must not free anything.
  rl.refundStamp(ws, 12345);
  assert.equal(rl.check(ws).allowed, false);
  assert.notEqual(first.stamp, second.stamp, "stamps are unique per request");
});

test("rate limit: the window cap rejects before the concurrent cap", () => {
  const rl = createRateLimiter({ maxConcurrent: 100, maxPerWindow: 2 });
  const ws = "ws-window";

  assert.equal(rl.check(ws).allowed, true);
  assert.equal(rl.check(ws).allowed, true);
  const blocked = rl.check(ws);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /rate limit exceeded/);
  // A window rejection must hand the concurrent slot back, or a workspace
  // that hits the hourly cap stays permanently at max concurrency.
  assert.equal(rl.concurrent(ws), 2);
});

test("rate limit: different workspaces have independent limits", () => {
  const rl = limiter();

  for (let i = 0; i < MAX_CONCURRENT; i++) rl.check("ws-a");

  assert.equal(rl.check("ws-b").allowed, true);
});

test("rate limit: concurrent count never exceeds MAX_CONCURRENT under burst", () => {
  const rl = limiter();
  const ws = "ws-burst";

  let allowed = 0;
  let rejected = 0;
  for (let i = 0; i < 20; i++) {
    if (rl.check(ws).allowed) allowed++;
    else rejected++;
  }

  assert.equal(allowed, MAX_CONCURRENT, "exactly MAX_CONCURRENT should be allowed");
  assert.equal(rejected, 20 - MAX_CONCURRENT, "the rest should be rejected");
  assert.equal(rl.concurrent(ws), MAX_CONCURRENT);
});

test("rate limit: release never drives the count negative", () => {
  const rl = limiter();
  const ws = "ws-underflow";

  rl.release(ws);
  rl.release(ws);
  assert.equal(rl.concurrent(ws), 0);
  assert.equal(rl.check(ws).allowed, true);
});

test("rate limit: sweep drops entries that aged out of the window", () => {
  const rl = createRateLimiter({ maxConcurrent: 1, maxPerWindow: 1, windowMs: 1000 });
  const ws = "ws-sweep";

  assert.equal(rl.check(ws).allowed, true);
  rl.release(ws);
  assert.equal(rl.check(ws).allowed, false, "still inside the window");
  rl.release(ws);

  // Sweep as if an hour of wall clock had passed.
  rl.sweep(Date.now() + 60 * 60 * 1000);
  assert.equal(rl.check(ws).allowed, true, "the window entry aged out");
});
