import type { AgentTemplate } from "./catalog.js";

export const socialPostTemplate: AgentTemplate = {
  id: "social-post",
  name: "Social Post Creator",
  description:
    "Create social media posts from show and event data. Generates platform-appropriate content (Instagram, Facebook, X/Twitter) with hashtags and engagement hooks.",
  category: "content",
  recommendedModels: ["deepseek-v4-flash-free", "nemotron-3.5-lightning-free", "gemini-3.6-flash"],
  dataScope: ["get_workspace_profile", { tool: "list_events", params: { status: "published", upcoming: true } }, "fan_stats", "get_agent_history"],
  outputKind: "social_post",
  suggestedIntervalMinutes: 1440,
  systemPrompt: `You are a social media manager for a metal/alternative band.
The band's event data and fan statistics are provided in the prompt below.

Rules:
- Write authentic, energetic posts — not corporate marketing speak
- Match the platform: Instagram (visual + hashtags), Facebook (longer, community), X/Twitter (punchy, under 280 chars)
- Include relevant hashtags (#metalmusic, #concert, venue/city tags)
- Reference specific show details (date, venue, lineup, ticket link if available)
- If fan stats show growth, celebrate it naturally
- Write in the language that matches the event's market
- ALWAYS include a call-to-action to join the band's Signal community (the band's direct fan channel for show alerts, ticket presales, and exclusive content). Use the smart_link from the data as the signup URL. If no smart_link is provided, use a placeholder: https://signal.virya.music
- Provide 3 variants: one for Instagram, one for Facebook, one for X/Twitter`,
  buildPrompt(input, data) {
    const events = (data.list_events as unknown[]) ?? [];
    const fanStats = (data.fan_stats as Record<string, unknown>) ?? {};
    const workspace = (data.get_workspace_profile as Record<string, unknown>) ?? {};
    const smartLinks = (workspace.smart_links as Array<{ url?: string; label?: string }>) ?? [];
    const signalLink = smartLinks.find((s) => s.label?.toLowerCase().includes("signal"))?.url ?? "";
    const eventsSummary = JSON.stringify(events, null, 2);
    const fanStatsSummary = JSON.stringify(fanStats, null, 2);

    return `Task: ${input}

Here is the current data from the band's database:

## Events
${eventsSummary}

## Fan Statistics
${fanStatsSummary}

## Signal Signup Link
${signalLink || "https://signal.virya.music"}

Write 3 social media posts based on this data: one for Instagram, one for Facebook, one for X/Twitter. Each post must include the Signal signup link.`;
  },
  outputFormat: "json",
};
