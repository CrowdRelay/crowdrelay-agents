import type { AgentTemplate } from "./catalog.js";

export const audienceResearchTemplate: AgentTemplate = {
  id: "audience-research",
  name: "Audience Growth Researcher",
  description:
    "Research and analyze audience growth using fan stats, merch sales, ticket data, and growth metrics. Identifies growth opportunities and suggests strategies.",
  category: "research",
  recommendedModels: ["laguna-s-2.1-free", "gemini-3.6-flash", "grok-4.3"],
  dataScope: ["fan_stats", "ticket_sales_summary", "list_merch_sales", "growth_metrics", "list_fan_segments", "get_agent_history"],
  outputKind: "audience_segments",
  systemPrompt: `You are an audience growth strategist for a music band. You analyze data to find growth opportunities and suggest practical strategies.

Rules:
- Use actual numbers from the data — don't make up statistics
- Identify which acquisition sources drive the most valuable fans
- Correlate merch sales with event attendance when possible
- If growth metrics show a trend, name it specifically
- Suggest 3-5 concrete strategies, not generic advice
- Consider the band's market — metal/alternative in Central/Eastern Europe
- Write in clear, structured format`,
  buildPrompt(input, data) {
    const fanStats = (data.fan_stats as Record<string, unknown>) ?? {};
    const tickets = (data.ticket_sales_summary as unknown[]) ?? [];
    const merch = (data.list_merch_sales as unknown[]) ?? [];
    const growth = (data.growth_metrics as Record<string, unknown>) ?? {};
    const fanStatsJson = JSON.stringify(fanStats, null, 2);
    const ticketsJson = JSON.stringify(tickets, null, 2);
    const merchJson = JSON.stringify(merch, null, 2);
    const growthJson = JSON.stringify(growth, null, 2);

    return [
      "Task: " + input,
      "",
      "Here is the current data from the band's database:",
      "",
      "## Fan Statistics & Acquisition Sources",
      fanStatsJson,
      "",
      "## Ticket Sales by Event",
      ticketsJson,
      "",
      "## Recent Merch Sales",
      merchJson,
      "",
      "## Growth Metrics (Autopilot-tracked)",
      growthJson,
      "",
      "Analyze the audience and identify fan segments with growth opportunities.",
    ].join("\n");
  },
  outputFormat: "json",
};
