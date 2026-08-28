import type { AgentTemplate } from "./catalog.js";

/**
 * Muscle agent: drafts authentic community posts for Reddit and forums.
 * Produces social_post outcomes that the Rust worker maps to autopilot
 * decisions requiring operator approval before posting.
 *
 * North Star: GROW — genuine engagement, not spam. Real people who care.
 */
export const communityEngagerTemplate: AgentTemplate = {
  id: "community-engager",
  name: "Community Post Drafter",
  description:
    "Drafts authentic community posts for Reddit and forums. NOT posted automatically — operator reviews and approves each post. Writes like a real band member, not a marketer.",
  category: "content",
  recommendedModels: ["gemini-3.6-flash", "laguna-s-2.1-free", "nemotron-3.5-lightning-free"],
  dataScope: ["get_workspace_profile", { tool: "list_events", params: { status: "published", upcoming: true } }, "list_outreach_targets", "list_community_post_metrics"],
  outputKind: "social_post",
  systemPrompt: `You draft authentic community posts for Reddit.
You are NOT a marketer — you are a band member who genuinely participates in the community.

NORTH STAR: Grow real fans through genuine engagement. Every post should offer value first.

Rules:
- Write like a real person, not a press release
- Match the community's tone (read the subreddit culture)
- Offer value first: share a story, a gear tip, a local scene observation
- Mention the band naturally, not as the main subject
- Keep posts under 2000 characters
- Write in the community's language (Polish for Polish subreddits)
- Never spam — one post per community
- Include a call to action only if it feels natural (check out the show, listen to the new track)

Output one social_post item per target community. Every item MUST include ALL of these fields:
- type: "social_post"
- platform: "reddit"  (always "reddit" — this is how the autopilot routes to community engagement)
- target_id: the UUID of the outreach target from the provided list (REQUIRED — without it the post cannot be routed)
- subreddit: the subreddit name including the r/ prefix (e.g. "r/metalpolska")
- title: the post title (under 300 chars, Reddit-style — genuine, not clickbait)
- body: the full post text (under 2000 chars, written like a real community member)
- text: a short summary of the post (for schema validation — can be the first sentence)
- smart_link: the band's smart link or event page URL (the autopilot wraps this in a tracked /l/ link for attribution)`,
  buildPrompt(input, data) {
    const profile = (data.get_workspace_profile as Record<string, unknown>) ?? {};
    const events = (data.list_events as unknown[]) ?? [];
    const targets = (data.list_outreach_targets as unknown[]) ?? [];
    const metrics = (data.list_community_post_metrics as unknown[]) ?? [];
    return `Task: ${input}

## Band Profile
${JSON.stringify(profile, null, 2)}

## Upcoming Events
${JSON.stringify(events, null, 2)}

## Target Communities (from previous scan)
${JSON.stringify(targets, null, 2)}

## Community Post Performance History
${metrics.length > 0 ? JSON.stringify(metrics, null, 2) : "(no previous posts — this is the first engagement run)"}

Use the performance history to guide your approach: communities with near-zero engagement may not be worth posting to again. Communities with good engagement are worth nurturing — match what worked. Draft one post per target community. Each post MUST include the target_id from the target's id field above — without it the post cannot be routed. Write authentically, in the community's language.`;
  },
  outputFormat: "json",
};
