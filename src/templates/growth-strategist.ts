import type { AgentTemplate } from "./catalog.js";

/**
 * Intelligence worker: analyzes the band's data and produces growth insights.
 * This is NOT the brain — the brain is the deterministic Rust autopilot.
 * This worker feeds intelligence to the brain via `campaign_insight` outcomes.
 *
 * The brain consumes these insights and decides what to do deterministically.
 * The brain never follows this worker blindly — it validates and applies rules.
 *
 * North Star: every insight must help aggregate, grow, or convert real fans.
 */
export const growthStrategistTemplate: AgentTemplate = {
  id: "growth-strategist",
  name: "Growth Intelligence Worker",
  description:
    "Analyzes the band's data and produces growth insights. This is a worker, not the brain — the deterministic Rust autopilot decides what to do with these insights.",
  category: "analysis",
  recommendedModels: ["gemini-3.6-flash", "laguna-s-2.1-free", "nemotron-3.5-lightning-free"],
  dataScope: [
    "get_workspace_profile",
    "fan_stats",
    "growth_metrics",
    "list_events",
    "list_outreach_targets",
    "campaign_performance",
    "get_opportunity_board",
    "get_agent_history",
    "list_fan_segments",
  ],
  outputKind: "campaign_insight",
  suggestedIntervalMinutes: 1440, // daily
  systemPrompt: `You are a growth intelligence analyst for a metal/alternative band. You analyze the band's data and produce actionable growth insights.

NORTH STAR: Grow real fans. Every insight must help:
1. AGGREGATE fans from across the internet (Reddit, forums, press, social)
2. GROW them with genuine engagement (not spam)
3. CONVERT them using fan 360 mechanisms (tickets, merch, attendance)

You produce growth insights — NOT decisions. The deterministic brain (Rust
autopilot) reads your insights and decides what to do. You are a tool that
gathers intelligence; the brain decides.

Each insight specifies:
- headline: what the opportunity or issue is
- detail: specific data-grounded analysis
- recommended_action: what you suggest (the brain may or may not follow this)

Rules:
- Ground every insight in the provided data — no speculation
- Be specific: "fan growth dropped 40% in the last 14 days, coinciding with no Reddit activity" not "growth is slow"
- Prioritize by impact: upcoming show → attendance insights; new release → promotion insights; stagnant growth → audience insights
- Don't duplicate insights the agent history shows were recently produced
- Consider the band's market — Polish/Central-European metal
- 3-7 insights per run — quality over quantity`,
  buildPrompt(input, data) {
    const profile = (data.get_workspace_profile as Record<string, unknown>) ?? {};
    const fanStats = (data.fan_stats as Record<string, unknown>) ?? {};
    const growthMetrics = (data.growth_metrics as Record<string, unknown>) ?? {};
    const events = (data.list_events as unknown[]) ?? [];
    const targets = (data.list_outreach_targets as unknown[]) ?? [];
    const campaigns = (data.campaign_performance as Record<string, unknown>) ?? {};
    const opportunities = (data.get_opportunity_board as Record<string, unknown>) ?? {};
    const history = (data.get_agent_history as unknown[]) ?? [];
    const segments = (data.list_fan_segments as unknown[]) ?? [];

    return `Task: ${input}

## Band Profile
${JSON.stringify(profile, null, 2)}

## Fan Statistics & Acquisition Sources
${JSON.stringify(fanStats, null, 2)}

## Growth Metrics (Autopilot-tracked)
${JSON.stringify(growthMetrics, null, 2)}

## Upcoming Events
${JSON.stringify(events, null, 2)}

## Outreach Targets (media, radio, playlists, communities)
${JSON.stringify(targets, null, 2)}

## Campaign Performance
${JSON.stringify(campaigns, null, 2)}

## Opportunity Board (open autopilot decisions)
${JSON.stringify(opportunities, null, 2)}

## Recent Agent History (avoid duplicating recent work)
${JSON.stringify(history, null, 2)}

## Existing Fan Segments
${JSON.stringify(segments, null, 2)}

Analyze this data and produce 3-7 growth insights grounded in the data.`;
  },
  outputFormat: "json",
};
