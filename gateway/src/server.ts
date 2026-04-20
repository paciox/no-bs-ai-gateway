// ─── HTTP server — routing, CORS, body parsing ─────────────────────────────
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedConfig } from "./config.js";
import { resolveModel, isGatewayError, listAllEntries, listAvailableModelKeys } from "./registry.js";
import { handleChatCompletions } from "./proxy.js";
import { handleListModels } from "./models.js";
import {
  sendError,
  invalidRequest,
  createError,
} from "./errors.js";
import {
  getRecentRequests,
  getRecentErrors,
  getStats,
  getAllModelStatuses,
  getModelStatus,
} from "./db.js";
import { log } from "./logger.js";

const MAX_BODY_DEFAULT = 50 * 1024 * 1024; // 50MB

// ─── CORS ────────────────────────────────────────────────────────────────────

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ─── Body reading ────────────────────────────────────────────────────────────

function readBody(
  req: IncomingMessage,
  maxSize: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body exceeds maximum size (${maxSize} bytes)`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── JSON response helper ────────────────────────────────────────────────────

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ─── UI serving ──────────────────────────────────────────────────────────────

let cachedUiHtml: string | null = null;

function getUiHtml(): string {
  if (cachedUiHtml) return cachedUiHtml;
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const uiPath = resolve(__dirname, "ui", "index.html");
    cachedUiHtml = readFileSync(uiPath, "utf-8");
    return cachedUiHtml;
  } catch {
    return "<html><body><h1>No-BS AI Gateway</h1><p>UI file not found. Place index.html in src/ui/</p></body></html>";
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ResolvedConfig
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  setCorsHeaders(res);

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET / → Web UI ──────────────────────────────────────────────────────
  if (method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getUiHtml());
    return;
  }

  // ── GET /health ─────────────────────────────────────────────────────────
  if (method === "GET" && path === "/health") {
    sendJson(res, 200, {
      status: "ok",
      uptime: process.uptime(),
      models: listAvailableModelKeys().length,
    });
    return;
  }

  // ── GET /v1/models ──────────────────────────────────────────────────────
  if (method === "GET" && (path === "/v1/models" || path === "/models")) {
    sendJson(res, 200, handleListModels());
    return;
  }

  // ── POST /v1/chat/completions ───────────────────────────────────────────
  if (
    method === "POST" &&
    (path === "/v1/chat/completions" || path === "/chat/completions")
  ) {
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req, config.maxBodySize ?? MAX_BODY_DEFAULT);
    } catch (err: any) {
      sendError(res, invalidRequest(err.message));
      return;
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      sendError(res, invalidRequest("Invalid JSON in request body"));
      return;
    }

    // Validate required fields
    if (!body.model || typeof body.model !== "string") {
      sendError(res, invalidRequest("'model' field is required and must be a string"));
      return;
    }
    if (!body.messages || !Array.isArray(body.messages)) {
      sendError(res, invalidRequest("'messages' field is required and must be an array"));
      return;
    }

    // Resolve model
    const result = resolveModel(body.model);
    if (isGatewayError(result)) {
      sendError(res, result);
      return;
    }

    await handleChatCompletions(body, result, res);
    return;
  }

  // ── API endpoints for UI ────────────────────────────────────────────────

  if (method === "GET" && path === "/api/stats") {
    sendJson(res, 200, getStats());
    return;
  }

  if (method === "GET" && path === "/api/requests") {
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    sendJson(res, 200, getRecentRequests(
      Math.min(Math.max(limit, 1), 500),
      Math.max(offset, 0)
    ));
    return;
  }

  if (method === "GET" && path === "/api/errors") {
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    sendJson(res, 200, getRecentErrors(
      Math.min(Math.max(limit, 1), 500),
      Math.max(offset, 0)
    ));
    return;
  }

  if (method === "GET" && path === "/api/models") {
    const entries = listAllEntries();
    const models = entries.map((e) => {
      const status = getModelStatus(e.provider.name, e.model.modelId);
      return {
        key: e.key,
        provider: e.provider.name,
        modelId: e.model.modelId,
        enabled: e.provider.enabled && e.model.enabled,
        providerEnabled: e.provider.enabled,
        modelEnabled: e.model.enabled,
        capabilities: e.model.capabilities,
        contextWindow: e.model.contextWindow,
        maxTokens: e.model.maxTokens,
        available: status?.available ?? null,
        lastError: status?.last_error ?? null,
      };
    });
    sendJson(res, 200, models);
    return;
  }

  // ── 404 ─────────────────────────────────────────────────────────────────
  sendError(
    res,
    createError("invalid_request_error", `Unknown route: ${method} ${path}`, 404)
  );
}

// ─── Server creation ─────────────────────────────────────────────────────────

export function createGatewayServer(config: ResolvedConfig) {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, config);
    } catch (err) {
      log.error("server", "Unhandled error in request handler", err);
      if (!res.headersSent) {
        sendError(
          res,
          createError("server_error", "Internal server error", 500)
        );
      }
    }
  });

  return server;
}

/**
 * Invalidate cached UI HTML (call on config reload or for dev).
 */
export function invalidateUiCache(): void {
  cachedUiHtml = null;
}
