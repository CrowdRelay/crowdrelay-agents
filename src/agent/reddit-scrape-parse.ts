/**
 * Pure parsing for browser-scraped subreddit search listings.
 *
 * Kept free of imports so the node:test runner (--experimental-strip-types)
 * can load it directly — see tests/reddit-browser.test.ts.
 */

export interface ScrapeResultRow {
  subreddit_name: string;
  display_name: string;
  description: string;
  subscribers: number;
  url: string;
  over18: boolean;
}

/** Shape of one child in Reddit's subreddits/search.json listing. */
export interface RedditSubredditData {
  display_name_prefixed?: string;
  display_name?: string;
  url?: string;
  title?: string;
  public_description?: string;
  subscribers?: number | null;
  over18?: boolean;
}

const REDDIT_ORIGIN = "https://www.reddit.com";

/** `r/Metal` → `metal` (store the bare name; display casing is in display_name). */
export function normalizeSubredditName(prefixed: string): string {
  return prefixed
    .trim()
    .replace(/^\/?r\//i, "")
    .toLowerCase();
}

/**
 * Parses a subreddit search listing into scrape-result rows. NSFW listings
 * are dropped at the parse boundary so nothing NSFW ever reaches the DB.
 */
export function parseSubredditListing(
  body: unknown,
  limit: number,
): ScrapeResultRow[] {
  const children = (body as { data?: { children?: Array<{ data?: RedditSubredditData }> } })
    ?.data?.children ?? [];
  const rows: ScrapeResultRow[] = [];
  for (const child of children) {
    const d = child?.data;
    const prefixed = d?.display_name_prefixed;
    if (!d || !prefixed || d.over18 === true) continue;
    const bare = normalizeSubredditName(prefixed);
    if (!bare) continue;
    rows.push({
      subreddit_name: bare,
      display_name: d.title?.trim() || prefixed,
      description: (d.public_description ?? "").slice(0, 2_000),
      subscribers: typeof d.subscribers === "number" ? Math.max(0, Math.trunc(d.subscribers)) : 0,
      url: `${REDDIT_ORIGIN}/r/${bare}`,
      over18: false,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}
