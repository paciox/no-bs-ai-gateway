// ─── Structured logger ──────────────────────────────────────────────────────
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

// ─── File logging ─────────────────────────────────────────────────────────────

let fileLoggingEnabled = false;
let fileLogDir = process.cwd();
let currentLogDate = "";  // YYYY-MM-DD of the currently open log file

export function configureFileLogging(enabled: boolean, logDir: string): void {
  fileLoggingEnabled = enabled;
  fileLogDir = logDir;
  if (enabled) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch { /* dir already exists */ }
  }
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  currentLogDate = date;
  return join(fileLogDir, `logfile.${date}`);
}

function writeToFile(line: string): void {
  if (!fileLoggingEnabled) return;
  try {
    appendFileSync(getLogFilePath(), line + "\n", "utf-8");
  } catch { /* swallow write errors — never break the gateway over logging */ }
}

// Write a block separator + labelled section to the file (used for full JSON dumps)
function writeBlockToFile(level: LogLevel, context: string, label: string, content: string): void {
  if (!fileLoggingEnabled) return;
  const ts = timestamp();
  const header = `[${ts}] [${level}] [${context}] ── ${label} ──────────────────────────────────`;
  writeToFile(header);
  // Write content line by line so each line is readable
  for (const line of content.split("\n")) {
    writeToFile(line);
  }
  writeToFile(`[${ts}] [${level}] [${context}] ── end ${label} ────────────────────────────────`);
}

export const log = {
  info(context: string, message: string): void {
    if (shouldLog("INFO")) {
      const line = formatMsg("INFO", context, message);
      console.log(line);
      writeToFile(line);
    }
  },

  warn(context: string, message: string): void {
    if (shouldLog("WARN")) {
      const line = formatMsg("WARN", context, message);
      console.warn(line);
      writeToFile(line);
    }
  },

  error(context: string, message: string, err?: unknown): void {
    if (shouldLog("ERROR")) {
      const extra =
        err instanceof Error ? ` | ${err.message}` : err ? ` | ${String(err)}` : "";
      const full = message + extra;
      console.error(formatMsg("ERROR", context, full));
      writeToFile(formatMsg("ERROR", context, full));
      if (shouldLog("DEBUG") && err instanceof Error && err.stack) {
        writeToFile(formatMsg("DEBUG", context, `Stack: ${err.stack}`));
      }
    }
  },

  debug(context: string, message: string): void {
    if (shouldLog("DEBUG")) {
      console.debug(formatMsg("DEBUG", context, message));
      writeToFile(formatMsg("DEBUG", context, message));
    }
  },

  verbose(context: string, message: string): void {
    if (shouldLog("VERBOSE")) {
      console.log(formatMsg("VERBOSE", context, message));
      writeToFile(formatMsg("VERBOSE", context, message));
    }
  },

  startup(message: string): void {
    const line = formatMsg("INFO", "startup", message);
    console.log(line);
    writeToFile(line);
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
    function extractText(content: any, limit: number): string {
      if (typeof content === "string") return content.substring(0, limit);
      if (Array.isArray(content)) {
        return content
          .map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`))
          .join(" ")
          .substring(0, limit);
      }
      return String(content).substring(0, limit);
    }

    if (shouldLog("VERBOSE")) {
      const messages: any[] = body?.messages ?? [];
      const systemMsg = messages.find((m: any) => m.role === "system");
      const userMessages = messages.filter((m: any) => m.role === "user");
      const lastUser = userMessages[userMessages.length - 1];

      const parts: string[] = [`→ ${provider}/${model} (${messages.length} msg${messages.length !== 1 ? "s" : ""})`];
      if (systemMsg?.content) {
        const preview = extractText(systemMsg.content, 300);
        parts.push(`[system] ${preview}${systemMsg.content.length > 300 ? "…" : ""}`);
      }
      if (lastUser?.content) {
        const preview = extractText(lastUser.content, 500);
        parts.push(`[user] ${preview}${(typeof lastUser.content === "string" ? lastUser.content.length : 9999) > 500 ? "…" : ""}`);
      }
      const consoleMsg = parts.join("\n  ");
      console.log(formatMsg("VERBOSE", context, consoleMsg));

      // File: write the summary line, then full messages array for all roles
      writeToFile(formatMsg("VERBOSE", context, `→ ${provider}/${model} | url: ${url} | msgs: ${messages.length}`));
      for (const msg of messages) {
        const role = msg.role ?? "?";
        const content = extractText(msg.content, 100_000); // effectively unlimited for file
        writeToFile(formatMsg("VERBOSE", context, `  [${role}] ${content}`));
      }
    }
    if (shouldLog("DEBUG")) {
      const safeHeaders = headers ? { ...headers } : {};
      if (safeHeaders["x-api-key"]) safeHeaders["x-api-key"] = "***";
      if (safeHeaders["Authorization"]) safeHeaders["Authorization"] = "***";

      console.log(formatMsg("DEBUG", context, `URL: ${url}`));
      console.log(formatMsg("DEBUG", context, `Headers: ${JSON.stringify(safeHeaders)}`));
      const bodyStr = JSON.stringify(body, null, 2);
      const truncated = bodyStr.length > 2000 ? bodyStr.substring(0, 2000) + "... (truncated)" : bodyStr;
      console.log(formatMsg("DEBUG", context, `Body:\n${truncated}`));

      // File: dump full request JSON (untruncated) and headers
      writeToFile(formatMsg("DEBUG", context, `Headers: ${JSON.stringify(safeHeaders)}`));
      writeBlockToFile("DEBUG", context, "REQUEST BODY", JSON.stringify(body, null, 2));
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
    contentPreview?: string
  ): void {
    if (shouldLog("VERBOSE")) {
      const tokenInfo = tokensIn !== undefined && tokensOut !== undefined
        ? ` | in:${tokensIn} out:${tokensOut}`
        : "";
      const summaryLine = `← ${provider}/${model} ${status} (${latencyMs}ms${tokenInfo})`;
      console.log(formatMsg("VERBOSE", context, summaryLine));
      writeToFile(formatMsg("VERBOSE", context, summaryLine));

      if (contentPreview) {
        const consoleTrunc = contentPreview.length > 500 ? contentPreview.substring(0, 500) + "…" : contentPreview;
        console.log(formatMsg("VERBOSE", context, `  [assistant] ${consoleTrunc}`));
        // File gets the full content (no truncation)
        writeToFile(formatMsg("VERBOSE", context, `  [assistant] ${contentPreview}`));
      }
    }
  },

  // Call this variant when you have the full raw response JSON to dump to file
  responseRaw(
    context: string,
    model: string,
    provider: string,
    status: number,
    latencyMs: number,
    rawBody: string,
    tokensIn?: number,
    tokensOut?: number,
    contentPreview?: string
  ): void {
    // Delegate the console/file summary to response()
    log.response(context, model, provider, status, latencyMs, tokensIn, tokensOut, contentPreview);
    // Additionally dump the full raw JSON to file at VERBOSE+
    if (shouldLog("VERBOSE")) {
      try {
        const pretty = JSON.stringify(JSON.parse(rawBody), null, 2);
        writeBlockToFile("VERBOSE", context, "RESPONSE JSON", pretty);
      } catch {
        writeBlockToFile("VERBOSE", context, "RESPONSE RAW", rawBody);
      }
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
    const warnLine = `✗ ${provider}/${model} ${status} ${statusText}`;
    if (shouldLog("WARN")) {
      console.warn(formatMsg("WARN", context, warnLine));
      writeToFile(formatMsg("WARN", context, warnLine));
    }
    if (shouldLog("VERBOSE") && body) {
      const consoleTrunc = body.length > 500 ? body.substring(0, 500) + "... (truncated)" : body;
      console.log(formatMsg("VERBOSE", context, `Error body: ${consoleTrunc}`));
      // File: full error body, parsed if possible
      try {
        const pretty = JSON.stringify(JSON.parse(body), null, 2);
        writeBlockToFile("VERBOSE", context, "ERROR RESPONSE JSON", pretty);
      } catch {
        writeBlockToFile("VERBOSE", context, "ERROR RESPONSE RAW", body);
      }
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
      const line = formatMsg("DEBUG", context, `chunk ${model}: ${chunkType}${preview}`);
      console.log(line);
      writeToFile(line);
    }
  },
};
