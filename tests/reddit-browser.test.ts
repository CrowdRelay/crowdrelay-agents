import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Dependency-free module (no .js-extension imports) so the node:test runner
// with --experimental-strip-types can load it directly.
import {
  normalizeSubredditName,
  parseSubredditListing,
} from "../src/agent/reddit-scrape-parse.ts";
import {
  envDurationMs,
  PAGE_TIMEOUT_MS,
  ELEMENT_TIMEOUT_MS,
} from "../src/agent/reddit-timeouts.ts";

function listing(children: Array<Record<string, unknown>>) {
  return { data: { children: children.map((data) => ({ data })) } };
}

test("normalizeSubredditName strips prefixes and casing", () => {
  assert.equal(normalizeSubredditName("r/Metal"), "metal");
  assert.equal(normalizeSubredditName("/r/DoomMetal"), "doommetal");
  assert.equal(normalizeSubredditName("Metal_Polska"), "metal_polska");
  assert.equal(normalizeSubredditName("  r/Space  "), "space");
});

test("parseSubredditListing maps the listing shape into scrape rows", () => {
  const body = listing([
    {
      display_name_prefixed: "r/Metal",
      title: "All things Metal",
      public_description: "Heavy metal discussion",
      subscribers: 2_400_000,
      over18: false,
      url: "/r/Metal/",
    },
    {
      display_name_prefixed: "r/tiny",
      title: "Tiny sub",
      subscribers: 42,
      over18: false,
    },
  ]);
  const rows = parseSubredditListing(body, 10);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { name: rows[0].subreddit_name, url: rows[0].url, subs: rows[0].subscribers },
    { name: "metal", url: "https://www.reddit.com/r/metal", subs: 2_400_000 },
  );
  assert.equal(rows[0].display_name, "All things Metal");
  assert.equal(rows[1].display_name, "Tiny sub");
});

test("parseSubredditListing drops NSFW entries and caps at limit", () => {
  const body = listing([
    { display_name_prefixed: "r/nsfw1", over18: true, subscribers: 9_999 },
    { display_name_prefixed: "r/keep1", subscribers: 10 },
    { display_name_prefixed: "r/keep2", subscribers: 20 },
    { display_name_prefixed: "r/keep3", subscribers: 30 },
  ]);
  const rows = parseSubredditListing(body, 2);
  assert.deepEqual(
    rows.map((r) => r.subreddit_name),
    ["keep1", "keep2"],
  );
  assert.ok(rows.every((r) => r.over18 === false));
});

test("parseSubredditListing survives malformed bodies and bad counts", () => {
  assert.deepEqual(parseSubredditListing(null, 10), []);
  assert.deepEqual(parseSubredditListing({}, 10), []);
  assert.deepEqual(parseSubredditListing({ data: { children: [{}] } }, 10), []);
  const body = listing([
    { display_name_prefixed: "r/neg", subscribers: -5 },
    { display_name_prefixed: "r/float", subscribers: 12.7 },
  ]);
  const rows = parseSubredditListing(body, 10);
  assert.equal(rows[0].subscribers, 0);
  assert.equal(rows[1].subscribers, 12);
});

// ---------------------------------------------------------------------------
// Timeout budgets
// ---------------------------------------------------------------------------

test("a malformed timeout falls back instead of becoming 0ms", () => {
  // Every one of these coerces to something a Playwright timeout accepts, and
  // a 0ms budget fails every navigation instantly — which burns all three
  // login attempts and marks a working credential invalid. A typo in .env must
  // not be able to destroy the account that way.
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  for (const bad of ["0", "-1", "abc", "12.5", "1e400", " "]) {
    assert.equal(
      envDurationMs("REDDIT_PAGE_TIMEOUT_MS", 300_000, { REDDIT_PAGE_TIMEOUT_MS: bad }, warn),
      300_000,
      `${JSON.stringify(bad)} should fall back to the default`,
    );
  }
  // " " is blank, not malformed, so it is not worth a warning.
  assert.equal(warnings.length, 5, "each malformed value should warn once");
});

test("a valid timeout override is honoured", () => {
  assert.equal(
    envDurationMs("REDDIT_PAGE_TIMEOUT_MS", 300_000, { REDDIT_PAGE_TIMEOUT_MS: "600000" }),
    600_000,
  );
  assert.equal(envDurationMs("REDDIT_PAGE_TIMEOUT_MS", 300_000, {}), 300_000);
});

test("the navigation budget covers the slowest measured production page", () => {
  // Measured on the production host: Chromium launch 10.3s plus
  // old.reddit.com/login 18.2s, and a first attempt pays both. The old 30s
  // budget left no margin at all and every login failed on it.
  assert.ok(
    PAGE_TIMEOUT_MS >= 120_000,
    `navigation budget ${PAGE_TIMEOUT_MS}ms is too tight for the production ` +
      `host; a login that times out marks working credentials invalid`,
  );
  assert.ok(
    ELEMENT_TIMEOUT_MS >= 30_000,
    "element waits must scale with the page budget; hydration is slow on the " +
      "same host that makes navigation slow",
  );
});

// ---------------------------------------------------------------------------
// Login navigation
// ---------------------------------------------------------------------------

test("the post-login wait does not match the login page itself", () => {
  // `waitForURL(/reddit\.com/)` looked like "wait until we are on Reddit" and
  // was really "return immediately": the browser is already standing on
  // reddit.com/login/ when it runs. The session probe then ran before the
  // login completed, reported "login completed but the session is not valid"
  // three times, and marked working credentials invalid.
  //
  // Pinned as a predicate over the pathname, because any pattern that a
  // /login URL satisfies reintroduces the bug while reading as a fix.
  // Scoped to the Reddit-native login. The Google path also waits for
  // reddit.com, and there it is correct: that browser is sitting on
  // accounts.google.com and genuinely waiting to come back.
  const source = readFileSync(
    new URL("../src/agent/reddit-browser.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("private async loginWithReddit");
  const end = source.indexOf("private async loginWithGoogle");
  assert.ok(start !== -1 && end > start, "loginWithReddit not found");
  const body = source.slice(start, end);
  assert.doesNotMatch(
    body,
    /await page\.waitForURL\(\/reddit/,
    "the post-login wait matches reddit.com, which the login page already is",
  );
  assert.match(
    body,
    /waitForURL\(\(url\) =>/,
    "the post-login wait should be a predicate over the URL it must leave",
  );
});

test("a login that never leaves /login is reported as a rejection", () => {
  // Timing out silently would put us back where we started: an invalid
  // credential and no idea whether the password was wrong or the page hung.
  const source = readFileSync(
    new URL("../src/agent/reddit-browser.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /did not leave the login page/);
});

test("the session probe explains why it said no", () => {
  // A bare `return false` surfaces as "login completed but the session is not
  // valid", and three of those mark the credential invalid — so the one place
  // that knows whether this was a timeout, a 403 or a redirect must not throw
  // that away.
  const source = readFileSync(
    new URL("../src/agent/reddit-browser.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /session probe failed: /);
  assert.match(source, /\/me\.json returned /);
  assert.doesNotMatch(
    source,
    /\n    \} catch \{\n      return false;\n    \}\n  \}/,
    "the probe swallows its error again",
  );
});
