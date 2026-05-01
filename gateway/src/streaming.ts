// ─── SSE streaming proxy with stall detection ──────────────────────────────
import type { ServerResponse } from "node:http";
import { log } from "./logger.js";

const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/**
 * Set SSE response headers on the client response.
 */
export function setSSEHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
}

/**
 * Translate Anthropic SSE event to OpenAI format.
 */
function translateAnthropicSSE(event: string, data: any): { event?: string; data: any } | null {
  // Anthropic uses event: lines with JSON data
  // We need to convert to OpenAI's data: format
  if (event === "message_start") {
    return {
      data: {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: data.message?.model ?? "unknown",
        choices: [{ index: 0, delta: { role: "assistant" } }],
      },
    };
  }

  if (event === "content_block_start") {
    return {
      data: {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "unknown",
        choices: [{ index: 0, delta: { content: "" } }],
      },
    };
  }

  if (event === "content_block_delta") {
    const delta = data.delta;
    if (delta.type === "text_delta") {
      return {
        data: {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "unknown",
          choices: [{ index: 0, delta: { content: delta.text } }],
        },
      };
    }
    if (delta.type === "input_json_delta") {
      return {
        data: {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "unknown",
          choices: [{ index: 0, delta: { content: delta.partial_json } }],
        },
      };
    }
  }

  if (event === "content_block_stop") {
    return {
      data: {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "unknown",
        choices: [{ index: 0, delta: {} }],
      },
    };
  }

  if (event === "message_delta") {
    return {
      data: {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "unknown",
        choices: [{ index: 0, delta: {}, finish_reason: data.delta?.stop_reason }],
      },
    };
  }

  if (event === "message_stop") {
    return { data: "[DONE]" };
  }

  return null;
}

/**
 * Stream an upstream SSE response to the client, rewriting the model field.
 * Returns usage info if found in the final chunk.
 */
export async function streamResponse(
  upstreamResponse: Response,
  clientRes: ServerResponse,
  ourModelId: string,
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
  isAnthropic: boolean = false
): Promise<{ tokensIn?: number; tokensOut?: number }> {
  const body = upstreamResponse.body;
  if (!body) {
    clientRes.write(
      `data: ${JSON.stringify({ error: { message: "Empty upstream response body", type: "upstream_error" } })}\n\n`
    );
    clientRes.write("data: [DONE]\n\n");
    clientRes.end();
    return {};
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = { tokensIn: undefined as number | undefined, tokensOut: undefined as number | undefined };

  try {
    while (true) {
      const chunk = await readWithStallDetection(reader, stallTimeoutMs);
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line in buffer

      let currentEvent = "";
      let currentData: any = null;

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6);
          try {
            currentData = JSON.parse(jsonStr);
          } catch {
            currentData = null;
          }
        } else if (line.trim() === "" && currentEvent && currentData !== null) {
          // Empty line signals end of SSE message
          if (isAnthropic) {
            const translated = translateAnthropicSSE(currentEvent, currentData);
            if (translated) {
              if (translated.data === "[DONE]") {
                clientRes.write("data: [DONE]\n\n");
              } else {
                log.streamChunk(ourModelId, ourModelId, currentEvent, 
                  translated.data.choices?.[0]?.delta?.content?.substring(0, 100));
                clientRes.write(`data: ${JSON.stringify(translated.data)}\n\n`);
              }
            }
          } else {
            // OpenAI format - pass through with model rewrite
            if (currentData.model) {
              currentData.model = ourModelId;
            }
            if (currentData.usage) {
              usage.tokensIn = currentData.usage.prompt_tokens;
              usage.tokensOut = currentData.usage.completion_tokens;
            }
            log.streamChunk(ourModelId, ourModelId, currentEvent || "message", 
              currentData.choices?.[0]?.delta?.content?.substring(0, 100));
            clientRes.write(`data: ${JSON.stringify(currentData)}\n\n`);
          }
          currentEvent = "";
          currentData = null;
        } else if (line.trim() === "") {
          // Empty line without event/data - pass through
          clientRes.write("\n");
        } else if (line.trim() && !line.startsWith("event:") && !line.startsWith("data:")) {
          // Pass through other SSE lines (id:, comments, etc.)
          clientRes.write(`${line}\n`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("stream", `Stream error: ${msg}`);
    // Inject error into SSE stream
    const errorPayload = JSON.stringify({
      error: { message: `Stream interrupted: ${msg}`, type: "upstream_error" },
    });
    clientRes.write(`data: ${errorPayload}\n\n`);
    clientRes.write("data: [DONE]\n\n");
  } finally {
    try {
      reader.releaseLock();
    } catch { /* already released */ }
    clientRes.end();
  }

  return usage;
}

/**
 * Read from a ReadableStream with stall detection.
 * If no data arrives within timeoutMs, throws an error.
 */
async function readWithStallDetection(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const stallPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Stream stalled: no data received for ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([reader.read(), stallPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (err) {
    clearTimeout(timeoutId!);
    throw err;
  }
}

/**
 * Translate Anthropic non-streaming response to OpenAI format.
 */
function translateAnthropicResponse(anthropicResponse: any, ourModelId: string): any {
  const content = Array.isArray(anthropicResponse.content)
    ? anthropicResponse.content.map((c: any) => c.text ?? c.input ?? "").join("")
    : anthropicResponse.content;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ourModelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: anthropicResponse.stop_reason,
      },
    ],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens ?? 0,
      completion_tokens: anthropicResponse.usage?.output_tokens ?? 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens ?? 0) +
        (anthropicResponse.usage?.output_tokens ?? 0),
    },
  };
}

/**
 * Buffer an upstream SSE stream into a single non-streaming OpenAI response.
 * Used when we force stream=true upstream (to keep the connection alive and
 * avoid NGINX 504s on slow models) but the client requested non-streaming.
 */
export async function bufferStreamToNonStreaming(
  upstreamResponse: Response,
  ourModelId: string,
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
): Promise<{ body: string; tokensIn?: number; tokensOut?: number }> {
  const body = upstreamResponse.body;
  if (!body) throw new Error("Empty upstream response body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = "";

  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  const contentParts: string[] = [];
  let finishReason: string | null = null;
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;

  try {
    while (true) {
      const { done, value } = await readWithStallDetection(reader, stallTimeoutMs);
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });
      const lines = rawBuffer.split("\n");
      rawBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === "[DONE]") continue;
        try {
          const evt = JSON.parse(jsonStr);
          if (evt.id) id = evt.id;
          if (evt.created) created = evt.created;
          const delta = evt.choices?.[0]?.delta;
          if (delta?.content) contentParts.push(delta.content);
          const fr = evt.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (evt.usage) {
            tokensIn = evt.usage.prompt_tokens;
            tokensOut = evt.usage.completion_tokens;
          }
        } catch { /* skip unparseable chunk */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const assembled = {
    id,
    object: "chat.completion",
    created,
    model: ourModelId,
    choices: [{
      index: 0,
      message: { role: "assistant", content: contentParts.join("") },
      finish_reason: finishReason,
    }],
    ...(tokensIn !== undefined && {
      usage: {
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut ?? 0,
        total_tokens: (tokensIn ?? 0) + (tokensOut ?? 0),
      },
    }),
  };

  return { body: JSON.stringify(assembled), tokensIn, tokensOut };
}

/**
 * Read a non-streaming response body and rewrite the model field.
 */
export async function readNonStreamingResponse(
  upstreamResponse: Response,
  ourModelId: string,
  isAnthropic: boolean = false
): Promise<{
  body: string;
  tokensIn?: number;
  tokensOut?: number;
}> {
  const text = await upstreamResponse.text();

  try {
    const parsed = JSON.parse(text);

    if (isAnthropic) {
      const translated = translateAnthropicResponse(parsed, ourModelId);
      return {
        body: JSON.stringify(translated),
        tokensIn: translated.usage.prompt_tokens,
        tokensOut: translated.usage.completion_tokens,
      };
    }

    if (parsed.model) {
      parsed.model = ourModelId;
    }

    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    if (parsed.usage) {
      tokensIn = parsed.usage.prompt_tokens;
      tokensOut = parsed.usage.completion_tokens;
    }

    return {
      body: JSON.stringify(parsed),
      tokensIn,
      tokensOut,
    };
  } catch {
    // If JSON parse fails, return raw text
    return { body: text };
  }
}
