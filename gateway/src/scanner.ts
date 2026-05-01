// ─── Upstream model availability scanner ────────────────────────────────────
import type { ResolvedConfig, ResolvedProviderConfig } from "./config.js";
import { upsertModelStatus } from "./db.js";
import { log } from "./logger.js";

let scanTimer: ReturnType<typeof setInterval> | null = null;

function getModelsUrl(provider: ResolvedProviderConfig): string | null {
  if (provider.name === "anthropic") {
    return null;
  }

  // baseUrl is normalized by config.ts to always end with a version segment (e.g. /v1),
  // so appending /models yields the correct versioned endpoint for all providers.
  return `${provider.baseUrl}/models`;
}

/**
 * Scan a single provider's /models endpoint and check which configured models exist.
 */
async function scanProvider(provider: ResolvedProviderConfig, scanTimeoutMs: number): Promise<void> {
  if (!provider.enabled) return;

  const url = getModelsUrl(provider);
  if (!url) {
    log.info(
      "scanner",
      `Provider "${provider.name}" does not expose a model-list endpoint; keeping existing availability state`
    );
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (provider.authHeader === "x-api-key") {
    headers["x-api-key"] = provider.apiKey;
  } else {
    headers[provider.authHeader] = `Bearer ${provider.apiKey}`;
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(scanTimeoutMs),
    });

    if (!response.ok) {
      log.warn(
        "scanner",
        `Provider "${provider.name}" model-list endpoint returned ${response.status}; keeping existing availability state`
      );
      return;
    }

    let body: { data?: Array<{ id: string }> };
    try {
      body = await response.json() as { data?: Array<{ id: string }> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        "scanner",
        `Provider "${provider.name}" model-list endpoint returned invalid JSON (${msg}); keeping existing availability state`
      );
      return;
    }

    if (!body.data || !Array.isArray(body.data)) {
      log.warn(
        "scanner",
        `Provider "${provider.name}" model-list endpoint returned unexpected format; keeping existing availability state`
      );
      return;
    }

    // Build set of upstream model IDs
    const upstreamIds = new Set(body.data.map((m) => m.id));

    const enabledModels = provider.models.filter((model) => model.enabled);

    for (const model of enabledModels) {
      const available = upstreamIds.has(model.modelId);
      upsertModelStatus(provider.name, model.modelId, available);

      if (!available) {
        log.warn(
          "scanner",
          `Model "${provider.name}/${model.modelId}" NOT found in upstream provider — marking as unavailable`
        );
      }
    }

    log.info(
      "scanner",
      `Scanned "${provider.name}": ${upstreamIds.size} models upstream, ${enabledModels.length} enabled`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      "scanner",
      `Provider "${provider.name}" scan failed: ${msg}; keeping existing availability state`
    );
  }
}

/**
 * Scan all providers.
 */
export async function scanAll(config: ResolvedConfig): Promise<void> {
  log.info("scanner", "Starting model availability scan...");
  const promises = config.providers.map((p) => scanProvider(p, config.scanTimeoutMs));
  await Promise.allSettled(promises);
  log.info("scanner", "Model availability scan complete");
}

/**
 * Start periodic scanning.
 */
export function startScanner(config: ResolvedConfig): void {
  // Initial scan
  scanAll(config).catch((err) =>
    log.error("scanner", "Initial scan failed", err)
  );

  // Periodic scan
  scanTimer = setInterval(() => {
    scanAll(config).catch((err) =>
      log.error("scanner", "Periodic scan failed", err)
    );
  }, config.scanIntervalMs);

  log.startup(
    `Scanner started (interval: ${Math.round(config.scanIntervalMs / 60_000)}min)`
  );
}

/**
 * Stop periodic scanning.
 */
export function stopScanner(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}
