// ─── Chat completions proxy ─────────────────────────────────────────────────
import type { ServerResponse } from "node:http";
import type { ResolvedConfig, ResolvedProviderConfig, ResolvedModelConfig } from "./config.js";
import type { RegistryEntry } from "./registry.js";
import {
  getCascadeCandidates,
  getModelSpecificCandidates,
} from "./registry.js";
import {
  sendError,
  capabilityError,
  upstreamError,
  timeoutError,
  type GatewayError,
} from "./errors.js";
import {
  resolveRetryParams,
  withRetry,
  UpstreamHttpError,
  checkResponseRetryable,
} from "./retry.js";
import {
  insertRequest,
  completeRequest,
  recordModelError,
  recordModelSuccess,
} from "./db.js";
import { setSSEHeaders, streamResponse, readNonStreamingResponse } from "./streaming.js";
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
 * Translate OpenAI-style request to Anthropic format.
 */
function translateToAnthropic(body: ChatCompletionRequest): any {
  const messages = [...body.messages];
  let system: string | undefined;

  // Extract system message if present
  const systemIdx = messages.findIndex((m) => m.role === "system");
  if (systemIdx >= 0) {
    const sysMsg = messages[systemIdx];
    system = typeof sysMsg.content === "string" ? sysMsg.content : "";
    messages.splice(systemIdx, 1);
  }

  // Convert tools format: OpenAI -> Anthropic
  let tools = body.tools;
  if (tools) {
    tools = tools.map((t: any) => ({
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      input_schema: {
        type: "object",
        properties: t.function?.parameters?.properties ?? t.input_schema?.properties ?? {},
        required: t.function?.parameters?.required ?? t.input_schema?.required ?? [],
      },
    }));
  }

  return {
    model: body.model,
    max_tokens: body.max_tokens ?? body.maxTokens ?? 4096,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    system,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    tools,
    stream: body.stream,
  };
}

/**
 * Build the upstream fetch request.
 */
function buildUpstreamRequest(
  body: ChatCompletionRequest,
  provider: ResolvedProviderConfig,
  model: ResolvedModelConfig
): { url: string; init: RequestInit } {
  // For Anthropic, translate the request format
  const isAnthropic = provider.name === "anthropic";
  const upstreamBody = isAnthropic
    ? translateToAnthropic(body)
    : { ...body, model: model.modelId };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Set auth header
  if (provider.authHeader === "x-api-key") {
    headers["x-api-key"] = provider.apiKey;
    // Add Anthropic version header for Anthropic provider
    if (provider.anthropicVersion) {
      headers["anthropic-version"] = provider.anthropicVersion;
    }
  } else {
    headers[provider.authHeader] = `Bearer ${provider.apiKey}`;
  }

  // Anthropic uses /v1/messages, others use /v1/chat/completions
  const endpoint = isAnthropic ? "/v1/messages" : "/v1/chat/completions";
  const url = `${provider.baseUrl}${endpoint}`;

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
 * Translate Anthropic response to OpenAI format.
 */
function translateAnthropicToOpenAI(anthropicResponse: any): any {
  // Handle streaming delta format
  if (anthropicResponse.type === "message_start") {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: anthropicResponse.message?.model ?? "unknown",
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
        },
      ],
    };
  }

  if (anthropicResponse.type === "content_block_start") {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "unknown",
      choices: [
        {
          index: 0,
          delta: { content: "" },
        },
      ],
    };
  }

  if (anthropicResponse.type === "content_block_delta") {
    const delta = anthropicResponse.delta;
    if (delta.type === "text_delta") {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "unknown",
        choices: [
          {
            index: 0,
            delta: { content: delta.text },
          },
        ],
      };
    }
    if (delta.type === "input_json_delta") {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "unknown",
        choices: [
          {
            index: 0,
            delta: { content: delta.partial_json },
          },
        ],
      };
    }
  }

  if (anthropicResponse.type === "content_block_stop") {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "unknown",
      choices: [
        {
          index: 0,
          delta: {},
        },
      ],
    };
  }

  if (anthropicResponse.type === "message_delta") {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "unknown",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: anthropicResponse.delta?.stop_reason,
        },
      ],
    };
  }

  if (anthropicResponse.type === "message_stop") {
    return "[DONE]";
  }

  // Non-streaming response
  if (anthropicResponse.content) {
    const content = Array.isArray(anthropicResponse.content)
      ? anthropicResponse.content.map((c: any) => c.text ?? c.input ?? "").join("")
      : anthropicResponse.content;

    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: anthropicResponse.model ?? "unknown",
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

  return anthropicResponse;
}

/**
 * Handle a POST /v1/chat/completions request with fallback support.
 */
export async function handleChatCompletions(
  body: ChatCompletionRequest,
  entry: RegistryEntry,
  res: ServerResponse,
  config: ResolvedConfig
): Promise<void> {
  const startTime = Date.now();
  const isStream = body.stream === true;

  // Validate capabilities on primary model
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

  // Build fallback candidate list
  const fallbackCandidates = buildFallbackCandidates(entry, config);

  // Track visited models to prevent cycles
  const visited = new Set<string>([entry.key]);

  // Try primary model first
  let lastError: unknown;
  let headersSent = false;

  try {
    await attemptModel(body, entry, res, isStream, requestId);
    return; // success — done
  } catch (err) {
    lastError = err;
    log.warn(entry.key, `Primary model failed, checking fallback candidates...`);
  }

  // If streaming already started, cannot fallback
  if (res.headersSent) {
    headersSent = true;
    // Error already handled in attemptModel catch path
    return;
  }

  // Try fallback candidates
  if (fallbackCandidates.length > 0 && config.cascadeEnabled && config.fallbackLimit > 0) {
    for (const candidate of fallbackCandidates) {
      if (visited.has(candidate.key)) continue;
      visited.add(candidate.key);

      // Re-validate capabilities for fallback candidate
      const candCapErr = validateCapabilities(body, candidate);
      if (candCapErr) {
        log.warn(candidate.key, `Fallback skipped — capability mismatch: ${candCapErr.message}`);
        continue;
      }

      // If streaming, cannot fallback after headers sent
      if (res.headersSent) {
        log.warn("fallback", `Cannot fallback to ${candidate.key} — response already started`);
        return;
      }

      log.info(candidate.key, `Fallback attempt (order ${candidate.model.fallbackOrder ?? "n/a"})`);

      try {
        await attemptModel(body, candidate, res, isStream, requestId);
        return; // success on fallback — done
      } catch (err) {
        lastError = err;
        log.warn(candidate.key, `Fallback model failed, trying next...`);
        // If headers were sent during this attempt (streaming started), stop
        if (res.headersSent) return;
      }
    }
  }

  // All candidates exhausted — send error
  if (!res.headersSent) {
    const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
    if (lastError instanceof UpstreamHttpError) {
      sendError(
        res,
        lastError.status === 504
          ? timeoutError(errMsg)
          : upstreamError(errMsg, lastError.status, lastError.responseBody, lastError.retryable)
      );
    } else {
      sendError(res, upstreamError(errMsg));
    }
  }
  log.error(entry.key, `All models exhausted (primary + fallbacks)`);
}

/**
 * Attempt a single model with its own retry loop.
 * Throws on failure; resolves on success (response already sent to client).
 */
async function attemptModel(
  body: ChatCompletionRequest,
  entry: RegistryEntry,
  res: ServerResponse,
  isStream: boolean,
  requestId: number
): Promise<void> {
  const startTime = Date.now();
  const retryParams = resolveRetryParams(entry.provider, entry.model);
  const retryCtx = {
    model: entry.key,
    provider: entry.provider.name,
    requestId,
  };

  let lastError: unknown;

  try {
    const { value: upstreamResponse, retryCount } = await withRetry(
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
        if (!response.ok) {
          const { retryable, retryAfterMs } = checkResponseRetryable(response);
          const responseBody = await response.text();
          if (retryable) {
            throw new UpstreamHttpError(response.status, responseBody, retryAfterMs);
          }
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

    // Success — record success for circuit breaker
    recordModelSuccess(entry.provider.name, entry.model.modelId);

    // Check if this is an Anthropic provider
    const isAnthropic = entry.provider.name === "anthropic";

    // Success — proxy the response
    if (isStream) {
      setSSEHeaders(res);
      const usage = await streamResponse(upstreamResponse, res, entry.key, entry.provider.timeout ?? 60_000, isAnthropic);
      const latency = Date.now() - startTime;
      completeRequest(requestId, "success", latency, {
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        retryCount,
      });
      log.info(entry.key, `← stream complete (${latency}ms)`);
    } else {
      const { body: responseBody, tokensIn, tokensOut } =
        await readNonStreamingResponse(upstreamResponse, entry.key, isAnthropic);
      const latency = Date.now() - startTime;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(responseBody);
      completeRequest(requestId, "success", latency, {
        tokensIn,
        tokensOut,
        retryCount,
      });
      log.info(
        entry.key,
        `← ${upstreamResponse.status} (${latency}ms, in:${tokensIn ?? "?"} out:${tokensOut ?? "?"})`
      );
    }
  } catch (err) {
    lastError = err;
    // Record error for circuit breaker
    const isBlacklisted = recordModelError(entry.provider.name, entry.model.modelId);
    if (isBlacklisted) {
      log.warn(entry.key, `Model blacklisted due to repeated errors`);
    }
    throw err;
  }
}

/**
 * Build the ordered list of fallback candidates based on config modality.
 */
function buildFallbackCandidates(
  primary: RegistryEntry,
  config: ResolvedConfig
): RegistryEntry[] {
  if (!config.cascadeEnabled || config.fallbackLimit <= 0) {
    return [];
  }

  const visited = new Set<string>([primary.key]);

  if (config.fallBackModality === "cascade") {
    const order = primary.model.fallbackOrder;
    if (order === undefined) return [];
    return getCascadeCandidates(order, config.fallbackLimit);
  }

  if (config.fallBackModality === "model_specific") {
    const models = primary.model.fallbackModels;
    if (!models || models.length === 0) return [];
    const { candidates, skipped } = getModelSpecificCandidates(
      models,
      config.fallbackLimit,
      visited
    );
    if (skipped.length > 0) {
      log.warn("fallback", `Skipped fallback targets: ${skipped.join(", ")}`);
    }
    return candidates;
  }

  return [];
}
