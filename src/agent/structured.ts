import { z } from "zod";
import { extractJson } from "./json-extract.js";

/**
 * Structured outcome schemas. Every template that declares `outputSchema`
 * gets its LLM output parsed into an OutcomeEnvelope; the runner then writes
 * one row per item into agent_outcomes, which the Rust AgentOutcomeWorker
 * maps into autopilot decisions.
 *
 * Versioning: envelope v1. Rust mirrors these shapes in
 * crowdrelay-application/src/agent_outcomes.rs — additive changes only; a
 * new major version means a new literal and Rust-side acceptance.
 */

export const OUTCOME_SCHEMA_VERSION = 1;

export const OUTCOME_KINDS = [
  "press_pitch",
  "social_post",
  "signal_push",
  "audience_segments",
  "outreach_targets",
  "campaign_insight",
  "release_plan_note",
  "generic_insight",
] as const;

export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

const isoDate = z.string().max(40);

export const PressPitchItem = z.object({
  type: z.literal("press_pitch"),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(6000),
  target_refs: z.array(z.string().max(200)).max(25).default([]),
  suggested_send_at: isoDate.optional(),
  tone: z.string().max(60).optional(),
  follow_ups: z.array(z.string().max(300)).max(10).default([]),
});

export const SocialPostItem = z
  .object({
    type: z.literal("social_post"),
    platform: z.enum(["instagram", "facebook", "x", "reddit", "telegram", "discord"]),
    text: z.string().min(1).max(2200),
    cta_url: z.string().max(500).optional(),
    suggested_at: isoDate.optional(),
    // Community engagement fields (platform === "reddit" only). The
    // community-engager worker produces posts targeting a specific
    // subreddit; the Rust worker maps these to RequestCommunityEngagement
    // autopilot actions (ThirdParty, requires operator approval).
    target_id: z.string().uuid().max(200).optional(),
    subreddit: z.string().max(200).optional(),
    title: z.string().max(300).optional(),
    body: z.string().max(40000).optional(),
    smart_link: z.string().max(500).optional(),
  })
  .superRefine((item, ctx) => {
    // When platform is "reddit", the community-engagement fields are
    // required by the Rust worker's is_community_engagement gate.
    if (item.platform === "reddit") {
      if (!item.target_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target_id"],
          message: "target_id is required for reddit community posts",
        });
      }
      if (!item.subreddit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["subreddit"],
          message: "subreddit is required for reddit community posts",
        });
      }
      if (!item.title) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["title"],
          message: "title is required for reddit community posts",
        });
      }
      if (!item.body) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body"],
          message: "body is required for reddit community posts",
        });
      }
    }
  });

export const SignalPushItem = z.object({
  type: z.literal("signal_push"),
  // Push notification title (short, displayed in the notification bar).
  title: z.string().min(1).max(80),
  // Push notification body (under 200 chars for lock-screen readability).
  body: z.string().min(1).max(200),
  // Deep link into the Signal app — typically /events/{id} or /releases/{id}.
  target_path: z.string().max(500).optional(),
  // Optional event reference for deduplication and targeting.
  event_id: z.string().uuid().max(200).optional(),
  // Optional fan segment name to target (the Rust worker resolves this).
  segment: z.string().max(120).optional(),
});

export const FanSegmentItem = z.object({
  type: z.literal("fan_segment"),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  size_estimate: z.number().int().min(0).max(10_000_000).optional(),
  criteria: z.record(z.unknown()).default({}),
});

export const OutreachTargetItem = z.object({
  type: z.literal("outreach_target"),
  target_kind: z.enum(["press", "radio", "playlist", "media_patronage", "endorsement", "creator"]),
  display_name: z.string().min(1).max(200),
  contact_email: z.string().max(320).optional(),
  contact_domain: z.string().max(200).optional(),
  why_fit: z.string().max(1000).default(""),
  evidence_urls: z.array(z.string().max(500)).max(10).default([]),
});

export const CampaignInsightItem = z.object({
  type: z.literal("campaign_insight"),
  headline: z.string().min(1).max(300),
  detail: z.string().max(4000),
  recommended_action: z.string().max(1000).optional(),
});

export const ReleasePlanNoteItem = z.object({
  type: z.literal("release_plan_note"),
  headline: z.string().min(1).max(300),
  detail: z.string().max(4000),
  recommended_action: z.string().max(1000).optional(),
});

export const GenericInsightItem = z.object({
  type: z.literal("generic_insight"),
  headline: z.string().min(1).max(300),
  detail: z.string().max(4000),
  recommended_action: z.string().max(1000).optional(),
});

const AnyItem = z.union([
  PressPitchItem,
  SocialPostItem,
  SignalPushItem,
  FanSegmentItem,
  OutreachTargetItem,
  CampaignInsightItem,
  ReleasePlanNoteItem,
  GenericInsightItem,
]);

export const OutcomeEnvelope = z.object({
  kind: z.enum(OUTCOME_KINDS),
  schema_version: z.literal(OUTCOME_SCHEMA_VERSION).optional(),
  confidence_basis_points: z.number().int().min(0).max(10000),
  rationale: z.string().max(2000).default(""),
  items: z.array(AnyItem).max(25).default([]),
});

export type OutcomeEnvelopeParsed = z.infer<typeof OutcomeEnvelope>;

export interface StructuredParseResult {
  ok: boolean;
  envelope?: OutcomeEnvelopeParsed;
  error?: string;
}

/** Parses raw LLM text into a validated envelope (lenient about version). */
export function parseOutcome(raw: string): StructuredParseResult {
  const extracted = extractJson(raw);
  if (extracted === null) {
    // Check if the output looks like truncated JSON — starts with { but
    // never closes. This usually means the model hit its output token limit.
    const hasOpenBrace = raw.includes("{");
    const looksTruncated = hasOpenBrace && !raw.trim().endsWith("}");
    return {
      ok: false,
      error: looksTruncated
        ? "model output appears truncated (output token limit reached before JSON closed)"
        : "no JSON object found in model output",
    };
  }
  const versioned = typeof extracted === "object" && extracted !== null
    ? { schema_version: OUTCOME_SCHEMA_VERSION, ...(extracted as Record<string, unknown>) }
    : extracted;
  const parsed = OutcomeEnvelope.safeParse(versioned);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5).join("; ") };
  }
  // Refuse mixed-content envelopes: items must match the declared kind.
  const kind = parsed.data.kind;
  const expectedType = kind === "audience_segments" ? "fan_segment" : kind === "outreach_targets" ? "outreach_target" : kind.replace(/s$/, "");
  const mismatched = parsed.data.items.filter((item) => item.type !== expectedType && item.type !== "generic_insight");
  if (mismatched.length > 0 && expectedType !== "generic_insight") {
    return { ok: false, error: `items of type ${mismatched[0]?.type} do not match envelope kind ${kind}` };
  }
  return { ok: true, envelope: parsed.data };
}

/**
 * The OUTPUT CONTRACT text appended to the system prompt for templates with
 * an outputSchema. Provider-native structured output is preferred where the
 * model supports it; this contract is the portable floor.
 */
export function outputContractText(kind: OutcomeKind): string {
  const itemShapes: Record<OutcomeKind, string> = {
    press_pitch: `{"type":"press_pitch","subject":"...","body":"...","target_refs":["outreach target id"],"suggested_send_at":"YYYY-MM-DD","tone":"...","follow_ups":["..."]}`,
    social_post: `{"type":"social_post","platform":"instagram|facebook|x|reddit|telegram|discord","text":"...","cta_url":"...","suggested_at":"YYYY-MM-DD","target_id":"uuid (reddit only)","subreddit":"r/... (reddit only)","title":"... (reddit only)","body":"... (reddit only)","smart_link":"https://... (reddit only)"}`,
    signal_push: `{"type":"signal_push","title":"...","body":"... (under 200 chars)","target_path":"/events/{id}","event_id":"uuid","segment":"segment name"}`,
    audience_segments: `{"type":"fan_segment","name":"...","description":"...","size_estimate":123,"criteria":{"source":["..."]}}`,
    outreach_targets: `{"type":"outreach_target","target_kind":"press|radio|playlist|media_patronage|endorsement|creator","display_name":"...","contact_domain":"example.com","why_fit":"...","evidence_urls":["https://..."]}`,
    campaign_insight: `{"type":"campaign_insight","headline":"...","detail":"...","recommended_action":"..."}`,
    release_plan_note: `{"type":"release_plan_note","headline":"...","detail":"...","recommended_action":"..."}`,
    generic_insight: `{"type":"generic_insight","headline":"...","detail":"...","recommended_action":"..."}`,
  };
  return [
    "OUTPUT CONTRACT — your entire response must be a single JSON object, no prose, no markdown fences:",
    "{",
    `  "kind": ${JSON.stringify(kind)},`,
    '  "schema_version": 1,',
    '  "confidence_basis_points": <0-10000, your confidence in these items>,',
    '  "rationale": "<why these items, grounded in the provided data>",',
    `  "items": [ ${itemShapes[kind]}, ... ]   // 1-25 items`,
    "}",
    "Rules: use only facts present in the provided data; never invent contacts, emails, venues, dates, or numbers. Emails of outreach targets must NOT be guessed — leave contact_email out unless present in the data.",
  ].join("\n");
}
