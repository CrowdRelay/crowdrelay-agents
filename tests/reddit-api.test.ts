import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function apiSource(): string {
  return readFileSync(new URL("../src/agent/reddit-api.ts", import.meta.url), "utf8");
}

function routeSource(): string {
  return readFileSync(new URL("../src/routes/reddit.ts", import.meta.url), "utf8");
}

test("the api talks to oauth.reddit.com, not the public json host", () => {
  // Measured from the production host: www and old reddit .json both answer
  // 403 there, and the OAuth token endpoint answers 401. The whole reason
  // this module exists is that one of those is a blocked IP and the other is
  // a missing credential.
  const source = apiSource();
  assert.match(source, /https:\/\/oauth\.reddit\.com/);
  assert.match(source, /https:\/\/www\.reddit\.com\/api\/v1\/access_token/);
  // Reads must go through API_ORIGIN. The public host appears in the header
  // comment as the measurement that ruled it out, so this checks the fetch
  // rather than the prose.
  assert.match(
    source,
    /fetch\(`\$\{API_ORIGIN\}\$\{path\}`/,
    "every api call should be built from API_ORIGIN",
  );
  assert.doesNotMatch(
    source,
    /fetch\(\s*`?https:\/\/(www|old)\.reddit\.com\/r\//,
    "reading subreddits from the public host is the path that is IP-blocked",
  );
});

test("only a 401 from the token endpoint latches the credential off", () => {
  // A 429 or a 5xx is Reddit having a moment. Marking the credential invalid
  // for one of those repeats the failure that kept Reddit down for a month.
  const source = apiSource();
  assert.match(source, /if \(response\.status === 401\) \{/);
  const latchIndex = source.indexOf("markApiCredentialsFailed(this.pool");
  const guardIndex = source.indexOf("if (response.status === 401) {");
  assert.ok(guardIndex !== -1 && latchIndex > guardIndex, "the latch must sit inside the 401 guard");
});

test("a token is renewed before it expires, not after", () => {
  const source = apiSource();
  assert.match(source, /TOKEN_EXPIRY_MARGIN_MS/);
  assert.match(source, /expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > Date\.now\(\)/);
});

test("a mid-session 401 is retried once with a fresh token", () => {
  // Reddit revokes tokens early sometimes. Reporting that as a failure would
  // drop a post the loop had already decided to make.
  const source = apiSource();
  assert.match(source, /this\.tokens\.delete\(workspaceId\)/);
});

test("a submit that reddit refuses is not recorded as a success", () => {
  // /api/submit answers 200 with an errors array for a rule violation or a
  // rate limit. Reading only the HTTP status would file a refused post as a
  // posted one and teach the causal model from an action that never happened.
  const source = apiSource();
  assert.match(source, /errors\.length > 0/);
  assert.match(source, /reddit refused the post/);
});

test("secrets are never returned to the caller", () => {
  const source = routeSource();
  const start = source.indexOf('app.post("/reddit/api-credentials"');
  const end = source.indexOf("app.post(", start + 10);
  const body = source.slice(start, end);
  assert.ok(start !== -1, "the api-credentials route should exist");
  assert.doesNotMatch(body, /client_secret[^:]*:\s*parsed/, "the secret must not be echoed");
  assert.match(body, /stored: true/);
});

test("every reddit route prefers the api and keeps the browser as fallback", () => {
  const source = routeSource();
  for (const route of ["/reddit/observe", "/reddit/post", "/reddit/join", "/reddit/metrics"]) {
    const start = source.indexOf(`app.post("${route}"`);
    assert.ok(start !== -1, `${route} should exist`);
    const end = source.indexOf("app.post(", start + 10);
    const body = source.slice(start, end === -1 ? undefined : end);
    assert.match(
      body,
      /await api\.isConfigured\(workspaceId as string\)/,
      `${route} should try the api first`,
    );
    assert.match(body, /getRedditBrowser\(opts\.pool\)/, `${route} should keep the browser fallback`);
  }
});
