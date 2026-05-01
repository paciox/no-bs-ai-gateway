// ─── Entry point ─────────────────────────────────────────────────────────────
import { watchFile } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, reloadConfig, type ResolvedConfig } from "./config.js";
import { initDb, closeDb, pruneOldRecords } from "./db.js";
import { buildRegistry } from "./registry.js";
import { createGatewayServer, invalidateUiCache } from "./server.js";
import { startScanner, stopScanner, scanAll } from "./scanner.js";
import { log, setLogLevel } from "./logger.js";

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs(): { configPath?: string } {
  const args = process.argv.slice(2);
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    }
  }

  return { configPath };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { configPath } = parseArgs();

  console.log(`
╔══════════════════════════════════════════╗
║        No-BS AI Gateway v0.1.0          ║
╚══════════════════════════════════════════╝
`);

  // 1. Load config
  let config: ResolvedConfig;
  try {
    config = loadConfig(configPath);
    // Apply log level from config
    setLogLevel(config.logLevel);
    log.startup("Config loaded successfully");
  } catch (err: any) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }

  // 2. Init database
  initDb();
  pruneOldRecords(config.dbRetentionDays);

  // 3. Build model registry
  buildRegistry(config);

  // 4. Create and start HTTP server
  const server = createGatewayServer(config);

  server.listen(config.port, config.host, () => {
    log.startup(`Server listening on http://${config.host}:${config.port}`);
    log.startup(`Web UI:              http://${config.host}:${config.port}/`);
    log.startup(`Models endpoint:     http://${config.host}:${config.port}/v1/models`);
    log.startup(`Chat completions:    http://${config.host}:${config.port}/v1/chat/completions`);
    log.startup(`Health check:        http://${config.host}:${config.port}/health`);
  });

  // 5. Start model scanner
  startScanner(config);

  // 6. Watch config file for hot-reload
  const configFilePath = configPath
    ? resolve(configPath)
    : resolve(process.cwd(), "no-bs-ai-gateway.config.json");

  watchFile(configFilePath, { interval: 2000 }, () => {
    log.info("config", "Config file changed, reloading...");
    try {
      const newConfig = reloadConfig(configPath);
      config = newConfig;
      setLogLevel(config.logLevel);
      buildRegistry(config);
      invalidateUiCache();
      // Re-scan with new config
      scanAll(config).catch((err) =>
        log.error("config", "Re-scan after config reload failed", err)
      );
      log.info("config", "Config reloaded successfully");
    } catch (err: any) {
      // On reload, fallback-only validation errors are warnings — keep previous config
      if (err.name === "ConfigError" && err.message.includes("Fallback configuration errors:")) {
        log.warn("config", `Fallback config warning: ${err.message} — keeping previous config`);
      } else {
        log.error("config", `Config reload failed: ${err.message} — keeping previous config`);
      }
    }
  });

  // 7. Periodic pruning (once per hour)
  setInterval(() => {
    pruneOldRecords(config.dbRetentionDays);
  }, 60 * 60 * 1000);

  // 8. Graceful shutdown
  const shutdown = () => {
    log.info("shutdown", "Shutting down...");
    stopScanner();
    server.close(() => {
      closeDb();
      log.info("shutdown", "Server closed. Goodbye.");
      process.exit(0);
    });
    // Force exit after 5s if graceful fails
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
