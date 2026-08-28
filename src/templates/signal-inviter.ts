import type { AgentTemplate } from "./catalog.js";

/**
 * Muscle agent: drafts fan invite messages for Signal push notifications.
 * Produces signal_push outcomes that the Rust worker maps to autopilot
 * decisions requiring operator approval. When approved, the executor inserts
 * fan_push_deliveries rows that the PushDeliveryWorker sends via FCM/Web Push.
 *
 * North Star: CONVERT — move fans from passive to active via Signal.
 */
export const signalInviterTemplate: AgentTemplate = {
  id: "signal-inviter",
  name: "Signal Invite Drafter",
  description:
    "Drafts short, personal invite messages to send to fans via Signal push notifications. Messages reference specific upcoming shows and feel exciting, not promotional.",
  category: "content",
  recommendedModels: ["gemini-3.6-flash", "laguna-s-2.1-free", "nemotron-3.5-lightning-free"],
  dataScope: ["get_workspace_profile", { tool: "list_events", params: { status: "published", upcoming: true } }, "fan_stats"],
  outputKind: "signal_push",
  systemPrompt: `You draft invite messages to send to fans via Signal push notifications.
These are short, personal, and exciting — not promotional blasts.

NORTH STAR: Convert passive fans into active ones via Signal. Every invite should make the fan want to open the app.

Rules:
- Reference specific upcoming shows near the fan's city
- Title: 5-60 chars, the notification headline
- Body: under 200 chars, the notification text
- Write in the fan's language (Polish for Polish fans)
- Offer something: early access, presale codes, exclusive content
- Make it feel personal, like a message from the band to a friend
- target_path: deep link into the Signal app (e.g. /events/{event_id})
- event_id: include the UUID of the event this push references (for dedup)

Output one signal_push item per message variant:
- title: the push notification title (5-60 chars)
- body: the push notification body (under 200 chars)
- target_path: deep link to the event page in Signal (e.g. /events/{id})
- event_id: the UUID of the referenced event (if applicable)`,
  buildPrompt(input, data) {
    const profile = (data.get_workspace_profile as Record<string, unknown>) ?? {};
    const events = (data.list_events as unknown[]) ?? [];
    const fanStats = (data.fan_stats as Record<string, unknown>) ?? {};
    return `Task: ${input}

## Band Profile
${JSON.stringify(profile, null, 2)}

## Upcoming Events
${JSON.stringify(events, null, 2)}

## Fan Statistics
${JSON.stringify(fanStats, null, 2)}

Draft 3-5 push notification variants for inviting fans to Signal.`;
  },
  outputFormat: "json",
};
