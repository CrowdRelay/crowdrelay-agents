/**
 * Per-workspace in-process rate limiting.
 *
 * Concurrency is a property of one process, so this stays in memory (the
 * cross-instance spend ceiling is the usage ledger in agent/usage.ts). Two
 * limits are enforced together:
 *
 *  - a concurrent-slot count, claimed synchronously so a burst of requests
 *    cannot all pass the check before any of them increments, and
 *  - a sliding request window, so a client cannot drain a provider's daily
 *    free quota by serialising its calls.
 *
 * A caller that claims a slot MUST later release it (`release`) or hand it
 * back (`refundSlot` + `refundStamp`) when the work never started.
 *
 * This module deliberately has no imports so the node:test runner can load it
 * directly and test the real implementation rather than a copy of it.
 */

export interface RateLimitDecision {
  allowed: boolean;
  reason?: string;
  /** Identifies this request's entry in the window, for `refundStamp`. */
  stamp?: number;
}

export interface RateLimiterOptions {
  maxConcurrent: number;
  maxPerWindow: number;
  /** Sliding window length. Defaults to one hour. */
  windowMs?: number;
  /** Noun used in rejection messages, e.g. "tasks". */
  label?: string;
}

export interface RateLimiter {
  /** Claims a concurrent slot and a window entry, or explains the refusal. */
  check(key: string): RateLimitDecision;
  /** Releases a concurrent slot after the work finished. */
  release(key: string): void;
  /** Hands back a slot claimed by a `check` whose work never started. */
  refundSlot(key: string): void;
  /** Removes this request's window entry so a server-side failure is free. */
  refundStamp(key: string, stamp: number): void;
  /** Drops stale window entries and empty keys. Called by the sweeper. */
  sweep(now?: number): void;
  /** Current concurrent count — exposed for tests and diagnostics. */
  concurrent(key: string): number;
}

const HOUR_MS = 60 * 60 * 1000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { maxConcurrent, maxPerWindow } = options;
  const windowMs = options.windowMs ?? HOUR_MS;
  const label = options.label ?? "requests";

  const running = new Map<string, number>();
  const stamps = new Map<string, number[]>();

  return {
    check(key: string): RateLimitDecision {
      const now = Date.now();
      const windowStart = now - windowMs;

      // Claim the concurrent slot before any await point in the caller, so
      // concurrent requests cannot all observe the pre-increment count.
      const current = running.get(key) ?? 0;
      if (current >= maxConcurrent) {
        return { allowed: false, reason: `too many concurrent ${label} (max ${maxConcurrent})` };
      }
      running.set(key, current + 1);

      const recent = (stamps.get(key) ?? []).filter((t) => t > windowStart);
      if (recent.length >= maxPerWindow) {
        running.set(key, current); // refund the slot we just claimed
        return { allowed: false, reason: `rate limit exceeded (max ${maxPerWindow}/hour)` };
      }

      // A unique stamp so refundStamp removes exactly this entry, not
      // whatever another concurrent request for the same key pushed after it.
      const stamp = now + Math.random();
      recent.push(stamp);
      stamps.set(key, recent);
      return { allowed: true, stamp };
    },

    release(key: string): void {
      const current = running.get(key) ?? 0;
      running.set(key, Math.max(0, current - 1));
    },

    refundSlot(key: string): void {
      const current = running.get(key) ?? 0;
      running.set(key, Math.max(0, current - 1));
    },

    refundStamp(key: string, stamp: number): void {
      const entries = stamps.get(key);
      if (!entries) return;
      const index = entries.lastIndexOf(stamp);
      if (index >= 0) entries.splice(index, 1);
    },

    sweep(now: number = Date.now()): void {
      const windowStart = now - windowMs;
      for (const [key, entries] of stamps) {
        const fresh = entries.filter((t) => t > windowStart);
        if (fresh.length === 0) stamps.delete(key);
        else if (fresh.length !== entries.length) stamps.set(key, fresh);
      }
      for (const [key, count] of running) {
        if (count === 0) running.delete(key);
      }
    },

    concurrent(key: string): number {
      return running.get(key) ?? 0;
    },
  };
}

/**
 * Starts the periodic sweep that keeps the maps from growing unboundedly as
 * new workspaces are seen. Unref'd so it never holds the process open.
 */
export function startRateLimitSweeper(limiters: RateLimiter[], intervalMs = 10 * 60 * 1000): void {
  setInterval(() => {
    for (const limiter of limiters) limiter.sweep();
  }, intervalMs).unref();
}
