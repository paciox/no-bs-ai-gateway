// ─── SSE streaming proxy with stall detection ──────────────────────────────
import type { ServerResponse } from "node:http";
import { log } from "./logger.js";

const STALL_TIMEOUT_MS = 30_000;

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
 * Stream an upstream SSE response to the client, rewriting the model field.
 * Returns usage info if found in the final chunk.
 */
export async function streamResponse(
  upstreamResponse: Response,
  clientRes: ServerResponse,
  ourModelId: string
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
      const chunk = await readWithStallDetection(reader, STALL_TIMEOUT_MS);
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: [DONE]")) {
          clientRes.write("data: [DONE]\n\n");
          continue;
        }

        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6);
          try {
            const parsed = JSON.parse(jsonStr);
            // Rewrite model field
            if (parsed.model) {
              parsed.model = ourModelId;
            }
            // Capture usage from final chunk
            if (parsed.usage) {
              usage.tokensIn = parsed.usage.prompt_tokens;
              usage.tokensOut = parsed.usage.completion_tokens;
            }
            clientRes.write(`data: ${JSON.stringify(parsed)}\n\n`);
          } catch {
            // If JSON parse fails, pass through as-is (lenient parsing)
            clientRes.write(`${line}\n\n`);
          }
          continue;
        }

        // Pass through other SSE lines (event:, id:, comments, etc.)
        if (line.trim()) {
          clientRes.write(`${line}\n`);
        } else {
          clientRes.write("\n");
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
 * Read a non-streaming response body and rewrite the model field.
 */
export async function readNonStreamingResponse(
  upstreamResponse: Response,
  ourModelId: string
): Promise<{
  body: string;
  tokensIn?: number;
  tokensOut?: number;
}> {
  const text = await upstreamResponse.text();

  try {
    const parsed = JSON.parse(text);
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
