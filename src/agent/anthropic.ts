/**
 * Anthropic-native LLM client. Anthropic uses a different API format
 * from OpenAI — x-api-key header, different message structure, different
 * response shape.
 */

export interface AnthropicResponse {
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
}

export async function callAnthropic(params: {
  apiKey: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<AnthropicResponse> {
  const { apiKey, modelId, systemPrompt, userPrompt } = params;
  const startTime = Date.now();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`Anthropic API ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as AnthropicApiResponse;
  const durationMs = Date.now() - startTime;

  // Anthropic returns content as an array of content blocks
  const textBlock = data.content?.find((b) => b.type === "text");
  const content = textBlock?.text ?? "";

  return {
    content,
    tokensIn: data.usage?.input_tokens ?? null,
    tokensOut: data.usage?.output_tokens ?? null,
    durationMs,
  };
}

interface AnthropicApiResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}
