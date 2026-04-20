// ─── Model registry — maps providerName/modelId to resolved config ──────────
import type { ResolvedConfig, ResolvedModelConfig, ResolvedProviderConfig } from "./config.js";
import {
  modelNotFound,
  modelDisabled,
  providerDisabled,
  modelGone,
  type GatewayError,
} from "./errors.js";
import { getModelStatus } from "./db.js";
import { log } from "./logger.js";

export interface RegistryEntry {
  key: string; // "providerName/modelId"
  provider: ResolvedProviderConfig;
  model: ResolvedModelConfig;
}

let registry = new Map<string, RegistryEntry>();

export function buildRegistry(config: ResolvedConfig): void {
  const newRegistry = new Map<string, RegistryEntry>();
  let enabledCount = 0;
  let disabledCount = 0;

  for (const provider of config.providers) {
    for (const model of provider.models) {
      const key = `${provider.name}/${model.modelId}`;
      newRegistry.set(key, { key, provider, model });

      if (provider.enabled && model.enabled) {
        enabledCount++;
      } else {
        disabledCount++;
      }
    }
  }

  registry = newRegistry;
  log.startup(
    `Registry built: ${enabledCount} enabled models, ${disabledCount} disabled`
  );

  // Log disabled items as warnings
  for (const provider of config.providers) {
    if (!provider.enabled) {
      log.warn("registry", `Provider "${provider.name}" is DISABLED`);
    }
    for (const model of provider.models) {
      if (!model.enabled) {
        log.warn(
          "registry",
          `Model "${provider.name}/${model.modelId}" is DISABLED`
        );
      }
    }
  }
}

export function resolveModel(
  requestedModel: string
): RegistryEntry | GatewayError {
  const entry = registry.get(requestedModel);

  if (!entry) {
    const available = listAvailableModelKeys();
    return modelNotFound(requestedModel, available);
  }

  if (!entry.provider.enabled) {
    return providerDisabled(requestedModel, entry.provider.name);
  }

  if (!entry.model.enabled) {
    return modelDisabled(requestedModel);
  }

  // Check if model was marked as gone by scanner
  const status = getModelStatus(entry.provider.name, entry.model.modelId);
  if (status && !status.available) {
    return modelGone(requestedModel);
  }

  return entry;
}

export function listAvailableModelKeys(): string[] {
  const keys: string[] = [];
  for (const [key, entry] of registry) {
    if (entry.provider.enabled && entry.model.enabled) {
      keys.push(key);
    }
  }
  return keys;
}

export function listAllEntries(): RegistryEntry[] {
  return Array.from(registry.values());
}

export function getRegistry(): Map<string, RegistryEntry> {
  return registry;
}

export function isGatewayError(value: unknown): value is GatewayError {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "statusCode" in value &&
    "message" in value
  );
}
