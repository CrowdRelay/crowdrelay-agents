/**
 * Cognition (Devin) session API client.
 *
 * Unlike other providers that use OpenAI-compatible chat completions, Devin
 * uses a session-based agentic API: you create a session with a prompt, it
 * runs autonomously (with shell, file, web, and sub-agent access), and you
 * poll for the final result.
 *
 * This is the "spin their own agents doing stuff and getting back with
 * results" path — the session is the orchestrator, not the runner.
 */

const DEVIN_API_BASE = "https://api.devin.ai/v3";
const ORG_ID_RE = /^org-[a-zA-Z0-9_-]+$/;

interface DevinSessionResponse {
  session_id: string;
  status: string;
}

interface DevinMessage {
  type: string;
  message: string;
  timestamp: string;
}

interface DevinMessagesResponse {
  messages: DevinMessage[];
  status: string;
}

/**
 * Creates a Devin session and polls until it completes or times out.
 * Returns the final assistant message as the LLM output.
 *
 * @param apiKey  The Devin API key (starts with `cog_`)
 * @param orgId   The Devin organization ID (starts with `org-`)
 * @param prompt  The full task prompt (including context + output contract)
 * @param timeoutMs Maximum time to wait for completion (default: 300s)
 * @returns The final message content from the session
 */
export async function callDevinSession(
  apiKey: string,
  orgId: string,
  prompt: string,
  timeoutMs: number = 300_000,
): Promise<{ content: string; sessionId: string }> {
  // Validate orgId format to prevent path traversal / SSRF within the Devin API
  if (!ORG_ID_RE.test(orgId)) {
    throw new Error(`Invalid Devin org ID format: expected org-... format`);
  }
  const safeOrgId = encodeURIComponent(orgId);

  // 1. Create the session
  const createRes = await fetch(`${DEVIN_API_BASE}/organizations/${safeOrgId}/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`Devin session creation failed: ${createRes.status} ${body}`);
  }

  const session = (await createRes.json()) as DevinSessionResponse;
  const sessionId = session.session_id;

  // 2. Poll for completion
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 5_000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const pollRes = await fetch(
      `${DEVIN_API_BASE}/organizations/${safeOrgId}/sessions/${sessionId}/messages`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!pollRes.ok) {
      // Transient errors are tolerable — keep polling until deadline
      continue;
    }

    const data = (await pollRes.json()) as DevinMessagesResponse;

    if (data.status === "completed" || data.status === "finished") {
      const finalMessage = extractFinalMessage(data.messages);
      return { content: finalMessage, sessionId };
    }

    if (data.status === "failed" || data.status === "error") {
      const errorMsg = extractFinalMessage(data.messages) ?? "session failed";
      throw new Error(`Devin session failed: ${errorMsg}`);
    }

    // Still running — keep polling
  }

  throw new Error(`Devin session timed out after ${timeoutMs / 1000}s (session: ${sessionId})`);
}

/**
 * Extracts the final assistant message from the message stream.
 * Devin messages have a `type` field — we want the last assistant message
 * that contains substantive content.
 */
function extractFinalMessage(messages: DevinMessage[]): string {
  if (!messages || messages.length === 0) {
    throw new Error("Devin session produced no messages");
  }
  // Walk backwards to find the last assistant message with content
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      (msg.type === "assistant" || msg.type === "result" || msg.type === "final") &&
      msg.message &&
      msg.message.trim().length > 0
    ) {
      return msg.message;
    }
  }
  // No substantive assistant message found — this is an error, not a silent
  // success. Returning "" would let the runner store an empty response and
  // skip the fallback chain.
  const last = messages[messages.length - 1];
  const preview = (last?.message ?? "").slice(0, 100);
  throw new Error(
    `Devin session produced no substantive final message (last message: "${preview}")`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
