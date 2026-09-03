import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/chat/prompt.ts";

// The assistant navigates by emitting a path, and the browser follows it. When
// the prompt documented routes as `/tenants/{slug}/...`, the model copied the
// placeholder through verbatim and the app went to
// `/tenants/%7Bslug%7D/intelligence`, where the API answered "slug must be 2-63
// lowercase letters, digits or internal hyphens" and the page failed to render.
//
// The client refuses and substitutes such a path now, so this is the second
// line rather than the only one — but a prompt that teaches the mistake is
// still a prompt worth failing the build over.

test("no path example carries a placeholder the model can copy", () => {
  const prompt = buildSystemPrompt("Intelligence page for tenant \"virya\"");
  const paths = prompt.match(/\/tenants\/\S+/g) ?? [];
  assert.ok(paths.length > 0, "the prompt should still document tenant paths");
  for (const path of paths) {
    assert.doesNotMatch(
      path,
      /\{slug\}|%7Bslug%7D/i,
      `${path} is copyable verbatim and produces an invalid slug`,
    );
  }
});

test("the tenant is named in the prompt so a real path can be built", () => {
  const prompt = buildSystemPrompt("Intelligence page for tenant \"virya\"");
  assert.match(prompt, /The user is on: Intelligence page for tenant "virya"/);
  // Without this instruction the model has the slug but no reason to prefer it
  // over the shape it saw in the route listing.
  assert.match(prompt, /must use that slug\s+literally/);
});

test("tenant lifecycle stays out of a tenant-scoped assistant", () => {
  const prompt = buildSystemPrompt(undefined);
  // A tenant operator cannot reach any of these: the routes are behind
  // require_platform_admin, so offering them describes buttons that answer 403.
  assert.match(prompt, /You do NOT create, suspend, deploy, remove or switch between artists/);
  assert.doesNotMatch(prompt, /CREATE A NEW TENANT/i);
  assert.doesNotMatch(prompt, /CREATE OPERATOR ACCOUNTS/i);
});
