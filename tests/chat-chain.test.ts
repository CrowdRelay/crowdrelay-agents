import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChatChain, type ChatOpts } from "../src/chat/chain.ts";
import type { DbPool } from "../src/store/db.ts";

// Minimal mock pool — buildChatChain only calls query() for connected
// providers and credentials. We stub both with in-memory maps.
function mockPool(
  connected: string[] = [],
  creds: Record<string, string> = {},
): DbPool {
  const queryResult = (text: string, params: unknown[]) => {
    if (text.includes("SELECT provider FROM agent_service_credentials")) {
      return { rows: connected.map((provider) => ({ provider })) };
    }
    if (text.includes("SELECT * FROM agent_service_credentials")) {
      const provider = params[1] as string;
      if (!creds[provider]) return { rows: [] };
      return {
        rows: [{
          id: "1",
          workspace_id: params[0],
          provider,
          label: "test",
          credential_type: "api_key",
          status: "active",
          last_validated_at: null,
          last_validation_error: null,
          created_at: new Date().toISOString(),
          encrypted_value: creds[provider],
        }],
      };
    }
    return { rows: [] };
  };
  return {
    query: async (text: string, params: unknown[]) => queryResult(text, params),
  } as unknown as DbPool;
}

// The credential decryption in getCredential uses AES-256-GCM with the
// encryption key. For the test we bypass it by monkey-patching the
// getCredential import. Instead of testing through the real crypto path,
// we test the chain logic by controlling what resolveChatApiKey sees.
//
// Since resolveChatApiKey calls getConnectedProviders + getCredential from
// the store module, and those are real DB calls, we use a mock pool that
// returns predictable rows. The encrypted_value in the mock is a plain
// string — getCredential will try to decrypt it and fail, returning null.
// That's fine: the test verifies which providers are *attempted*, not
// whether the key decrypts. A provider with a credential row that fails
// to decrypt returns undefined (skipped), which is the correct behaviour.
//
// For providers with platform env keys (groq, google), no DB call is made.

const BASE_OPTS: Omit<ChatOpts, "pool"> = {
  zenToken: "zen-test-token",
  encryptionKey: "a".repeat(64),
  previousEncryptionKey: null,
  fallbackGoogleKey: null,
  fallbackGroqKey: null,
};

describe("buildChatChain", () => {
  it("returns Zen models when zenToken is set", async () => {
    const chain = await buildChatChain(
      { ...BASE_OPTS, pool: mockPool() },
      "ws1",
    );
    const zenEntries = chain.filter((c) => c.label.startsWith("zen/"));
    assert.equal(zenEntries.length, 3);
    assert.equal(zenEntries[0].model, "nemotron-3.5-lightning-free");
    assert.equal(zenEntries[1].model, "mimo-v2.5-free");
    assert.equal(zenEntries[2].model, "deepseek-v4-flash-free");
  });

  it("returns empty chain when no keys are available", async () => {
    const chain = await buildChatChain(
      { ...BASE_OPTS, zenToken: null, pool: mockPool() },
      "ws1",
    );
    assert.equal(chain.length, 0);
  });

  it("includes Groq models when fallbackGroqKey is set", async () => {
    const chain = await buildChatChain(
      { ...BASE_OPTS, pool: mockPool(), fallbackGroqKey: "groq-test-key" },
      "ws1",
    );
    const groqEntries = chain.filter((c) => c.label.startsWith("groq/"));
    assert.equal(groqEntries.length, 3);
    assert.equal(groqEntries[0].apiKey, "groq-test-key");
  });

  it("includes Google model when fallbackGoogleKey is set", async () => {
    const chain = await buildChatChain(
      { ...BASE_OPTS, pool: mockPool(), fallbackGoogleKey: "google-test-key" },
      "ws1",
    );
    const googleEntries = chain.filter((c) => c.label.startsWith("google/"));
    assert.equal(googleEntries.length, 1);
    assert.equal(googleEntries[0].model, "gemini-3.6-flash");
    assert.equal(googleEntries[0].apiKey, "google-test-key");
  });

  it("places Zen first, then Groq, then Google", async () => {
    const chain = await buildChatChain(
      {
        ...BASE_OPTS,
        pool: mockPool(),
        fallbackGroqKey: "groq-key",
        fallbackGoogleKey: "google-key",
      },
      "ws1",
    );
    const labels = chain.map((c) => c.label);
    const zenIdx = labels.findIndex((l) => l.startsWith("zen/"));
    const groqIdx = labels.findIndex((l) => l.startsWith("groq/"));
    const googleIdx = labels.findIndex((l) => l.startsWith("google/"));
    assert.ok(zenIdx < groqIdx, "Zen should come before Groq");
    assert.ok(groqIdx < googleIdx, "Groq should come before Google");
  });

  it("deduplicates models across providers", async () => {
    // If a model ID appears in both Zen and another provider, it should
    // only appear once in the chain.
    const chain = await buildChatChain(
      {
        ...BASE_OPTS,
        pool: mockPool(),
        fallbackGroqKey: "groq-key",
        fallbackGoogleKey: "google-key",
      },
      "ws1",
    );
    const models = chain.map((c) => c.model);
    const unique = new Set(models);
    assert.equal(models.length, unique.size, "no duplicate models in chain");
  });
});
