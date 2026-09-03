import type { AgentTemplate } from "./catalog.js";

/**
 * Discord channel poster template.
 *
 * Drafts a Discord channel message for the band. The output is a
 * `social_post` outcome item with `platform: "discord"` — the Rust
 * `discord_executor` claims the resulting `agent.content.request` action
 * and posts it via the Discord Bot API.
 *
 * The executor reads `draft.text` for the message body and loads the
 * channel ID from the discord fanbase_connection.
 */
export const discordPosterTemplate: AgentTemplate = {
  id: "discord-poster",
  name: "Discord Channel Poster",
  description:
    "Draft a Discord channel message for the band. Concise, conversational, engaging. Uses Discord markdown formatting.",
  category: "content",
  recommendedModels: ["claude-sonnet-4-5", "claude-3-5-sonnet", "gemini-2.5-flash"],
  dataScope: [
    "get_workspace_profile",
    { tool: "list_events", params: { status: "published", upcoming: true } },
    "fan_stats",
    "get_agent_history",
  ],
  outputKind: "social_post",
  suggestedIntervalMinutes: 2880,
  systemPrompt: `You are a social media manager for a metal/alternative band.
The band's event data and fan statistics are provided in the prompt below.

Rules:
- Write authentic, energetic posts — not corporate marketing speak
- Keep it concise (under 2000 characters), conversational, and engaging
- Reference upcoming events, new releases, or behind-the-scenes content
- Write in Polish for the primary audience
- Use Discord markdown formatting (bold, italic, code blocks) where helpful
- ALWAYS include a call-to-action to join the band's Signal community

Output a single social_post item with platform "discord".`,
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

Write a Discord channel message based on this data. Include the Signal signup link.`;
  },
  outputFormat: "json",
};
