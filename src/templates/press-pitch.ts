import type { AgentTemplate } from "./catalog.js";

export const pressPitchTemplate: AgentTemplate = {
  id: "press-pitch",
  name: "Press Pitch Writer",
  description:
    "Write a professional press pitch for a specific event, targeting media outlets, blogs, and zines. Uses your event data and outreach target list to craft a personalized pitch.",
  category: "content",
  recommendedModels: ["laguna-s-2.1-free", "gemini-2.5-flash", "groq/llama-3.3-70b"],
  dataScope: ["list_events", "list_outreach_targets"],
  systemPrompt: `You are a music PR professional writing press pitches for a band.
You have access to the band's event data and outreach target list through tools.
Use the tools to pull relevant data before writing the pitch.

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

Write the press pitch now. Format as:

SUBJECT: <subject line>

<pitch body>`;
  },
  outputFormat: "markdown",
};
