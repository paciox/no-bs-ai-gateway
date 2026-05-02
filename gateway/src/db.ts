// ─── SQLite database for request logging & model status ─────────────────────
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { log } from "./logger.js";

let db: Database.Database | null = null;

export function initDb(dbPath?: string): Database.Database {
  const filePath = dbPath ?? resolve(process.cwd(), "no-bs-ai-gateway.db");
  db = new Database(filePath);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      latency_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      stream INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      request_summary TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      request_id INTEGER,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      error_type TEXT NOT NULL,
      error_message TEXT NOT NULL,
      http_status INTEGER,
      attempt_number INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS model_status (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      last_seen TEXT,
      available INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      PRIMARY KEY (provider, model_id)
    );

    CREATE TABLE IF NOT EXISTS circuit_breaker (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_error_time TEXT,
      blacklisted_until TEXT,
      PRIMARY KEY (provider, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
    CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
    CREATE INDEX IF NOT EXISTS idx_errors_timestamp ON errors(timestamp);
    CREATE INDEX IF NOT EXISTS idx_errors_request_id ON errors(request_id);
  `);

  log.startup(`Database initialized at ${filePath}`);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

// ─── Request logging ─────────────────────────────────────────────────────────

export interface RequestRecord {
  model: string;
  provider: string;
  stream: boolean;
  request_summary?: string;
}

export function insertRequest(record: RequestRecord): number {
  const stmt = getDb().prepare(`
    INSERT INTO requests (model, provider, stream, request_summary)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(
    record.model,
    record.provider,
    record.stream ? 1 : 0,
    record.request_summary ?? null
  );
  return Number(result.lastInsertRowid);
}

export function completeRequest(
  id: number,
  status: "success" | "error",
  latencyMs: number,
  opts?: {
    tokensIn?: number;
    tokensOut?: number;
    error?: string;
    retryCount?: number;
  }
): void {
  getDb()
    .prepare(
      `UPDATE requests SET status = ?, latency_ms = ?, tokens_in = ?, tokens_out = ?, error = ?, retry_count = ? WHERE id = ?`
    )
    .run(
      status,
      latencyMs,
      opts?.tokensIn ?? null,
      opts?.tokensOut ?? null,
      opts?.error ?? null,
      opts?.retryCount ?? 0,
      id
    );
}

// ─── Error logging ───────────────────────────────────────────────────────────

export function insertError(record: {
  requestId: number | null;
  model: string;
  provider: string;
  errorType: string;
  errorMessage: string;
  httpStatus?: number;
  attemptNumber: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO errors (request_id, model, provider, error_type, error_message, http_status, attempt_number)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.requestId,
      record.model,
      record.provider,
      record.errorType,
      record.errorMessage,
      record.httpStatus ?? null,
      record.attemptNumber
    );
}

// ─── Model status ────────────────────────────────────────────────────────────

export function upsertModelStatus(
  provider: string,
  modelId: string,
  available: boolean,
  lastError?: string
): void {
  getDb()
    .prepare(
      `INSERT INTO model_status (provider, model_id, last_seen, available, last_error)
     VALUES (?, ?, datetime('now'), ?, ?)
     ON CONFLICT(provider, model_id) DO UPDATE SET
       last_seen = datetime('now'),
       available = excluded.available,
       last_error = excluded.last_error`
    )
    .run(provider, modelId, available ? 1 : 0, lastError ?? null);
}

export function getModelStatus(
  provider: string,
  modelId: string
): { available: boolean; last_error: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT available, last_error FROM model_status WHERE provider = ? AND model_id = ?`
    )
    .get(provider, modelId) as
    | { available: number; last_error: string | null }
    | undefined;
  if (!row) return null;
  return { available: row.available === 1, last_error: row.last_error };
}

// ─── Circuit breaker functions ───────────────────────────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 3; // errors before blacklisting
const CIRCUIT_BREAKER_DURATION_MS = 5 * 60 * 1000; // 5 minutes blacklist

export function recordModelError(provider: string, modelId: string): boolean {
  const now = new Date().toISOString();
  const db = getDb();

  // Check current state
  const row = db
    .prepare(
      `SELECT error_count, blacklisted_until FROM circuit_breaker WHERE provider = ? AND model_id = ?`
    )
    .get(provider, modelId) as
    | { error_count: number; blacklisted_until: string | null }
    | undefined;

  if (row) {
    const errorCount = row.error_count + 1;
    const blacklistedUntil =
      errorCount >= CIRCUIT_BREAKER_THRESHOLD
        ? new Date(Date.now() + CIRCUIT_BREAKER_DURATION_MS).toISOString()
        : row.blacklisted_until;

    db.prepare(
      `UPDATE circuit_breaker SET error_count = ?, last_error_time = ?, blacklisted_until = ? WHERE provider = ? AND model_id = ?`
    ).run(errorCount, now, blacklistedUntil, provider, modelId);

    return blacklistedUntil !== null;
  } else {
    // First error - insert with count 1
    db.prepare(
      `INSERT INTO circuit_breaker (provider, model_id, error_count, last_error_time, blacklisted_until) VALUES (?, ?, 1, ?, NULL)`
    ).run(provider, modelId, now);
    return false;
  }
}

export function isModelBlacklisted(provider: string, modelId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT blacklisted_until FROM circuit_breaker WHERE provider = ? AND model_id = ?`
    )
    .get(provider, modelId) as { blacklisted_until: string | null } | undefined;

  if (!row || !row.blacklisted_until) return false;

  const blacklistedUntil = new Date(row.blacklisted_until);
  if (blacklistedUntil > new Date()) {
    return true;
  }

  // Blacklist expired - clear it
  clearCircuitBreaker(provider, modelId);
  return false;
}

export function clearCircuitBreaker(provider: string, modelId: string): void {
  getDb()
    .prepare(
      `DELETE FROM circuit_breaker WHERE provider = ? AND model_id = ?`
    )
    .run(provider, modelId);
}

export function recordModelSuccess(provider: string, modelId: string): void {
  // Reset error count on success
  clearCircuitBreaker(provider, modelId);
}

// ─── Query helpers for UI API ────────────────────────────────────────────────

export function getRecentRequests(limit = 100, offset = 0) {
  return getDb()
    .prepare(
      `SELECT * FROM requests ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function getRecentErrors(limit = 100, offset = 0) {
  return getDb()
    .prepare(
      `SELECT * FROM errors ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function getStats() {
  const db = getDb();
  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM requests`).get() as any
  ).count;
  const errors = (
    db.prepare(`SELECT COUNT(*) as count FROM requests WHERE status = 'error'`).get() as any
  ).count;
  const last24h = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM requests WHERE timestamp > datetime('now', '-1 day')`
      )
      .get() as any
  ).count;
  const avgLatency = (
    db
      .prepare(
        `SELECT AVG(latency_ms) as avg FROM requests WHERE latency_ms IS NOT NULL`
      )
      .get() as any
  ).avg;

  return {
    total_requests: total,
    total_errors: errors,
    error_rate: total > 0 ? ((errors / total) * 100).toFixed(1) + "%" : "0%",
    requests_last_24h: last24h,
    avg_latency_ms: avgLatency ? Math.round(avgLatency) : null,
  };
}

export function getAllModelStatuses() {
  return getDb().prepare(`SELECT * FROM model_status`).all();
}

// ─── Pruning ─────────────────────────────────────────────────────────────────

export function pruneOldRecords(retentionDays: number): void {
  const db = getDb();
  // Remove errors referencing old requests first to satisfy FK constraint
  db.prepare(
    `DELETE FROM errors WHERE request_id IN (SELECT id FROM requests WHERE timestamp < datetime('now', ? || ' days'))`
  ).run(`-${retentionDays}`);
  const deleted1 = db
    .prepare(
      `DELETE FROM errors WHERE timestamp < datetime('now', ? || ' days')`
    )
    .run(`-${retentionDays}`);
  const deleted2 = db
    .prepare(
      `DELETE FROM requests WHERE timestamp < datetime('now', ? || ' days')`
    )
    .run(`-${retentionDays}`);
  if (
    (deleted1.changes as number) > 0 ||
    (deleted2.changes as number) > 0
  ) {
    log.info(
      "db",
      `Pruned ${deleted2.changes} requests and ${deleted1.changes} errors older than ${retentionDays} days`
    );
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
