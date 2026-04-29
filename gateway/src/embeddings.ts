// ─── Embeddings proxy ────────────────────────────────────────────────────────
import type { ServerResponse } from "node:http";
import type { RegistryEntry } from "./registry.js";
import { sendError, capabilityError, upstreamError, invalidRequest } from "./errors.js";
import { log } from "./logger.js";
import { insertRequest, completeRequest } from "./db.js";

interface EmbeddingsRequest {
  input: string | string[];
  model: string;
  input_type?: string;
  encoding_format?: "float" | "base64";
  truncate?: string;
  dimensions?: number;
  user?: string;
  [key: string]: any;
}

export async function handleEmbeddings(
  body: EmbeddingsRequest,
  entry: RegistryEntry,
  res: ServerResponse
): Promise<void> {
  if (!entry.model.capabilities.embeddings) {
    sendError(res, capabilityError(entry.key, "embeddings"));
    return;
  }

  if (!body.input) {
    sendError(res, invalidRequest("'input' field is required"));
    return;
  }

  const requestId = insertRequest({
    model: entry.model.modelId,
    provider: entry.provider.name,
    stream: false,
  });

  const startTime = Date.now();

  const upstreamBody = { ...body, model: entry.model.modelId };

  const url = `${entry.provider.baseUrl.replace(/\/$/, "")}/embeddings`;
  const authHeader = entry.provider.authHeader ?? "Authorization";
  const authValue =
    authHeader === "Authorization"
      ? `Bearer ${entry.provider.apiKey}`
      : entry.provider.apiKey;

  log.info(entry.key, `→ POST ${url}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [authHeader]: authValue,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(entry.provider.timeout ?? 60_000),
    });
  } catch (err: any) {
    const latency = Date.now() - startTime;
    const msg =
      err.name === "TimeoutError" || err.name === "AbortError"
        ? "Request timed out"
        : err.message ?? "fetch failed";
    log.error(entry.key, `← embeddings error (${latency}ms): ${msg}`);
    completeRequest(requestId, "error", latency, {});
    sendError(res, upstreamError(msg, undefined, undefined, true));
    return;
  }

  const responseText = await response.text();
  const latency = Date.now() - startTime;

  if (!response.ok) {
    log.error(entry.key, `← embeddings HTTP ${response.status} (${latency}ms)`);
    completeRequest(requestId, "error", latency, {});
    sendError(res, upstreamError(responseText, response.status));
    return;
  }

  // Rewrite model field in response
  let responseBody: string;
  try {
    const parsed = JSON.parse(responseText);
    if (parsed.model) parsed.model = entry.key;
    responseBody = JSON.stringify(parsed);
  } catch {
    responseBody = responseText;
  }

  log.info(entry.key, `← embeddings complete (${latency}ms)`);
  completeRequest(requestId, "success", latency, {});

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(responseBody);
}
