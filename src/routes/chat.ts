/**
 * AI Chatbot endpoint — a clever assistant that knows what the user can do
 * in the control plane and helps them do it.
 *
 * Uses free-tier Zen models (no API key needed). The system prompt encodes
 * the full app capability map so the model can suggest actions, guide users
 * to the right page, and even propose concrete operations (create a schedule,
 * run a task, toggle autopilot, etc.).
 *
 * The model returns JSON with a text reply and optional action suggestions.
 * The frontend renders actions as clickable buttons that execute with user
 * confirmation.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { extractWorkspaceId } from "../auth.js";
import { callOpenAICompatible } from "../agent/opencode.js";
import { PROVIDER_ENDPOINTS } from "../agent/endpoints.js";
import { buildSystemPrompt } from "../chat/prompt.js";

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(4000),
  })).max(20).default([]),
  pageContext: z.string().max(500).optional(),
});

export function registerChatRoutes(
  app: FastifyInstance,
  opts: {
    authKey: string;
    zenToken: string | null;
  },
) {
  app.post("/chat", async (request, reply) => {
    let workspaceId: string;
    try {
      workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }

    const { message, history, pageContext } = parsed.data;

    // Build the conversation messages for the LLM
    const systemPrompt = buildSystemPrompt(pageContext);
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    // Call the free Zen model — no API key needed for opencode-zen
    const zenEndpoint = PROVIDER_ENDPOINTS["opencode-zen"];
    if (!zenEndpoint) {
      return reply.code(503).send({ error: "chat is not available (no free model configured)" });
    }

    try {
      const response = await fetch(zenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.zenToken ? { Authorization: `Bearer ${opts.zenToken}` } : {}),
        },
        body: JSON.stringify({
          model: "laguna-s-2.1-free",
          messages,
          max_tokens: 2048,
          temperature: 0.7,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        return reply.code(502).send({ error: `model error: ${response.status} ${errorText.slice(0, 200)}` });
      }

      const data = await response.json() as {
        choices?: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const content = data.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        return reply.code(502).send({ error: "model returned empty response" });
      }

      // Parse the JSON response — the model is instructed to return
      // { "reply": "...", "actions": [...] }
      let parsedResponse: { reply?: string; actions?: ChatAction[] };
      try {
        parsedResponse = JSON.parse(content);
      } catch {
        // If the model didn't return valid JSON, treat the whole thing as a text reply
        parsedResponse = { reply: content, actions: [] };
      }

      const reply_text = parsedResponse.reply ?? content;
      const actions = Array.isArray(parsedResponse.actions) ? parsedResponse.actions.slice(0, 5) : [];

      return reply.send({
        reply: reply_text.length > 8000 ? reply_text.slice(0, 8000) : reply_text,
        actions,
        usage: {
          tokens_in: data.usage?.prompt_tokens ?? 0,
          tokens_out: data.usage?.completion_tokens ?? 0,
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `chat failed: ${errorMsg.slice(0, 300)}` });
    }
  });
}

export interface ChatAction {
  /** The action type — maps to a frontend handler */
  type: "navigate" | "create_schedule" | "run_task" | "toggle_autopilot" | "paste_api_key" | "create_notifier" | "create_fanbase" | "enable_area" | "deploy_tenant" | "retry_dead_deliveries" | "run_reconciliation";
  /** Human-readable label for the button */
  label: string;
  /** Parameters for the action — passed to the frontend handler */
  params: Record<string, unknown>;
}
