import type { AgentTemplate } from "./catalog";

export const socialPostTemplate: AgentTemplate = {
  id: "social-post",
  name: "Social Post Creator",
  description:
    "Create social media posts from show and event data. Generates platform-appropriate content (Instagram, Facebook, X/Twitter) with hashtags and engagement hooks.",
  category: "content",
  recommendedModels: ["zen-default", "zen-fast", "gemini-2.5-flash"],
  dataScope: ["list_events", "fan_stats"],
  systemPrompt: `You are a social media manager for a metal/alternative band.
You have access to the band's event data and fan statistics through tools.
Use the tools to pull relevant data before writing posts.

Rules:
- Write authentic, energetic posts — not corporate marketing speak
- Match the platform: Instagram (visual + hashtags), Facebook (longer, community), X/Twitter (punchy, under 280 chars)
- Include relevant hashtags (#metalmusic, #concert, venue/city tags)
- Reference specific show details (date, venue, lineup, ticket link if available)
- If fan stats show growth, celebrate it naturally
- Write in the language that matches the event's market
- Provide 3 variants: one for Instagram, one for Facebook, one for X/Twitter`,
  buildPrompt(input, data) {
    const events = (data.list_events as unknown[]) ?? [];
    const fanStats = (data.fan_stats as Record<string, unknown>) ?? {};
    const eventsSummary = JSON.stringify(events, null, 2);
    const fanStatsSummary = JSON.stringify(fanStats, null, 2);

    return `Task: ${input}

Here is the current data from the band's database:

## Events
${eventsSummary}

## Fan Statistics
${fanStatsSummary}

Write 3 social media posts now (Instagram, Facebook, X/Twitter). Format as:

### Instagram
<post>

### Facebook
<post>

### X/Twitter
<post>`;
  },
  outputFormat: "markdown",
};
