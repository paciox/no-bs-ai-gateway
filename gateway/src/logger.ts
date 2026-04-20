// ─── Structured logger ──────────────────────────────────────────────────────

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function timestamp(): string {
  return new Date().toISOString();
}

function formatMsg(level: LogLevel, context: string, message: string): string {
  return `[${timestamp()}] [${level}] [${context}] ${message}`;
}

export const log = {
  info(context: string, message: string): void {
    console.log(formatMsg("INFO", context, message));
  },

  warn(context: string, message: string): void {
    console.warn(formatMsg("WARN", context, message));
  },

  error(context: string, message: string, err?: unknown): void {
    const extra =
      err instanceof Error ? ` | ${err.message}` : err ? ` | ${String(err)}` : "";
    console.error(formatMsg("ERROR", context, message + extra));
  },

  debug(context: string, message: string): void {
    if (process.env.DEBUG) {
      console.debug(formatMsg("DEBUG", context, message));
    }
  },

  startup(message: string): void {
    console.log(formatMsg("INFO", "startup", message));
  },
};
