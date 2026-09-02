/**
 * Reddit browser timeout budgets.
 *
 * Split out of `reddit-browser.ts` so it can be tested without loading
 * Playwright and a database pool. A wrong value here is expensive: a
 * navigation that times out burns a login attempt, three burnt attempts mark
 * the stored credential `invalid`, and a slow host then looks exactly like a
 * wrong password.
 */

/**
 * Read a millisecond duration from the environment, falling back to `fallback`.
 *
 * A host that got slower should be fixable without a rebuild — waiting on a
 * container image is what kept a 30s budget in production long after the
 * measurement that condemned it.
 *
 * Values that are not positive integers are ignored rather than obeyed. `0`,
 * `-1` and `abc` all coerce to something a timeout will accept, and a 0ms
 * budget fails every navigation instantly, which is the credential-destroying
 * case. A typo must degrade to the default, loudly.
 */
export function envDurationMs(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    warn(
      `[reddit-browser] ignoring ${name}=${raw}: expected a positive integer ` +
        `number of milliseconds; using ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Navigation budget for Reddit pages.
 *
 * 30s was too tight on the production host and every login failed on
 * `page.goto: Timeout 30000ms exceeded`.
 *
 * Measured on that host: Chromium launch 10.3s, example.com 7.8s,
 * reddit.com/login 13.3s, old.reddit.com/login 18.2s, and the first attempt
 * pays the cold launch on top. Reddit is reachable (a plain fetch returns 200
 * in 15ms), the browser is not headless (pid 1 has DISPLAY=:99), and memory is
 * not the constraint (185MiB peak against a 512MiB limit). The host is slow,
 * nothing more.
 *
 * So the budget is generous rather than tight. None of this is interactive —
 * it is background work feeding the brain, and a login that takes minutes is
 * worth far more than one that fails fast and locks the account out. The
 * timeout exists only to stop a wedged page holding a worker forever.
 */
export const PAGE_TIMEOUT_MS = envDurationMs("REDDIT_PAGE_TIMEOUT_MS", 300_000);

/** Session probes are cheap pages, but the same host slowness applies. */
export const SESSION_PROBE_TIMEOUT_MS = envDurationMs(
  "REDDIT_SESSION_PROBE_TIMEOUT_MS",
  120_000,
);

/**
 * How long to wait for an element the flow cannot continue without — the
 * username field, the post title, the editor.
 *
 * Derived from the page budget so raising one raises both. On a host slow
 * enough to need minutes to load a page, hydration is slow too, and a fixed
 * 15s element wait would fail immediately after a navigation that had just
 * succeeded.
 *
 * Probes that ask "is this here?" — the OTP field, the popup event — keep
 * their own short timeouts. Waiting a long time to conclude something is
 * absent stalls the flow for no information.
 */
export const ELEMENT_TIMEOUT_MS = Math.round(PAGE_TIMEOUT_MS / 4);
