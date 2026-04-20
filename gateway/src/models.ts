// ─── GET /v1/models endpoint ─────────────────────────────────────────────────
import { listAllEntries } from "./registry.js";
import { getModelStatus } from "./db.js";

export function handleListModels(): {
  object: string;
  data: any[];
} {
  const entries = listAllEntries();
  const now = Math.floor(Date.now() / 1000);

  const data = entries
    .filter((e) => e.provider.enabled && e.model.enabled)
    .map((e) => {
      const status = getModelStatus(e.provider.name, e.model.modelId);

      return {
        id: e.key, // e.g. "openrouter/openai/gpt-4"
        object: "model",
        created: now,
        owned_by: e.provider.name,
        context_window: e.model.contextWindow,
        max_tokens: e.model.maxTokens,
        capabilities: e.model.capabilities,
        status: status
          ? status.available
            ? "available"
            : "unavailable"
          : "unknown",
      };
    });

  return { object: "list", data };
}
