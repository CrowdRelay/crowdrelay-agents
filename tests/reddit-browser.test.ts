import { test } from "node:test";
import assert from "node:assert/strict";
// Dependency-free module (no .js-extension imports) so the node:test runner
// with --experimental-strip-types can load it directly.
import {
  normalizeSubredditName,
  parseSubredditListing,
} from "../src/agent/reddit-scrape-parse.ts";

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
