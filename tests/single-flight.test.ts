import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Single-flight lock — contract test
//
// The OAuth refresh module uses a per-(workspace, provider) single-flight
// lock to prevent concurrent refresh calls from racing on the same refresh
// token. This test verifies the single-flight pattern: when multiple callers
// request the same key concurrently, only one underlying operation runs,
// and all callers receive the same result.
//
// We can't import the private lock from refresh.ts, so we test the pattern
// directly. The implementation in refresh.ts mirrors this exact logic.
// ---------------------------------------------------------------------------

/**
 * Single-flight cache: deduplicates concurrent calls for the same key.
 * Only the first call executes the factory; concurrent callers wait for
 * its result. After completion, the cache entry is cleared so the next
 * call triggers a fresh execution.
 */
function createSingleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>();

  async function run(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = factory().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  return { run, inFlight };
}

test("single-flight: concurrent calls for same key share one execution", async () => {
  let execCount = 0;
  const sf = createSingleFlight<string>();

  // Simulate a slow operation (50ms)
  const factory = async () => {
    execCount++;
    await new Promise((r) => setTimeout(r, 50));
    return `result-${execCount}`;
  };

  // Launch 10 concurrent calls for the same key
  const results = await Promise.all(
    Array.from({ length: 10 }, () => sf.run("ws:provider", factory)),
  );

  // All 10 should receive the same result
  assert.equal(execCount, 1, "factory should execute exactly once");
  results.forEach((r) => assert.equal(r, "result-1"));
});

test("single-flight: different keys execute independently", async () => {
  let execCount = 0;
  const sf = createSingleFlight<string>();

  const factory = (id: string) => async () => {
    execCount++;
    await new Promise((r) => setTimeout(r, 20));
    return id;
  };

  const [a, b, c] = await Promise.all([
    sf.run("key-a", factory("a")),
    sf.run("key-b", factory("b")),
    sf.run("key-c", factory("c")),
  ]);

  assert.equal(execCount, 3);
  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.equal(c, "c");
});

test("single-flight: sequential calls after completion execute fresh", async () => {
  let execCount = 0;
  const sf = createSingleFlight<string>();

  const factory = async () => {
    execCount++;
    await new Promise((r) => setTimeout(r, 10));
    return `result-${execCount}`;
  };

  const r1 = await sf.run("key", factory);
  const r2 = await sf.run("key", factory);

  assert.equal(execCount, 2, "factory should execute twice for sequential calls");
  assert.equal(r1, "result-1");
  assert.equal(r2, "result-2");
});

test("single-flight: error in factory propagates to all waiters", async () => {
  let execCount = 0;
  const sf = createSingleFlight<string>();

  const factory = async () => {
    execCount++;
    await new Promise((r) => setTimeout(r, 10));
    throw new Error("refresh failed");
  };

  // All concurrent callers should receive the error
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => sf.run("key", factory)),
  );

  assert.equal(execCount, 1, "factory should execute once");
  results.forEach((r) => {
    assert.equal(r.status, "rejected");
    assert.match((r as PromiseRejectedResult).reason.message, /refresh failed/);
  });
});

test("single-flight: cache is cleared after error so next call retries", async () => {
  let execCount = 0;
  const sf = createSingleFlight<string>();

  const failingFactory = async () => {
    execCount++;
    throw new Error("fail");
  };

  const successFactory = async () => {
    execCount++;
    return "ok";
  };

  await assert.rejects(sf.run("key", failingFactory));
  // Cache should be cleared — next call should execute fresh
  const result = await sf.run("key", successFactory);
  assert.equal(execCount, 2);
  assert.equal(result, "ok");
});

test("single-flight: in-flight map is empty after all completions", async () => {
  const sf = createSingleFlight<string>();

  const factory = async () => {
    await new Promise((r) => setTimeout(r, 10));
    return "done";
  };

  await Promise.all([
    sf.run("a", factory),
    sf.run("b", factory),
    sf.run("c", factory),
  ]);

  assert.equal(sf.inFlight.size, 0, "in-flight map should be empty after completion");
});
