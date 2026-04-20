// ─── OpenAI-compatible error formatting ─────────────────────────────────────
import type { ServerResponse } from "node:http";

export type ErrorType =
  | "invalid_request_error"
  | "model_not_found"
  | "authentication_error"
  | "upstream_error"
  | "rate_limit_error"
  | "timeout_error"
  | "model_disabled"
  | "provider_disabled"
  | "model_gone"
  | "capability_error"
  | "server_error";

export interface GatewayError {
  type: ErrorType;
  message: string;
  code: string | null;
  statusCode: number;
  upstreamStatus?: number;
  upstreamBody?: string;
  retryable: boolean;
}

export function createError(
  type: ErrorType,
  message: string,
  statusCode: number,
  opts?: {
    code?: string;
    upstreamStatus?: number;
    upstreamBody?: string;
    retryable?: boolean;
  }
): GatewayError {
  return {
    type,
    message,
    code: opts?.code ?? null,
    statusCode,
    upstreamStatus: opts?.upstreamStatus,
    upstreamBody: opts?.upstreamBody,
    retryable: opts?.retryable ?? false,
  };
}

export function errorToOpenAI(err: GatewayError) {
  return {
    error: {
      message: err.message,
      type: err.type,
      code: err.code,
    },
  };
}

export function sendError(res: ServerResponse, err: GatewayError): void {
  if (res.headersSent) return;
  res.writeHead(err.statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(errorToOpenAI(err)));
}

export function sendSSEError(res: ServerResponse, err: GatewayError): void {
  const payload = JSON.stringify(errorToOpenAI(err));
  res.write(`data: ${payload}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// ─── Convenience creators ────────────────────────────────────────────────────

export function modelNotFound(model: string, available: string[]): GatewayError {
  return createError(
    "model_not_found",
    `Model "${model}" not found. Available models: ${available.join(", ")}`,
    404,
    { code: "model_not_found" }
  );
}

export function modelDisabled(model: string): GatewayError {
  return createError(
    "model_disabled",
    `Model "${model}" is disabled in configuration`,
    403,
    { code: "model_disabled" }
  );
}

export function providerDisabled(model: string, provider: string): GatewayError {
  return createError(
    "provider_disabled",
    `Provider "${provider}" for model "${model}" is disabled in configuration`,
    403,
    { code: "provider_disabled" }
  );
}

export function modelGone(model: string): GatewayError {
  return createError(
    "model_gone",
    `Model "${model}" is no longer available from the upstream provider`,
    410,
    { code: "model_gone" }
  );
}

export function capabilityError(
  model: string,
  capability: string
): GatewayError {
  return createError(
    "capability_error",
    `Model "${model}" does not support "${capability}"`,
    400,
    { code: "capability_not_supported" }
  );
}

export function invalidRequest(message: string): GatewayError {
  return createError("invalid_request_error", message, 400, {
    code: "invalid_request",
  });
}

export function upstreamError(
  message: string,
  upstreamStatus?: number,
  upstreamBody?: string,
  retryable = false
): GatewayError {
  return createError("upstream_error", message, 502, {
    code: "upstream_error",
    upstreamStatus,
    upstreamBody,
    retryable,
  });
}

export function rateLimitError(
  message: string,
  retryAfter?: number
): GatewayError {
  return createError("rate_limit_error", message, 429, {
    code: "rate_limit",
    retryable: true,
  });
}

export function timeoutError(message: string): GatewayError {
  return createError("timeout_error", message, 504, {
    code: "timeout",
    retryable: true,
  });
}

// ─── Retryable status codes ──────────────────────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    // Network errors, DNS failures, connection refused
    const msg = err.message.toLowerCase();
    return (
      msg.includes("fetch failed") ||
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound") ||
      msg.includes("socket hang up") ||
      msg.includes("aborted")
    );
  }
  return false;
}
