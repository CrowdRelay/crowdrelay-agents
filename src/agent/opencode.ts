/**
 * OpenAI-compatible LLM client. Works with OpenCode Zen, Google Gemini
 * (OpenAI-compatible endpoint), and Groq — all expose the same
 * /v1/chat/completions API.
 *
 * For v1 we call the REST API directly. The @opencode-ai/sdk can be
 * swapped in later for session management and streaming.
 */

export interface LlmResponse {
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
}

interface CallParams {
  endpoint: string;
  apiKey: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  tools?: unknown[];
}

export async function callOpenAICompatible(params: CallParams): Promise<LlmResponse> {
  const { endpoint, apiKey, modelId, systemPrompt, userPrompt, tools } = params;
  const startTime = Date.now();

  const body: Record<string, unknown> = {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 4096,
    temperature: 0.7,
  };

  // Include tools if provided (for MCP-style function calling)
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`LLM API ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const durationMs = Date.now() - startTime;

  // Extract text from the response — handle both simple and tool-call responses
  let content = "";
  const choice = data.choices?.[0];
  if (choice?.message?.content) {
    content = choice.message.content;
  } else if (choice?.message?.tool_calls?.length) {
    // If the model made tool calls, we'd need to execute them and re-prompt.
    // For v1, we return the tool calls as JSON so the operator can see what
    // data the model requested. A follow-up iteration will implement the
    // tool-call loop.
    content = JSON.stringify(
      { note: "Model requested tool calls", tool_calls: choice.message.tool_calls },
      null,
      2,
    );
  }

  return {
    content,
    tokensIn: data.usage?.prompt_tokens ?? null,
    tokensOut: data.usage?.completion_tokens ?? null,
    durationMs,
  };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}
