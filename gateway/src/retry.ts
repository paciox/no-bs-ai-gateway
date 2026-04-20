// ─── Retry logic with provider/model override resolution ────────────────────
import type { ResolvedModelConfig, ResolvedProviderConfig } from "./config.js";
import { isRetryableStatus, isRetryableError, type GatewayError } from "./errors.js";
import { insertError } from "./db.js";
import { log } from "./logger.js";

const MAX_DELAY_MS = 30_000;

export interface RetryParams {
  retries: number;
  delayMs: number;
}

export function resolveRetryParams(
  provider: ResolvedProviderConfig,
  model: ResolvedModelConfig
): RetryParams {
  return {
    retries: model.retries ?? provider.retries ?? 0,
    delayMs: model.retriesDelayMs ?? provider.retriesDelayMs ?? 1000,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryContext {
  model: string;        // full key e.g. "openrouter/openai/gpt-4"
  provider: string;     // provider name
  requestId: number;    // DB request ID for error logging
}

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
  ok: boolean;
}

/**
 * Execute a function with retry logic.
 * Returns the upstream Response on success, or throws the last error.
 * The `fn` should return the raw fetch Response.
 * 
 * For streaming: the caller must NOT start reading the body before this returns.
 * This function only retries if the initial connection/status fails.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  params: RetryParams,
  ctx: RetryContext,
  isRetryable: (error: unknown) => boolean
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= params.retries; attempt++) {
    try {
      if (attempt > 0) {
        const backoff = Math.min(params.delayMs * attempt, MAX_DELAY_MS);
        log.warn(
          ctx.model,
          `Retry attempt ${attempt}/${params.retries} after ${backoff}ms`
        );
        await delay(backoff);
      }

      return await fn();
    } catch (err) {
      lastError = err;

      // Log error to DB
      const errMsg = err instanceof Error ? err.message : String(err);
      insertError({
        requestId: ctx.requestId,
        model: ctx.model,
        provider: ctx.provider,
        errorType: "upstream_error",
        errorMessage: errMsg,
        attemptNumber: attempt,
      });

      if (!isRetryable(err)) {
        log.error(
          ctx.model,
          `Non-retryable error on attempt ${attempt}: ${errMsg}`
        );
        throw err;
      }

      log.warn(
        ctx.model,
        `Retryable error on attempt ${attempt}: ${errMsg}`
      );
    }
  }

  throw lastError;
}

/**
 * Check if a fetch Response indicates a retryable error.
 * Reads Retry-After header when present.
 * Returns { retryable, retryAfterMs? }
 */
export function checkResponseRetryable(
  response: Response
): { retryable: boolean; retryAfterMs?: number } {
  if (response.ok) return { retryable: false };

  const retryable = isRetryableStatus(response.status);

  let retryAfterMs: number | undefined;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      retryAfterMs = seconds * 1000;
    } else {
      // Could be a date string
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        retryAfterMs = Math.max(0, date.getTime() - Date.now());
      }
    }
  }

  return { retryable, retryAfterMs };
}

/**
 * Custom error class for upstream HTTP errors that may be retryable.
 */
export class UpstreamHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
    public readonly retryAfterMs?: number
  ) {
    super(`Upstream returned ${status}: ${responseBody.slice(0, 200)}`);
    this.name = "UpstreamHttpError";
  }

  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }
}
