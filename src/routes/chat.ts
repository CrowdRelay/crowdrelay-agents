/**
 * AI Chatbot endpoints — a clever assistant that knows what the user can do
 * in the control plane and helps them do it.
 *
 * Two modes:
 * 1. POST /chat — buffered JSON response (legacy, kept for fallback)
 * 2. POST /chat/stream — SSE streaming response (preferred). Tokens are
 *    streamed as they arrive from the LLM so the user sees text immediately.
 *
 * The model writes plain text/markdown. If it wants to suggest actions, it
 * appends a delimited block at the end:
 *
 *   :::actions
 *   {"actions":[...]}
 *   :::
 *
 * The streaming endpoint forwards text tokens as SSE events and extracts the
 * actions block to send as a final event before closing the stream.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { extractWorkspaceId } from "../auth.js";
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

const ACTIONS_DELIMITER = ":::actions";

/** Parse the :::actions block from completed text. Returns [replyText, actions]. */
function extractActions(raw: string): { reply: string; actions: ChatAction[] } {
  const idx = raw.indexOf(ACTIONS_DELIMITER);
  if (idx === -1) return { reply: raw, actions: [] };
  const reply = raw.slice(0, idx).trimEnd();
  const after = raw.slice(idx + ACTIONS_DELIMITER.length);
  const endIdx = after.indexOf(":::");
  const jsonStr = (endIdx === -1 ? after : after.slice(0, endIdx)).trim();
  try {
    const parsed = JSON.parse(jsonStr) as { actions?: unknown };
    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 5) as ChatAction[] : [];
    return { reply, actions };
  } catch {
    return { reply: raw, actions: [] };
  }
}

export function registerChatRoutes(
  app: FastifyInstance,
  opts: {
    authKey: string;
    zenToken: string | null;
  },
) {
  // --- Buffered /chat (legacy fallback) ---
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
    const systemPrompt = buildSystemPrompt(pageContext);
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

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

      const { reply: replyText, actions } = extractActions(content);

      return reply.send({
        reply: replyText.length > 8000 ? replyText.slice(0, 8000) : replyText,
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

  // --- Streaming /chat/stream (SSE) ---
  app.post("/chat/stream", async (request, reply) => {
    let _workspaceId: string;
    try {
      _workspaceId = extractWorkspaceId(opts.authKey, request.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 401;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }

    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    }

    const { message, history, pageContext } = parsed.data;
    const systemPrompt = buildSystemPrompt(pageContext);
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const zenEndpoint = PROVIDER_ENDPOINTS["opencode-zen"];
    if (!zenEndpoint) {
      reply.raw.writeHead(503, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({ error: "chat is not available (no free model configured)" }));
      return;
    }

    // SSE headers — keep the connection open for streaming.
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (obj: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    // Accumulate the full text so we can extract the :::actions block at the end.
    // We stream everything to the client in real-time, then send a separate
    // "actions" event after the stream closes so the frontend can strip the
    // delimiter from the displayed text and render action buttons.
    let fullText = "";

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
          stream: true,
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        send({ type: "error", error: `model error: ${response.status} ${errorText.slice(0, 200)}` });
        reply.raw.end();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        send({ type: "error", error: "no response body from model" });
        reply.raw.end();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines from the upstream LLM API
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const token = chunk.choices?.[0]?.delta?.content;
            if (!token) continue;

            fullText += token;
            // Stream every token to the client immediately.
            send({ type: "token", text: token });
          } catch {
            // Ignore malformed chunks — the upstream may send keepalive lines.
          }
        }
      }

      // Process any remaining buffered data
      if (buffer.trim().startsWith("data: ")) {
        const payload = buffer.trim().slice(6);
        if (payload !== "[DONE]") {
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) {
              fullText += token;
              send({ type: "token", text: token });
            }
          } catch { /* ignore */ }
        }
      }

      // After the stream ends, extract actions and send them separately.
      const { reply: cleanReply, actions } = extractActions(fullText);
      if (actions.length > 0) {
        send({ type: "actions", actions, replyLength: cleanReply.length });
      }
      send({ type: "done" });
      reply.raw.end();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      send({ type: "error", error: `chat failed: ${errorMsg.slice(0, 300)}` });
      reply.raw.end();
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
