import type { AgentTemplate } from "./catalog.js";

export const campaignAnalysisTemplate: AgentTemplate = {
  id: "campaign-analysis",
  name: "Campaign Performance Analyzer",
  description:
    "Analyze communication campaign performance and suggest improvements. Uses delivery stats, fan growth, and outreach data to identify what's working and what isn't.",
  category: "analysis",
  recommendedModels: ["laguna-s-2.1-free", "gemini-3.6-flash", "openai/gpt-oss-120b"],
  dataScope: ["campaign_performance", "fan_stats", "list_outreach_targets"],
  systemPrompt: `You are a marketing analyst for a music band. You analyze campaign performance data and provide actionable insights.

Rules:
- Be specific — reference actual numbers, campaign names, and delivery rates
- Identify both what's working and what needs improvement
- Suggest concrete next steps, not vague advice
- If delivery failure rate is high, diagnose likely causes
- If fan growth is strong, identify which acquisition sources drive it
- Write in clear, structured format with sections for findings and recommendations
- Keep it concise — operators read this between tasks, not at a desk`,
  buildPrompt(input, data) {
    const campaigns = (data.campaign_performance as Record<string, unknown>) ?? {};
    const fanStats = (data.fan_stats as Record<string, unknown>) ?? {};
    const targets = (data.list_outreach_targets as unknown[]) ?? [];
    const campaignsJson = JSON.stringify(campaigns, null, 2);
    const fanStatsJson = JSON.stringify(fanStats, null, 2);
    const targetsJson = JSON.stringify(targets, null, 2);

    return [
      "Task: " + input,
      "",
      "Here is the current data from the band's database:",
      "",
      "## Campaign Performance",
      campaignsJson,
      "",
      "## Fan Statistics",
      fanStatsJson,
      "",
      "## Outreach Targets",
      targetsJson,
      "",
      "Analyze the campaign performance and provide:",
      "1. **Key findings** — what the data shows (3-5 bullet points)",
      "2. **What's working** — campaigns or channels with good delivery/engagement",
      "3. **What needs attention** — high failure rates, stagnant growth, gaps",
      "4. **Recommended actions** — 3-5 specific, actionable next steps",
    ].join("\n");
  },
  outputFormat: "markdown",
};
