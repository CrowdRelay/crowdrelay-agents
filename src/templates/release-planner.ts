import type { AgentTemplate } from "./catalog.js";

export const releasePlannerTemplate: AgentTemplate = {
  id: "release-planner",
  name: "Release Campaign Planner",
  description:
    "Plan a release campaign using the band's release plans, milestones, and beacon signal data. Generates a timeline with press, communication, and social media milestones.",
  category: "analysis",
  recommendedModels: ["laguna-s-2.1-free", "gemini-3.6-flash", "grok-4.3"],
  dataScope: ["release_plans", "beacon_signal_summary", "fan_stats", "list_release_campaigns", "get_opportunity_board"],
  outputKind: "release_plan_note",
  suggestedIntervalMinutes: 10080,
  systemPrompt: `You are a music release campaign planner. You create actionable release timelines using the band's data.

Rules:
- Reference specific release titles, dates, and milestone targets
- Create a week-by-week timeline from pre-release to post-release
- Include press outreach, social media, and fan communication milestones
- If assets aren't ready, flag it as a blocker
- If beacon signal coverage is weak on a platform, recommend fixing it before the release
- Write in the language that matches the band's primary market
- Be practical — this is for a working band, not a major label`,
  buildPrompt(input, data) {
    const releases = (data.release_plans as Record<string, unknown>) ?? {};
    const beacons = (data.beacon_signal_summary as Record<string, unknown>) ?? {};
    const fanStats = (data.fan_stats as Record<string, unknown>) ?? {};
    const releasesJson = JSON.stringify(releases, null, 2);
    const beaconsJson = JSON.stringify(beacons, null, 2);
    const fanStatsJson = JSON.stringify(fanStats, null, 2);

    return [
      "Task: " + input,
      "",
      "Here is the current data from the band's database:",
      "",
      "## Release Plans & Milestones",
      releasesJson,
      "",
      "## Beacon Signal Coverage",
      beaconsJson,
      "",
      "## Fan Statistics",
      fanStatsJson,
      "",
      "Create a release campaign plan with key milestones and risk flags.",
    ].join("\n");
  },
  outputFormat: "json",
};
