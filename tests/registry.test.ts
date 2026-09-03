import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PROVIDERS, providerSummaries } from "../src/providers/registry.ts";

// ---------------------------------------------------------------------------
// Model-id hygiene.
//
// A wrong model id costs nothing at build time and everything at dispatch: the
// provider answers 404 and the worker's run fails. Four ids in this registry
// were wrong when these tests were written — including both OpenRouter free
// models, so the free tier had never worked — and nothing caught them because
// the ids are only strings until a request is made.
//
// The offline checks below are cheap and run everywhere. The live check is
// opt-in: `CHECK_LIVE_MODELS=1 npm test` verifies every OpenRouter id against
// https://openrouter.ai/api/v1/models, which is the only way to catch a slug
// that was renamed upstream.
// ---------------------------------------------------------------------------

const openrouter = PROVIDERS.find(provider => provider.id === "openrouter");
const anthropic = PROVIDERS.find(provider => provider.id === "anthropic");

test("every provider offers at least one model", () => {
  for (const provider of PROVIDERS) {
    assert.ok(
      provider.models.length > 0,
      `provider ${provider.id} lists no models, so it can never be dispatched to`,
    );
  }
});

test("model ids are unique within a provider", () => {
  for (const provider of PROVIDERS) {
    const ids = provider.models.map(model => model.id);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `provider ${provider.id} lists a duplicate model id`,
    );
  }
});

test("no Anthropic model carries a date suffix", () => {
  // Current Anthropic ids are complete as-is: `claude-opus-5`, never
  // `claude-opus-5-20260101`. The dated forms are the retired models that
  // triggered Anthropic's deprecation warnings.
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      assert.doesNotMatch(
        model.id,
        /^(anthropic\/)?claude-.*-\d{8}$/,
        `${provider.id}: ${model.id} is a dated Anthropic id; use the undated current id`,
      );
    }
  }
});

test("no retired Anthropic model is offered", () => {
  const retired = [/claude-3/, /claude-opus-4-1/, /claude-opus-4\.1/, /claude-sonnet-4\b/, /claude-sonnet-4-20/];
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      for (const pattern of retired) {
        assert.doesNotMatch(
          model.id,
          pattern,
          `${provider.id}: ${model.id} is a retired model Anthropic warns about`,
        );
      }
    }
  }
});

test("a free model is priced at zero, and a paid one is not", () => {
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      if (!model.pricing) continue;
      const total = model.pricing.inputPerMTokUsd + model.pricing.outputPerMTokUsd;
      if (model.paid) {
        // An agentic session model bills per agent-compute-unit, not per
        // token, so zero per-token pricing is correct for it — and means
        // `estimateCostMicroUsd` reports $0 for its runs. That is a known
        // blind spot in usage reporting, not a registry error.
        if (model.agentic) continue;
        assert.ok(
          total > 0,
          `${provider.id}: ${model.id} is marked paid but priced at zero`,
        );
      } else {
        assert.equal(
          total,
          0,
          `${provider.id}: ${model.id} is marked free but carries a price`,
        );
      }
    }
  }
});

test("an OpenRouter free model uses the :free suffix", () => {
  assert.ok(openrouter, "the openrouter provider is missing");
  for (const model of openrouter.models) {
    if (model.paid) continue;
    assert.match(
      model.id,
      /:free$/,
      `${model.id} is offered as free but lacks the :free suffix OpenRouter requires`,
    );
  }
});

test("OpenRouter still offers a free model", () => {
  assert.ok(openrouter, "the openrouter provider is missing");
  assert.ok(
    openrouter.models.some(model => !model.paid),
    "the free tier is the only option for a tenant with no budget",
  );
});

test("Anthropic offers a cheap tier, not only the flagship", () => {
  assert.ok(anthropic, "the anthropic provider is missing");
  const cheapest = Math.min(
    ...anthropic.models
      .map(model => model.pricing?.inputPerMTokUsd)
      .filter((price): price is number => typeof price === "number"),
  );
  assert.ok(
    cheapest <= 1,
    `cheapest Anthropic input price is $${cheapest}/MTok; a cheap tier should be offered for high-volume work`,
  );
});

test(
  "every OpenRouter model id resolves upstream",
  { skip: process.env.CHECK_LIVE_MODELS ? false : "set CHECK_LIVE_MODELS=1 to run" },
  async () => {
    assert.ok(openrouter, "the openrouter provider is missing");
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(20_000),
    });
    assert.ok(response.ok, `OpenRouter model list returned ${response.status}`);
    const body = (await response.json()) as { data: { id: string }[] };
    const live = new Set(body.data.map(model => model.id));
    const missing = openrouter.models.map(m => m.id).filter(id => !live.has(id));
    assert.deepEqual(
      missing,
      [],
      `these OpenRouter ids no longer resolve and would 404 at dispatch: ${missing.join(", ")}`,
    );
  },
);

test("a provider blurb never hardcodes model names", () => {
  // The connection screen advertised "Claude Opus 4.1, Sonnet 4" long after the
  // registry moved to Opus 5, and offered "Llama 3.3 70B, Mixtral" from a
  // provider that serves neither. Hand-written lists go stale silently because
  // nothing links them to `models`.
  //
  // `providerSummaries` composes the real model names onto the blurb, so the
  // blurb itself must stay free of them.
  const modelWords = /\b(GPT-4|GPT-4o|o1|o3|Claude|Opus|Sonnet|Haiku|Gemini|Llama|Mixtral|Grok|GLM|Qwen|Nemotron)\b/;
  for (const provider of PROVIDERS) {
    assert.doesNotMatch(
      provider.description,
      modelWords,
      `${provider.id} names models in its blurb; providerSummaries() already ` +
        `prepends the real ones, so this copy can only ever contradict them`,
    );
  }
});

test("the shipped description lists models this provider actually has", () => {
  for (const summary of providerSummaries()) {
    const provider = PROVIDERS.find((p) => p.id === summary.id);
    assert.ok(provider, `unknown provider ${summary.id}`);
    if (provider.models.length === 0) continue;
    assert.ok(
      summary.description.startsWith(provider.models[0].name),
      `${summary.id} description should open with its first real model, got: ` +
        summary.description.slice(0, 60),
    );
  }
});

// ---------------------------------------------------------------------------
// Template model hygiene.
//
// The registry's own ids are checked above. A template's `recommendedModels`
// are the ids a dispatch actually asks for, and nothing checked them: the
// telegram and discord templates shipped naming `claude-sonnet-4-5`,
// `claude-3-5-sonnet` and `gemini-2.5-flash`, none of which the registry
// offers. Production has the receipt for what that costs — a press-pitch run
// failed with
//
//   Anthropic API 404: model: claude-opus-4-1-20250805
//
// which is the same mistake one generation earlier. A recommended model that
// no provider serves is a run that fails at dispatch for a reason nobody sees
// until they read the task row.
//
// The template files are read as text rather than imported: `catalog.ts`
// re-exports them through `.js` specifiers, which the test runner's
// type-stripping loader cannot resolve. The list is a literal in every
// template, so reading it is exact.
// ---------------------------------------------------------------------------

function templateRecommendations(): Array<{ template: string; models: string[] }> {
  const dir = new URL("../src/templates/", import.meta.url);
  const files = readdirSync(dir)
    .filter(name => name.endsWith(".ts") && name !== "catalog.ts");
  return files.map(name => {
    const source = readFileSync(new URL(name, dir), "utf8");
    const match = source.match(/recommendedModels:\s*\[([^\]]*)\]/);
    const models = match
      ? [...match[1].matchAll(/"([^"]+)"/g)].map(m => m[1])
      : [];
    return { template: name.replace(/\.ts$/, ""), models };
  });
}

test("every template recommends models the registry actually serves", () => {
  const known = new Set(
    PROVIDERS.flatMap(provider => provider.models.map(model => model.id)),
  );
  const unknown: string[] = [];
  for (const { template, models } of templateRecommendations()) {
    for (const model of models) {
      if (!known.has(model)) unknown.push(`${template} -> ${model}`);
    }
  }
  assert.deepEqual(
    unknown,
    [],
    `templates recommend models no provider serves:\n  ${unknown.join("\n  ")}`,
  );
});

test("every template recommends at least one model", () => {
  // A template with an empty list falls through to whatever the caller
  // defaults to, which is how a run ends up on a model nobody chose for it.
  for (const { template, models } of templateRecommendations()) {
    assert.ok(models.length > 0, `${template} recommends no model`);
  }
});
