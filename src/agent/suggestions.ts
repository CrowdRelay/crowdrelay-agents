/**
 * Task suggestions engine. Looks at tenant data and generates actionable
 * suggestions for agent tasks — "you have an event in 2 weeks, want a press
 * pitch?" etc. Rule-based, not LLM — just helpful prompts the operator can
 * click to run.
 */

import type { DbPool } from "../store/db.js";

export interface TaskSuggestion {
  id: string;
  template_id: string;
  model_id: string;
  title: string;
  description: string;
  prefill_prompt: string;
  priority: "high" | "medium" | "low";
  reason: string;
}

interface TenantData {
  upcomingEvents: Array<{
    id: string;
    title: string;
    starts_at: string;
    status: string;
    interested_fans: number;
    paid_buyers: number;
  }>;
  recentEvents: Array<{
    id: string;
    title: string;
    starts_at: string;
    interested_fans: number;
    paid_buyers: number;
  }>;
  outreachTargets: {
    total: number;
    active: number;
    by_kind: Record<string, number>;
  };
  fanStats: {
    total: number;
    active: number;
    new_30d: number;
    new_7d: number;
  };
  campaigns: Array<{
    id: string;
    title: string;
    status: string;
  }>;
}

async function loadTenantData(pool: DbPool, workspaceId: string): Promise<TenantData> {
  const [upcoming, recent, targets, fans, campaigns] = await Promise.all([
    pool.query(
      `SELECT e.id, e.title, e.starts_at, e.status,
              (SELECT count(*)::int FROM event_interests ei WHERE ei.event_id = e.id) AS interested_fans,
              (SELECT count(DISTINCT tord.buyer_email)::int
               FROM ticket_orders AS tord
               JOIN ticket_sales ts ON ts.id = tord.ticket_sale_id
               WHERE ts.event_id = e.id AND tord.status IN ('paid','partially_refunded')) AS paid_buyers
       FROM events e
       WHERE e.workspace_id = $1 AND e.status = 'published' AND e.starts_at > now()
       ORDER BY e.starts_at ASC LIMIT 10`,
      [workspaceId],
    ),
    pool.query(
      `SELECT e.id, e.title, e.starts_at,
              (SELECT count(*)::int FROM event_interests ei WHERE ei.event_id = e.id) AS interested_fans,
              (SELECT count(DISTINCT tord.buyer_email)::int
               FROM ticket_orders AS tord
               JOIN ticket_sales ts ON ts.id = tord.ticket_sale_id
               WHERE ts.event_id = e.id AND tord.status IN ('paid','partially_refunded')) AS paid_buyers
       FROM events e
       WHERE e.workspace_id = $1 AND e.status = 'completed' AND e.starts_at > now() - INTERVAL '90 days'
       ORDER BY e.starts_at DESC LIMIT 5`,
      [workspaceId],
    ),
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE active = true)::int AS active,
              count(*) FILTER (WHERE target_kind = 'press')::int AS press,
              count(*) FILTER (WHERE target_kind = 'radio')::int AS radio,
              count(*) FILTER (WHERE target_kind = 'playlist')::int AS playlist,
              count(*) FILTER (WHERE target_kind = 'creator')::int AS creator,
              count(*) FILTER (WHERE target_kind = 'media_patronage')::int AS media_patronage
       FROM viryaos_outreach_targets WHERE workspace_id = $1`,
      [workspaceId],
    ),
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE created_at > now() - INTERVAL '7 days')::int AS new_7d,
              count(*) FILTER (WHERE created_at > now() - INTERVAL '30 days')::int AS new_30d
       FROM fans WHERE workspace_id = $1`,
      [workspaceId],
    ),
    pool.query(
      `SELECT id, title, status
       FROM viryaos_beacon_release_campaigns
       WHERE workspace_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 5`,
      [workspaceId],
    ),
  ]);

  return {
    upcomingEvents: upcoming.rows as TenantData["upcomingEvents"],
    recentEvents: recent.rows as TenantData["recentEvents"],
    outreachTargets: {
      total: targets.rows[0]?.total ?? 0,
      active: targets.rows[0]?.active ?? 0,
      by_kind: {
        press: targets.rows[0]?.press ?? 0,
        radio: targets.rows[0]?.radio ?? 0,
        playlist: targets.rows[0]?.playlist ?? 0,
        creator: targets.rows[0]?.creator ?? 0,
        media_patronage: targets.rows[0]?.media_patronage ?? 0,
      },
    },
    fanStats: {
      total: fans.rows[0]?.total ?? 0,
      active: fans.rows[0]?.active ?? 0,
      new_7d: fans.rows[0]?.new_7d ?? 0,
      new_30d: fans.rows[0]?.new_30d ?? 0,
    },
    campaigns: campaigns.rows as TenantData["campaigns"],
  };
}

function generateSuggestions(data: TenantData): TaskSuggestion[] {
  const suggestions: TaskSuggestion[] = [];
  const now = Date.now();

  // 1. Upcoming events → press pitch suggestions
  for (const event of data.upcomingEvents) {
    const eventDate = new Date(event.starts_at).getTime();
    const daysUntil = Math.floor((eventDate - now) / (1000 * 60 * 60 * 24));

    if (daysUntil <= 14 && daysUntil > 0) {
      suggestions.push({
        id: `press-${event.id}`,
        template_id: "press-pitch",
        model_id: "nemotron-3.5-lightning-free",
        title: `Press pitch for "${event.title}"`,
        description: `Event is in ${daysUntil} days (${new Date(event.starts_at).toLocaleDateString()}). ${event.interested_fans} interested, ${event.paid_buyers} paid. Write a press pitch targeting media outlets.`,
        prefill_prompt: `Write a press pitch for "${event.title}" on ${new Date(event.starts_at).toLocaleDateString()}. The event has ${event.interested_fans} interested fans and ${event.paid_buyers} paid ticket buyers. Target music media, blogs and zines in the event's market.`,
        priority: daysUntil <= 7 ? "high" : "medium",
        reason: `Event in ${daysUntil} days with ${event.interested_fans} interested fans`,
      });
    }

    if (daysUntil <= 7 && daysUntil > 0) {
      suggestions.push({
        id: `social-${event.id}`,
        template_id: "social-post",
        model_id: "mimo-v2.5-free",
        title: `Social posts for "${event.title}"`,
        description: `Event is in ${daysUntil} days — last chance to push social media. Create urgency-driven posts for Instagram, Facebook, and X/Twitter.`,
        prefill_prompt: `Create urgent social media posts for "${event.title}" happening in ${daysUntil} days (${new Date(event.starts_at).toLocaleDateString()}). ${event.paid_buyers} tickets sold so far. Focus on urgency — last chance to get tickets. Include ticket link placeholder.`,
        priority: "high",
        reason: `Event in ${daysUntil} days — social media urgency window`,
      });
    }
  }

  // 2. Recent events → show recap
  for (const event of data.recentEvents.slice(0, 2)) {
    const eventDate = new Date(event.starts_at).getTime();
    const daysSince = Math.floor((now - eventDate) / (1000 * 60 * 60 * 24));

    if (daysSince <= 14) {
      suggestions.push({
        id: `recap-${event.id}`,
        template_id: "social-post",
        model_id: "nemotron-3.5-lightning-free",
        title: `Post-show recap for "${event.title}"`,
        description: `Event was ${daysSince} days ago with ${event.paid_buyers} paid attendees. Write a thank-you/recap post to keep engagement high.`,
        prefill_prompt: `Write a post-show recap and thank-you post for "${event.title}" that happened ${daysSince} days ago. ${event.paid_buyers} people attended. Create content that thanks attendees and keeps the momentum going — mention upcoming events if any.`,
        priority: "medium",
        reason: `Recent event ${daysSince} days ago — recap engagement window`,
      });
    }
  }

  // 3. Low outreach target count → research suggestion
  if (data.outreachTargets.active < 10) {
    suggestions.push({
      id: "target-research",
      template_id: "press-pitch",
      model_id: "nemotron-3.5-lightning-free",
      title: "Expand outreach target list",
      description: `You have ${data.outreachTargets.active} active outreach targets. Research and identify new media outlets, blogs, and zines in your market to expand your reach.`,
      prefill_prompt: `Research and suggest new outreach targets for a metal/alternative band. We currently have ${data.outreachTargets.active} targets (${data.outreachTargets.by_kind.press} press, ${data.outreachTargets.by_kind.radio} radio, ${data.outreachTargets.by_kind.playlist} playlist). Suggest specific media outlets, blogs, zines, and radio stations that cover metal/alternative music in Central/Eastern Europe (Poland, Czech Republic, Germany).`,
      priority: "low",
      reason: `Only ${data.outreachTargets.active} active outreach targets`,
    });
  }

  // 4. Fan growth → audience analysis
  if (data.fanStats.new_30d > 0) {
    suggestions.push({
      id: "audience-analysis",
      template_id: "social-post",
      model_id: "nemotron-3.5-lightning-free",
      title: "Analyze recent fan growth",
      description: `${data.fanStats.new_30d} new fans in the last 30 days (${data.fanStats.total} total). Analyze where they're coming from and suggest ways to accelerate growth.`,
      prefill_prompt: `Analyze our fan growth: ${data.fanStats.total} total fans, ${data.fanStats.active} active, ${data.fanStats.new_30d} new in the last 30 days, ${data.fanStats.new_7d} new in the last 7 days. Suggest strategies to accelerate growth and improve fan engagement based on these numbers.`,
      priority: "low",
      reason: `${data.fanStats.new_30d} new fans in 30 days — growth analysis opportunity`,
    });
  }

  // 5. Active campaigns → campaign review
  if (data.campaigns.length > 0) {
    suggestions.push({
      id: "campaign-review",
      template_id: "social-post",
      model_id: "nemotron-3.5-lightning-free",
      title: `Review ${data.campaigns.length} active campaign${data.campaigns.length > 1 ? "s" : ""}`,
      description: `You have ${data.campaigns.length} active communication campaign${data.campaigns.length > 1 ? "s" : ""}. Get a summary and suggestions for improvement.`,
      prefill_prompt: `Review our ${data.campaigns.length} active communication campaign${data.campaigns.length > 1 ? "s" : ""}: ${data.campaigns.map(c => `"${c.title}" (${c.status})`).join(", ")}. Suggest improvements for engagement and reach.`,
      priority: "low",
      reason: `${data.campaigns.length} active campaigns running`,
    });
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return suggestions;
}

export async function getSuggestions(
  pool: DbPool,
  workspaceId: string,
): Promise<TaskSuggestion[]> {
  const data = await loadTenantData(pool, workspaceId);
  return generateSuggestions(data);
}
