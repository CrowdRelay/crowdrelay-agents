import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDataQuality } from "../src/agent/data-quality.ts";

// NO EVIDENCE = NO OPPORTUNITY.
//
// The brain must distinguish between two fundamentally different states
// when all data sources come back empty:
//
//   CONNECTOR_ERROR — the search did not actually happen successfully.
//     The tool returned { error: "...", results: [] }. This is an
//     infrastructure/data-quality failure. The operator needs to know
//     their credentials are broken, not that "no data was found".
//
//   NO_RESULTS — the search completed and found nothing. The tool
//     returned { results: [] } with no error field. This is a valid
//     observation: we searched, nothing was there.
//
// Conflating the two was the root cause: a Reddit credential error
// produced 0 evidence and 0% confidence, and the brain still created
// an "awaiting approval" action for "Unnamed target" because it treated
// the connector error as "no results" and let the LLM hallucinate.

test("all connector errors → allConnectorErrors=true, hasUsableData=false", () => {
  const data = {
    search_reddit_communities: { error: "401 Unauthorized", results: [] },
    search_reddit_communities_2: { error: "403 Forbidden", results: [] },
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, false);
  assert.equal(result.allConnectorErrors, true);
});

test("some data, some errors → hasUsableData=true, allConnectorErrors=false", () => {
  const data = {
    search_reddit_communities: { error: "401 Unauthorized", results: [] },
    search_reddit_communities_2: { query: "metal", results: [{ name: "r/metal" }] },
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, true);
  assert.equal(result.allConnectorErrors, false);
});

test("all empty results, no errors → hasUsableData=false, allConnectorErrors=false (NO_RESULTS)", () => {
  const data = {
    search_reddit_communities: { query: "metal", results: [] },
    search_reddit_communities_2: { query: "doom", results: [] },
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, false);
  assert.equal(result.allConnectorErrors, false, "NO_RESULTS is not CONNECTOR_ERROR");
});

test("all non-empty results → hasUsableData=true, allConnectorErrors=false", () => {
  const data = {
    search_reddit_communities: { query: "metal", results: [{ name: "r/metal" }] },
    get_workspace_profile: { slug: "virya", name: "Virya" },
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, true);
  assert.equal(result.allConnectorErrors, false);
});

test("empty data object → hasUsableData=false, allConnectorErrors=false", () => {
  const result = classifyDataQuality({});
  assert.equal(result.hasUsableData, false);
  assert.equal(result.allConnectorErrors, false, "empty data is not a connector error");
});

test("array data with elements → hasUsableData=true", () => {
  const data = {
    list_events: [{ id: "evt-1", title: "Show" }],
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, true);
});

test("array data empty → hasUsableData=false, allConnectorErrors=false (NO_RESULTS)", () => {
  const data = {
    list_events: [],
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, false);
  assert.equal(result.allConnectorErrors, false);
});

test("null values → hasUsableData=false, allConnectorErrors=false", () => {
  const data = {
    get_workspace_profile: null,
    list_events: null,
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, false);
  assert.equal(result.allConnectorErrors, false);
});

test("connector error with null results field → allConnectorErrors=true", () => {
  const data = {
    search_reddit_communities: { error: "timeout", results: null },
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, false);
  assert.equal(result.allConnectorErrors, true);
});

test("connector error with missing results field → allConnectorErrors=true", () => {
  const data = {
    search_reddit_communities: { error: "timeout" },
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, false);
  assert.equal(result.allConnectorErrors, true);
});

test("object with error but non-empty results → hasUsableData=true (partial success)", () => {
  const data = {
    search_reddit_communities: {
      error: "one query failed",
      results: [{ name: "r/metal" }],
    },
  };
  const result = classifyDataQuality(data);
  assert.equal(result.hasUsableData, true, "partial results are usable even with an error");
  assert.equal(result.allConnectorErrors, false);
});
