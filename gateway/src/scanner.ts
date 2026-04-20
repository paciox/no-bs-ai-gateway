// ─── Upstream model availability scanner ────────────────────────────────────
import type { ResolvedConfig, ResolvedProviderConfig } from "./config.js";
import { upsertModelStatus } from "./db.js";
import { log } from "./logger.js";

let scanTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Scan a single provider's /models endpoint and check which configured models exist.
 */
async function scanProvider(provider: ResolvedProviderConfig): Promise<void> {
  if (!provider.enabled) return;

  const url = `${provider.baseUrl}/models`;
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
      signal: AbortSignal.timeout(15_000), // 15s timeout for scan
    });

    if (!response.ok) {
      log.warn(
        "scanner",
        `Provider "${provider.name}" /models returned ${response.status} — skipping scan`
      );
      // Don't mark models as unavailable if we can't reach the endpoint
      return;
    }

    const body = await response.json() as { data?: Array<{ id: string }> };

    if (!body.data || !Array.isArray(body.data)) {
      log.warn(
        "scanner",
        `Provider "${provider.name}" /models returned unexpected format — skipping`
      );
      return;
    }

    // Build set of upstream model IDs
    const upstreamIds = new Set(body.data.map((m) => m.id));

    for (const model of provider.models) {
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
      `Scanned "${provider.name}": ${upstreamIds.size} models upstream, ${provider.models.length} configured`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      "scanner",
      `Failed to scan "${provider.name}": ${msg} — assuming models are available`
    );
    // On scan failure, don't mark anything unavailable
  }
}

/**
 * Scan all providers.
 */
export async function scanAll(config: ResolvedConfig): Promise<void> {
  log.info("scanner", "Starting model availability scan...");
  const promises = config.providers.map((p) => scanProvider(p));
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
