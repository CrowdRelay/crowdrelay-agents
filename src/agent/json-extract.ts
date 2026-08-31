/**
 * Balanced-JSON extraction from LLM text.
 *
 * Models wrap JSON in prose, in markdown fences, or in both, and free models
 * do it more often than paid ones. This scanner finds the first balanced
 * top-level object, tracking string and escape state so a `{`, `}`, or `"`
 * inside a string value doesn't throw off the brace depth.
 *
 * Shared by the outcome envelope parser and the verification-gate verdict
 * parser — the two things that decide whether a run produces anything at all.
 *
 * No imports here so the node:test runner can load this module directly.
 */

/**
 * Extracts and parses the first balanced JSON object in `text`. Prefers the
 * contents of a ```json fence when one is present, then falls back to the raw
 * text. Returns null when nothing parseable exists.
 */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = firstBalancedObject(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstBalancedObject(candidate: string): unknown | null {
  const start = candidate.indexOf("{");
  if (start === -1) return null;
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
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface VerifierVerdict {
  passed: boolean;
  issues: string[];
}

/**
 * Parses the verification gate's verdict. A verdict is only usable when it
 * carries a boolean `passed` — anything else returns null and the runner
 * fails open, because a verifier that cannot be understood must not be able
 * to block a run.
 */
export function parseVerdict(raw: string): VerifierVerdict | null {
  const extracted = extractJson(raw);
  if (extracted === null || typeof extracted !== "object") return null;
  const obj = extracted as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((s): s is string => typeof s === "string").slice(0, 10)
    : [];
  return { passed: obj.passed, issues };
}
