import type { AgentTemplate } from "./catalog.js";

export const pressPitchTemplate: AgentTemplate = {
  id: "press-pitch",
  name: "Press Pitch Writer",
  description:
    "Write a professional press pitch for a specific event, targeting media outlets, blogs, and zines. Uses your event data and outreach target list to craft a personalized pitch.",
  category: "content",
  recommendedModels: ["laguna-s-2.1-free", "gemini-3.6-flash", "openai/gpt-oss-120b"],
  dataScope: ["get_workspace_profile", "list_events", "list_outreach_targets", "get_opportunity_board", "get_agent_history"],
  outputKind: "press_pitch",
  suggestedIntervalMinutes: 10080,
  systemPrompt: `You are a music PR professional writing press pitches for a band.
The band's event data and outreach target list are provided in the prompt below.

Rules:
- Write in a professional but personal tone — not generic PR-speak
- Reference specific event details (date, venue, lineup, ticket status)
- Tailor the pitch to the target's kind (press, radio, playlist, etc.)
- Keep it concise — 150-250 words max
- Include a clear subject line
- Write in the language that matches the event's market (Polish events → Polish, Czech events → Czech, etc.)
- If the target has a prior relationship (relationship_score > 0), acknowledge it briefly`,
  buildPrompt(input, data) {
    const events = (data.list_events as unknown[]) ?? [];
    const targets = (data.list_outreach_targets as unknown[]) ?? [];
    const eventsSummary = JSON.stringify(events, null, 2);
    const targetsSummary = JSON.stringify(targets, null, 2);

    return `Task: ${input}

Here is the current data from the band's database:

## Upcoming Events
${eventsSummary}

## Outreach Targets
${targetsSummary}

Write a press pitch based on this data. Use the outreach target IDs from the data above for target_refs.`;
  },
  outputFormat: "json",
};
