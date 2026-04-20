// ─── Chat completions proxy ─────────────────────────────────────────────────
import type { ServerResponse } from "node:http";
import type { ResolvedProviderConfig, ResolvedModelConfig } from "./config.js";
import type { RegistryEntry } from "./registry.js";
import {
  sendError,
  sendSSEError,
  invalidRequest,
  capabilityError,
  upstreamError,
  timeoutError,
  type GatewayError,
} from "./errors.js";
import { resolveRetryParams, withRetry, UpstreamHttpError, checkResponseRetryable } from "./retry.js";
import { setSSEHeaders, streamResponse, readNonStreamingResponse } from "./streaming.js";
import { insertRequest, completeRequest, insertError } from "./db.js";
import { log } from "./logger.js";

interface ChatCompletionRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  response_format?: any;
  [key: string]: any; // passthrough for provider-specific params
}

/**
 * Extract a summary of the request for logging (last user message, truncated).
 */
function extractSummary(messages: any[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  // Find last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join(" ")
            : "";
      return content.slice(0, 200);
    }
  }
  return "";
}

/**
 * Check if the request uses capabilities the model doesn't support.
 */
function validateCapabilities(
  body: ChatCompletionRequest,
  entry: RegistryEntry
): GatewayError | null {
  const caps = entry.model.capabilities;

  // Check tools
  if (body.tools && body.tools.length > 0 && !caps.tools) {
    return capabilityError(entry.key, "tools");
  }

  // Check images (look for image_url in message content)
  if (!caps.images && hasImageContent(body.messages)) {
    return capabilityError(entry.key, "images");
  }

  // Check streaming
  if (body.stream && !caps.streaming) {
    return capabilityError(entry.key, "streaming");
  }

  return null;
}

function hasImageContent(messages: any[]): boolean {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "image_url") return true;
      }
    }
  }
  return false;
}

/**
 * Build the upstream fetch request.
 */
function buildUpstreamRequest(
  body: ChatCompletionRequest,
  provider: ResolvedProviderConfig,
  model: ResolvedModelConfig
): { url: string; init: RequestInit } {
  // Replace our model key with the upstream modelId
  const upstreamBody = { ...body, model: model.modelId };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Set auth header
  if (provider.authHeader === "x-api-key") {
    headers["x-api-key"] = provider.apiKey;
  } else {
    headers[provider.authHeader] = `Bearer ${provider.apiKey}`;
  }

  const url = `${provider.baseUrl}/chat/completions`;

  return {
    url,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(provider.timeout),
    },
  };
}

/**
 * Handle a POST /v1/chat/completions request.
 */
export async function handleChatCompletions(
  body: ChatCompletionRequest,
  entry: RegistryEntry,
  res: ServerResponse
): Promise<void> {
  const startTime = Date.now();
  const isStream = body.stream === true;

  // Validate capabilities
  const capErr = validateCapabilities(body, entry);
  if (capErr) {
    sendError(res, capErr);
    return;
  }

  // Insert request record
  const requestId = insertRequest({
    model: entry.key,
    provider: entry.provider.name,
    stream: isStream,
    request_summary: extractSummary(body.messages),
  });

  const retryParams = resolveRetryParams(entry.provider, entry.model);
  const retryCtx = {
    model: entry.key,
    provider: entry.provider.name,
    requestId,
  };

  try {
    // The retry wrapper calls this function, which does the actual fetch
    // and throws UpstreamHttpError for non-ok responses that should be retried
    const upstreamResponse = await withRetry(
      async () => {
        const { url, init } = buildUpstreamRequest(body, entry.provider, entry.model);
        log.info(entry.key, `→ ${init.method} ${url} (stream: ${isStream})`);

        let response: Response;
        try {
          response = await fetch(url, init);
        } catch (err: any) {
          if (err.name === "TimeoutError" || err.name === "AbortError") {
            throw new UpstreamHttpError(504, "Request timed out");
          }
          throw err;
        }

        // For non-ok responses, check if retryable
        if (!response.ok) {
          const { retryable, retryAfterMs } = checkResponseRetryable(response);
          const responseBody = await response.text();

          if (retryable) {
            throw new UpstreamHttpError(response.status, responseBody, retryAfterMs);
          }

          // Non-retryable upstream error — don't retry, just return error
          throw new UpstreamHttpError(response.status, responseBody);
        }

        return response;
      },
      retryParams,
      retryCtx,
      (err) => {
        if (err instanceof UpstreamHttpError) return err.retryable;
        return (
          err instanceof Error &&
          (err.message.includes("fetch failed") ||
            err.message.includes("ECONNREFUSED") ||
            err.message.includes("ECONNRESET") ||
            err.message.includes("ETIMEDOUT") ||
            err.message.includes("socket hang up"))
        );
      }
    );

    // Success — proxy the response
    if (isStream) {
      setSSEHeaders(res);
      const usage = await streamResponse(upstreamResponse, res, entry.key);
      const latency = Date.now() - startTime;
      completeRequest(requestId, "success", latency, {
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        retryCount: 0, // TODO: track actual retry count
      });
      log.info(entry.key, `← stream complete (${latency}ms)`);
    } else {
      const { body: responseBody, tokensIn, tokensOut } =
        await readNonStreamingResponse(upstreamResponse, entry.key);
      const latency = Date.now() - startTime;

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(responseBody);

      completeRequest(requestId, "success", latency, {
        tokensIn,
        tokensOut,
        retryCount: 0,
      });
      log.info(entry.key, `← ${upstreamResponse.status} (${latency}ms, in:${tokensIn ?? "?"} out:${tokensOut ?? "?"})`);
    }
  } catch (err) {
    const latency = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);

    completeRequest(requestId, "error", latency, {
      error: errMsg,
      retryCount: retryParams.retries,
    });

    if (res.headersSent) {
      // Already streaming — inject error into SSE stream
      sendSSEError(res, upstreamError(errMsg));
    } else if (err instanceof UpstreamHttpError) {
      sendError(
        res,
        err.status === 504
          ? timeoutError(errMsg)
          : upstreamError(errMsg, err.status, err.responseBody)
      );
    } else {
      sendError(res, upstreamError(errMsg));
    }

    log.error(entry.key, `Request failed after ${latency}ms`, err);
  }
}
