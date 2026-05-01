// ─── Config types & loader ───────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LogLevel } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelCapabilities {
  tools?: boolean;
  images?: boolean;
  streaming?: boolean;
  thinking?: boolean;
  files?: boolean;
  embeddings?: boolean;
}

export interface ModelConfig {
  modelId: string;
  enabled: boolean;
  contextWindow?: number;
  maxTokens?: number;
  retries?: number;
  retriesDelayMs?: number;
  capabilities?: ModelCapabilities;
  /** cascade mode: global unique ordering integer (positive) */
  fallbackOrder?: number;
  /** model_specific mode: ordered list of "providerName/modelId" fallback keys */
  fallbackModels?: string[];
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  retries?: number;
  retriesDelayMs?: number;
  timeout?: number;
  enabled: boolean;
  authHeader?: string; // default "Authorization", some use "x-api-key"
  anthropicVersion?: string; // for Anthropic API: "2023-06-01"
  models: ModelConfig[];
}

export type FallbackModality = "cascade" | "model_specific";

export interface GatewayConfig {
  port: number;
  host: string;
  maxBodySize?: number; // bytes, default 50MB
  dbRetentionDays?: number; // default 7
  scanIntervalMs?: number; // default 30 min
  cascadeEnabled?: boolean;
  fallBackModality?: FallbackModality;
  fallbackLimit?: number; // max fallback hops after primary (0 = no fallback)
  logLevel?: LogLevel; // default "INFO"
  logFile?: boolean; // write logs to file (default false)
  logDir?: string; // directory for log files (default: process.cwd())
  streamStallTimeoutMs?: number; // SSE no-data timeout, default 60s
  scanTimeoutMs?: number; // upstream /models scan timeout, default 15s
  providers: Array<Record<string, ProviderConfig>>;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 4000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB
const DEFAULT_DB_RETENTION_DAYS = 7;
const DEFAULT_SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_SCAN_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 0;
const DEFAULT_RETRIES_DELAY_MS = 1000;

// ─── Resolved types (post-validation, with defaults applied) ─────────────────

export interface ResolvedModelConfig {
  modelId: string;
  enabled: boolean;
  contextWindow: number;
  maxTokens: number;
  retries: number;
  retriesDelayMs: number;
  capabilities: Required<ModelCapabilities>;
  fallbackOrder?: number;
  fallbackModels?: string[];
}

export interface ResolvedProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  retries: number;
  retriesDelayMs: number;
  timeout: number;
  enabled: boolean;
  authHeader: string;
  anthropicVersion?: string;
  models: ResolvedModelConfig[];
}

export interface ResolvedConfig {
  port: number;
  host: string;
  maxBodySize: number;
  dbRetentionDays: number;
  scanIntervalMs: number;
  cascadeEnabled: boolean;
  fallBackModality: FallbackModality;
  fallbackLimit: number;
  logLevel: LogLevel;
  logFile: boolean;
  logDir: string;
  streamStallTimeoutMs: number;
  scanTimeoutMs: number;
  providers: ResolvedProviderConfig[];
}

// ─── Validation ──────────────────────────────────────────────────────────────

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function validateUrl(url: string, path: string): void {
  try {
    new URL(url);
  } catch {
    throw new ConfigError(`Invalid URL at ${path}: "${url}"`);
  }
}

function resolveModel(
  model: ModelConfig,
  provider: ProviderConfig,
  providerName: string,
  index: number
): ResolvedModelConfig {
  const path = `providers.${providerName}.models[${index}]`;

  if (!model.modelId || typeof model.modelId !== "string") {
    throw new ConfigError(`${path}.modelId is required and must be a string`);
  }
  if (typeof model.enabled !== "boolean") {
    throw new ConfigError(`${path}.enabled is required and must be a boolean`);
  }

  return {
    modelId: model.modelId,
    enabled: model.enabled,
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 4096,
    retries: model.retries ?? provider.retries ?? DEFAULT_RETRIES,
    retriesDelayMs:
      model.retriesDelayMs ?? provider.retriesDelayMs ?? DEFAULT_RETRIES_DELAY_MS,
    capabilities: {
      tools: model.capabilities?.tools ?? false,
      images: model.capabilities?.images ?? false,
      streaming: model.capabilities?.streaming ?? true,
      thinking: model.capabilities?.thinking ?? false,
      files: model.capabilities?.files ?? false,
      embeddings: model.capabilities?.embeddings ?? false,
    },
    fallbackOrder: model.fallbackOrder,
    fallbackModels: model.fallbackModels,
  };
}

function resolveProvider(
  name: string,
  provider: ProviderConfig
): ResolvedProviderConfig {
  const path = `providers.${name}`;

  if (!provider.baseUrl || typeof provider.baseUrl !== "string") {
    throw new ConfigError(`${path}.baseUrl is required`);
  }
  validateUrl(provider.baseUrl, `${path}.baseUrl`);

  if (!provider.apiKey || typeof provider.apiKey !== "string") {
    throw new ConfigError(`${path}.apiKey is required`);
  }
  if (typeof provider.enabled !== "boolean") {
    throw new ConfigError(`${path}.enabled is required and must be a boolean`);
  }
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw new ConfigError(`${path}.models must be a non-empty array`);
  }

  const models = provider.models.map((m, i) =>
    resolveModel(m, provider, name, i)
  );

  // Check for duplicate modelIds within this provider
  const ids = new Set<string>();
  for (const m of models) {
    if (ids.has(m.modelId)) {
      throw new ConfigError(
        `Duplicate modelId "${m.modelId}" in provider "${name}"`
      );
    }
    ids.add(m.modelId);
  }

  // Normalize baseUrl: strip trailing slashes, then ensure a version segment
  // (/v1 or similar) is present. Users should configure this explicitly; this
  // is a defensive fallback only.
  const rawBase = provider.baseUrl.replace(/\/+$/, "");
  const normalizedBase = /\/v\d+$/.test(rawBase) ? rawBase : `${rawBase}/v1`;

  return {
    name,
    baseUrl: normalizedBase,
    apiKey: provider.apiKey,
    retries: provider.retries ?? DEFAULT_RETRIES,
    retriesDelayMs: provider.retriesDelayMs ?? DEFAULT_RETRIES_DELAY_MS,
    timeout: provider.timeout ?? DEFAULT_TIMEOUT,
    enabled: provider.enabled,
    authHeader: provider.authHeader ?? "Authorization",
    anthropicVersion: provider.anthropicVersion,
    models,
  };
}

export function validateAndResolve(raw: GatewayConfig): ResolvedConfig {
  if (!raw.providers || !Array.isArray(raw.providers)) {
    throw new ConfigError("'providers' must be an array");
  }
  if (raw.providers.length === 0) {
    throw new ConfigError("'providers' must contain at least one provider");
  }

  const providers: ResolvedProviderConfig[] = [];
  const allModelKeys = new Set<string>();

  for (const entry of raw.providers) {
    const names = Object.keys(entry);
    if (names.length !== 1) {
      throw new ConfigError(
        `Each provider entry must have exactly one key (provider name), got: ${JSON.stringify(names)}`
      );
    }
    const name = names[0];
    const providerRaw = entry[name];
    const resolved = resolveProvider(name, providerRaw);

    // Check for duplicate provider/modelId across all providers
    for (const m of resolved.models) {
      const key = `${name}/${m.modelId}`;
      if (allModelKeys.has(key)) {
        throw new ConfigError(`Duplicate model key "${key}" across providers`);
      }
      allModelKeys.add(key);
    }

    providers.push(resolved);
  }

  // ── Fallback validation ──────────────────────────────────────────────────
  const fallbackWarnings = validateFallbackConfig(raw, allModelKeys);
  if (fallbackWarnings.length > 0) {
    // On startup these are fatal; on reload caller catches and treats as warnings
    throw new ConfigError(
      `Fallback configuration errors:\n${fallbackWarnings.map((w) => `  - ${w}`).join("\n")}`
    );
  }

  return {
    port: raw.port ?? DEFAULT_PORT,
    host: raw.host ?? DEFAULT_HOST,
    maxBodySize: raw.maxBodySize ?? DEFAULT_MAX_BODY_SIZE,
    dbRetentionDays: raw.dbRetentionDays ?? DEFAULT_DB_RETENTION_DAYS,
    scanIntervalMs: raw.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
    cascadeEnabled: raw.cascadeEnabled ?? false,
    fallBackModality: raw.fallBackModality ?? "cascade",
    fallbackLimit: raw.fallbackLimit ?? 0,
    logLevel: raw.logLevel ?? "INFO",
    logFile: raw.logFile ?? false,
    logDir: raw.logDir ?? process.cwd(),
    streamStallTimeoutMs: raw.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS,
    scanTimeoutMs: raw.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
    providers,
  };
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export function loadConfig(configPath?: string): ResolvedConfig {
  const filePath = configPath
    ? resolve(configPath)
    : resolve(process.cwd(), "no-bs-ai-gateway.config.json");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new ConfigError(
        `Config file not found: ${filePath}\nCreate a no-bs-ai-gateway.config.json file or pass --config <path>`
      );
    }
    throw new ConfigError(`Failed to read config file: ${err.message}`);
  }

  let parsed: GatewayConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new ConfigError(`Invalid JSON in config file: ${err.message}`);
  }

  return validateAndResolve(parsed);
}

// Re-export for hot-reload
export function reloadConfig(configPath?: string): ResolvedConfig {
  return loadConfig(configPath);
}

// ─── Fallback validation ─────────────────────────────────────────────────────

function validateFallbackConfig(
  raw: GatewayConfig,
  allModelKeys: Set<string>
): string[] {
  const errors: string[] = [];

  // Validate fallBackModality
  if (
    raw.fallBackModality !== undefined &&
    raw.fallBackModality !== "cascade" &&
    raw.fallBackModality !== "model_specific"
  ) {
    errors.push(
      `fallBackModality must be "cascade" or "model_specific", got: "${raw.fallBackModality}"`
    );
  }

  // Validate fallbackLimit
  if (
    raw.fallbackLimit !== undefined &&
    (typeof raw.fallbackLimit !== "number" ||
      !Number.isInteger(raw.fallbackLimit) ||
      raw.fallbackLimit < 0)
  ) {
    errors.push(
      `fallbackLimit must be a non-negative integer, got: ${raw.fallbackLimit}`
    );
  }

  // Only validate model-level fields if fallback is enabled
  if (!raw.cascadeEnabled) {
    return errors;
  }

  const modality = raw.fallBackModality ?? "cascade";

  if (modality === "cascade") {
    // Validate fallbackOrder: globally unique, positive integer
    const seenOrders = new Map<number, string>(); // order -> model key
    for (const entry of raw.providers) {
      const pName = Object.keys(entry)[0];
      const pRaw = entry[pName];
      if (!pRaw?.models) continue;
      for (const model of pRaw.models) {
        if (model.fallbackOrder === undefined) continue;
        if (
          typeof model.fallbackOrder !== "number" ||
          !Number.isInteger(model.fallbackOrder) ||
          model.fallbackOrder < 1
        ) {
          errors.push(
            `Model "${pName}/${model.modelId}" fallbackOrder must be a positive integer, got: ${model.fallbackOrder}`
          );
          continue;
        }
        const key = `${pName}/${model.modelId}`;
        const existing = seenOrders.get(model.fallbackOrder);
        if (existing) {
          errors.push(
            `Duplicate fallbackOrder ${model.fallbackOrder}: "${existing}" and "${key}"`
          );
        } else {
          seenOrders.set(model.fallbackOrder, key);
        }
      }
    }
  }

  if (modality === "model_specific") {
    // Validate fallbackModels: must reference existing keys, no self-ref, no dupes
    for (const entry of raw.providers) {
      const pName = Object.keys(entry)[0];
      const pRaw = entry[pName];
      if (!pRaw?.models) continue;
      for (const model of pRaw.models) {
        if (!model.fallbackModels || model.fallbackModels.length === 0) continue;
        const key = `${pName}/${model.modelId}`;
        const seen = new Set<string>();
        for (const ref of model.fallbackModels) {
          if (ref === key) {
            errors.push(
              `Model "${key}" fallbackModels contains self-reference "${ref}"`
            );
          }
          if (seen.has(ref)) {
            errors.push(
              `Model "${key}" fallbackModels contains duplicate "${ref}"`
            );
          }
          seen.add(ref);
          if (!allModelKeys.has(ref)) {
            errors.push(
              `Model "${key}" fallbackModels references unknown model "${ref}" — must be a configured "providerName/modelId" key`
            );
          }
        }
      }
    }
  }

  return errors;
}
