/**
 * Generate-then-verify gate.
 *
 * After the primary model produces a structured outcome, a second (free-tier)
 * model checks it against the same tenant data for:
 *  - hallucinated contacts, emails, venues, dates, or numbers
 *  - facts that contradict the provided data sections
 *  - tone or contract violations specific to the outcome kind
 *
 * The verifier returns a structured verdict. Only outcomes that pass are
 * emitted to the autopilot pipeline; rejected outcomes are stored on the
 * task result with the rejection reason so the operator can see why.
 *
 * Design notes:
 *  - The verifier is always a free-tier model — the gate must not add cost.
 *  - The verifier sees the SAME data sections the generator saw, so it can
 *    catch "invented a venue that doesn't appear in the events list."
 *  - The verdict is a tiny JSON object: { "passed": true/false, "issues": [...] }
 *  - On any verifier error (network, parse, timeout) we fail OPEN: the
 *    outcome passes. A broken verifier must not block the pipeline — the
 *    approval ladder is the next gate, not this one.
 */

import { callOpenAICompatible, type LlmResponse } from "./opencode.js";
import { callAnthropic } from "./anthropic.js";
import { PROVIDER_ENDPOINTS } from "./endpoints.js";
import type { ProviderDef, ProviderModel } from "../providers/registry.js";
import type { OutcomeKind } from "./structured.js";

export interface VerifyResult {
  passed: boolean;
  issues: string[];
  /** Model used for verification, for metadata. */
  verifierModel: string;
  /** Verifier call failed — outcome passed by fail-open policy. */
  verifierError?: string;
}

interface VerifierEntry {
  provider: ProviderDef;
  model: ProviderModel;
  apiKey: string | null;
}

/**
 * Runs the verification gate. Always uses a free-tier model.
 *
 * Returns { passed: true } when the outcome is clean or when the verifier
 * itself errors (fail-open). Returns { passed: false, issues } only when the
 * verifier successfully ran and found concrete problems.
 */
export async function verifyOutcome(params: {
  verifier: VerifierEntry;
  outcomeKind: OutcomeKind;
  originalPrompt: string;
  dataSections: string;
  modelOutput: string;
}): Promise<VerifyResult> {
  const { verifier, outcomeKind, originalPrompt, dataSections, modelOutput } = params;

  const systemPrompt = buildVerifierSystemPrompt(outcomeKind);
  const userPrompt = buildVerifierUserPrompt(originalPrompt, dataSections, modelOutput);

  let response: LlmResponse;
  try {
    response = await callVerifier(verifier, systemPrompt, userPrompt);
  } catch (err) {
    return {
      passed: true,
      issues: [],
      verifierModel: verifier.model.id,
      verifierError: err instanceof Error ? err.message : String(err),
    };
  }

  const parsed = parseVerdict(response.content);
  if (!parsed) {
    // Verifier returned unparseable output — fail open.
    return {
      passed: true,
      issues: [],
      verifierModel: verifier.model.id,
      verifierError: "verifier returned unparseable output",
    };
  }

  return {
    passed: parsed.passed,
    issues: parsed.issues,
    verifierModel: verifier.model.id,
  };
}

function buildVerifierSystemPrompt(kind: OutcomeKind): string {
  return [
    "You are a verification agent for a music industry automation platform.",
    "Your job is to check whether another AI's output is grounded in the provided data.",
    "",
    "You will receive:",
    "  1. The original task prompt (what the operator asked for)",
    "  2. The real data from the band's database (labeled sections)",
    "  3. The AI's response that needs verification",
    "",
    `The response being checked is a "${kind}" outcome — a structured JSON object.`,
    "",
    "Check for these specific problems:",
    "  - HALLUCINATED FACTS: any contact name, email, venue, date, number, or URL",
    "    that does NOT appear in the provided data sections",
    "  - CONTRADICTIONS: claims that directly conflict with the provided data",
    "  - CONTRACT VIOLATIONS: the output doesn't match what the task asked for",
    "    (wrong platform for a social post, wrong target kind for outreach, etc.)",
    "  - TONE/SAFETY: unprofessional content, spam-like language, or anything",
    "    that would damage the artist's reputation if sent to a real contact",
    "",
    "Respond with ONLY a JSON object, no prose, no markdown fences:",
    '{ "passed": true, "issues": [] }',
    'or',
    '{ "passed": false, "issues": ["specific problem 1", "specific problem 2"] }',
    "",
    "Rules:",
    "  - Be strict about hallucinated contacts — a wrong email sent to a real journalist is worse than no email.",
    "  - 'passed: false' only for concrete, specific problems you can point to in the data.",
    "  - 'passed: true' when the output is grounded, even if imperfect.",
    "  - Never invent problems — if the data doesn't mention something, that's not a contradiction.",
  ].join("\n");
}

function buildVerifierUserPrompt(originalPrompt: string, dataSections: string, modelOutput: string): string {
  return [
    "## ORIGINAL TASK PROMPT",
    originalPrompt,
    "",
    "## REAL DATA FROM THE BAND'S DATABASE",
    dataSections || "(no data sections were provided for this task)",
    "",
    "## AI RESPONSE TO VERIFY",
    "```json",
    modelOutput,
    "```",
    "",
    "Verify the AI response against the real data. Respond with the verdict JSON.",
  ].join("\n");
}

interface VerifierVerdict {
  passed: boolean;
  issues: string[];
}

function parseVerdict(raw: string): VerifierVerdict | null {
  // Reuse the same balanced-JSON extraction logic as the main parser.
  // Inline here to keep the verifier self-contained.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], raw];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>;
            if (typeof obj.passed === "boolean") {
              const issues = Array.isArray(obj.issues)
                ? obj.issues.filter((s): s is string => typeof s === "string").slice(0, 10)
                : [];
              return { passed: obj.passed, issues };
            }
            return null;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

async function callVerifier(
  entry: VerifierEntry,
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmResponse> {
  const { provider, model, apiKey } = entry;

  if (provider.protocol === "anthropic") {
    if (!apiKey) throw new Error("No API key for Anthropic verifier");
    return callAnthropic({
      apiKey,
      modelId: model.id,
      systemPrompt,
      userPrompt,
      jsonMode: true,
    });
  }

  const endpoint = PROVIDER_ENDPOINTS[provider.id];
  if (!endpoint) throw new Error(`Unknown endpoint for verifier provider: ${provider.id}`);

  return callOpenAICompatible({
    endpoint,
    apiKey: apiKey ?? "",
    modelId: model.id,
    systemPrompt,
    userPrompt,
    jsonMode: true,
  });
}
