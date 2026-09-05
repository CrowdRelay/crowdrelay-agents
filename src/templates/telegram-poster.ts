import type { AgentTemplate } from "./catalog.js";

/**
 * Telegram channel poster template.
 *
 * Drafts a Telegram channel post for the band. The output is a
 * `social_post` outcome item with `platform: "telegram"` — the Rust
 * `telegram_executor` claims the resulting `agent.content.request` action
 * and posts it via the Telegram Bot API.
 *
 * The executor reads `draft.text` for the post body and `draft.channel`
 * for the target channel (falls back to the telegram connection's
 * channel if not set in the draft).
 */
export const telegramPosterTemplate: AgentTemplate = {
  id: "telegram-poster",
  name: "Telegram Channel Poster",
  description:
    "Draft a Telegram channel post for the band. Concise, conversational, engaging. Uses Telegram HTML formatting.",
  category: "content",
  recommendedModels: ["claude-sonnet-5", "gemini-3.6-flash", "deepseek-v4-flash-free"],
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
- Keep it concise (under 500 characters), conversational, and engaging
- Reference upcoming events, new releases, or behind-the-scenes content
- Write in Polish for the primary audience
- Use Telegram formatting (bold, italic) where helpful
- Do not use hashtags — Telegram channels rarely use them
- ALWAYS include a call-to-action to join the band's Signal community

Output a single social_post item with platform "telegram".`,
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

Write a Telegram channel post based on this data. Include the Signal signup link.`;
  },
  outputFormat: "json",
};
