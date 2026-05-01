// ─── Structured logger ──────────────────────────────────────────────────────

export type LogLevel = "SILENT" | "ERROR" | "WARN" | "INFO" | "VERBOSE" | "DEBUG";

// Log detail levels:
// SILENT   - No output except startup errors
// ERROR    - Only errors
// WARN     - Errors + warnings
// INFO     - Errors + warnings + basic info (default)
// VERBOSE  - INFO + request/response summaries, timing, token counts
// DEBUG    - VERBOSE + full request/response bodies, headers, internal state

let currentLogLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "INFO";

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatMsg(level: LogLevel, context: string, message: string): string {
  return `[${timestamp()}] [${level}] [${context}] ${message}`;
}

function shouldLog(level: LogLevel): boolean {
  const levels: LogLevel[] = ["SILENT", "ERROR", "WARN", "INFO", "VERBOSE", "DEBUG"];
  const currentIndex = levels.indexOf(currentLogLevel);
  const messageIndex = levels.indexOf(level);
  return messageIndex <= currentIndex;
}

export const log = {
  info(context: string, message: string): void {
    if (shouldLog("INFO")) {
      console.log(formatMsg("INFO", context, message));
    }
  },

  warn(context: string, message: string): void {
    if (shouldLog("WARN")) {
      console.warn(formatMsg("WARN", context, message));
    }
  },

  error(context: string, message: string, err?: unknown): void {
    if (shouldLog("ERROR")) {
      const extra =
        err instanceof Error ? ` | ${err.message}` : err ? ` | ${String(err)}` : "";
      console.error(formatMsg("ERROR", context, message + extra));
    }
  },

  debug(context: string, message: string): void {
    if (shouldLog("DEBUG")) {
      console.debug(formatMsg("DEBUG", context, message));
    }
  },

  verbose(context: string, message: string): void {
    if (shouldLog("VERBOSE")) {
      console.log(formatMsg("VERBOSE", context, message));
    }
  },

  startup(message: string): void {
    console.log(formatMsg("INFO", "startup", message));
  },

  // Detailed logging for LLM interactions
  request(
    context: string,
    model: string,
    provider: string,
    url: string,
    body: any,
    headers?: Record<string, string>
  ): void {
    if (shouldLog("DEBUG")) {
      const bodyPreview = JSON.stringify(body, null, 2);
      const truncatedBody = bodyPreview.length > 2000
        ? bodyPreview.substring(0, 2000) + "... (truncated)"
        : bodyPreview;
      console.log(formatMsg("DEBUG", context, `→ ${provider}/${model}`));
      console.log(formatMsg("DEBUG", context, `URL: ${url}`));
      if (headers) {
        const safeHeaders = { ...headers };
        if (safeHeaders["x-api-key"]) safeHeaders["x-api-key"] = "***";
        if (safeHeaders["Authorization"]) safeHeaders["Authorization"] = "***";
        console.log(formatMsg("DEBUG", context, `Headers: ${JSON.stringify(safeHeaders)}`));
      }
      console.log(formatMsg("DEBUG", context, `Body:\n${truncatedBody}`));
    }
  },

  response(
    context: string,
    model: string,
    provider: string,
    status: number,
    latencyMs: number,
    tokensIn?: number,
    tokensOut?: number,
    body?: any
  ): void {
    if (shouldLog("VERBOSE")) {
      const tokenInfo = tokensIn !== undefined && tokensOut !== undefined
        ? ` | in:${tokensIn} out:${tokensOut}`
        : "";
      console.log(formatMsg("VERBOSE", context, `← ${provider}/${model} ${status} (${latencyMs}ms${tokenInfo})`));
    }
    if (shouldLog("DEBUG") && body) {
      const bodyPreview = JSON.stringify(body, null, 2);
      const truncatedBody = bodyPreview.length > 2000
        ? bodyPreview.substring(0, 2000) + "... (truncated)"
        : bodyPreview;
      console.log(formatMsg("DEBUG", context, `Response:\n${truncatedBody}`));
    }
  },

  errorResponse(
    context: string,
    model: string,
    provider: string,
    status: number,
    statusText: string,
    body?: string
  ): void {
    if (shouldLog("WARN")) {
      console.warn(formatMsg("WARN", context, `✗ ${provider}/${model} ${status} ${statusText}`));
    }
    if (shouldLog("VERBOSE") && body) {
      const truncated = body.length > 500 ? body.substring(0, 500) + "... (truncated)" : body;
      console.log(formatMsg("VERBOSE", context, `Error body: ${truncated}`));
    }
  },

  streamChunk(
    context: string,
    model: string,
    chunkType: string,
    contentPreview?: string
  ): void {
    if (shouldLog("DEBUG")) {
      const preview = contentPreview
        ? ` | "${contentPreview.substring(0, 100)}${contentPreview.length > 100 ? "..." : ""}"`
        : "";
      console.log(formatMsg("DEBUG", context, `chunk ${model}: ${chunkType}${preview}`));
    }
  },
};
