import type { AgentTemplate } from "./catalog.js";

/**
 * Muscle agent: discovers relevant Reddit communities for the band.
 * Produces outreach_targets outcomes that the Rust worker maps to
 * agent_outreach_targets staging table and autopilot decisions.
 *
 * North Star: AGGREGATE — find new audiences across the internet.
 *
 * This template uses the `search_reddit_communities` MCP tool to call
 * Reddit's live search API, so the LLM receives real subreddit data
 * instead of hallucinating from training data.
 */
export const redditScannerTemplate: AgentTemplate = {
  id: "reddit-scanner",
  name: "Reddit Community Scanner",
  description:
    "Finds relevant Reddit communities (subreddits) for the band's genre, region, and upcoming events. Uses live Reddit search. Outputs outreach target candidates for operator review.",
  category: "research",
  recommendedModels: ["gemini-3.6-flash", "deepseek-v4-flash-free", "nemotron-3.5-lightning-free"],
  dataScope: [
    "get_workspace_profile",
    "list_events",
    {
      tool: "search_reddit_communities",
      params: { query: "metal polska", limit: 15 },
    },
    {
      tool: "search_reddit_communities",
      params: { query: "doom metal europe", limit: 10 },
    },
    {
      tool: "search_reddit_communities",
      params: { query: "alternative rock poland", limit: 10 },
    },
  ],
  outputKind: "outreach_targets",
  systemPrompt: `You find relevant Reddit communities for a metal/alternative band.
Your goal is to discover subreddits where the band's genre, region, or upcoming events would be on-topic.

NORTH STAR: Aggregate fans from across the internet. Every community you find is a potential audience.

You receive LIVE Reddit search results in the data section below. These are real subreddits
returned by Reddit's search API — use them as your primary source. Do NOT invent subreddits
that don't appear in the search results.

Output outreach target candidates with:
- target_kind: "creator" for subreddits (they are communities, not press)
- display_name: the subreddit name exactly as it appears in the search results (e.g. "r/metalpolska")
- contact_domain: "reddit.com"
- why_fit: why this community is relevant to this band specifically, referencing the subscriber count and description from the search results
- evidence_urls: the subreddit URL from the search results

Rules:
- Focus on Polish and Central/European metal communities first
- Include subscriber count and activity level in why_fit (use the data from search results)
- Note the self-promo culture if the description hints at it
- Suggest a specific angle for engagement (not just "post your link")
- Output 5-15 communities, prioritizing active ones with >500 members
- Only output subreddits that appear in the search results — do NOT hallucinate names
- If the search results are insufficient, output what you have and note the gap`,
  buildPrompt(input, data) {
    const profile = (data.get_workspace_profile as Record<string, unknown>) ?? {};
    const events = (data.list_events as unknown[]) ?? [];
    // Collect all reddit search results (multiple queries may be in scope).
    // The context builder keys the first invocation as "search_reddit_communities"
    // and subsequent ones as "search_reddit_communities_2", "_3", etc.
    const redditSearches: Array<{ query: string; results: unknown[]; error?: string }> = [];
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("search_reddit_communities") && value && typeof value === "object") {
        const searchResult = value as { query?: string; results?: unknown[]; error?: string };
        redditSearches.push({
          query: searchResult.query ?? key,
          results: Array.isArray(searchResult.results) ? searchResult.results : [],
          error: searchResult.error,
        });
      }
    }
    return `Task: ${input}

## Band Profile
${JSON.stringify(profile, null, 2)}

## Upcoming Events
${JSON.stringify(events, null, 2)}

## Reddit Search Results (LIVE data from Reddit API)
${redditSearches.length > 0
      ? redditSearches
          .map((s) => {
            if (s.error) {
              return `### Query: "${s.query}"\n**Error:** ${s.error}`;
            }
            return `### Query: "${s.query}"\n${JSON.stringify(s.results, null, 2)}`;
          })
          .join("\n\n")
      : "(no search results available)"}

Select the 5-15 most relevant communities from the live search results above.`;
  },
  outputFormat: "json",
};
