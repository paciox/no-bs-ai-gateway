
# Introduction, before the AI generated guide:

I was tired of all the bullshit crap vibe coded shit.
Not because vibe coding is bad but because people who apparently played games on facebook until yesterday, woke up as a coder today thanks to AI and doesn't know how code works but wants to code anyway.
Tired of wasting time on shitty stuff like OmniRoute and Freerouter and all the copycat github repos, on which I wasted many hours configuring their advertised as easy configuration and instead these things are as brittle as linux, I did one by myself, and it's not here to please anyone but me. But if you like, keep it, fork it or whatever.
Just wanted to put this here to let know who is making thousand of clone of routers, that they're doing a shitty job. Go gardening.


# No-BS AI Gateway

A single OpenAI-compatible endpoint that sits in front of multiple AI providers — including native Anthropic support. One local URL for all your AI calls. No env vars, no magic routing, no "smart" fallbacks. You tell it which model to hit, it hits it.

---

## Why This Exists

Every AI router project out there tries to be clever. Auto-routing, tier systems, fallback chains, subscription models. You end up debugging the router instead of your actual code.

This gateway exists because:

- **Free-tier providers are unreliable alone.** OpenRouter, NVIDIA, and others give you free access to powerful models, but each one has rate limits, downtime, and random 503s. You need all of them available behind one endpoint.
- **Your code shouldn't care which provider serves a model.** Whether GPT-4 comes through OpenRouter or NVIDIA, your application sends the same request to the same URL.
- **Configuration belongs in a file, not scattered across env vars.** One JSON file. API keys, retry settings, model capabilities — all in one place.
- **You don't need a "smart" router.** You know which model you want. You just need it to work, retry when it doesn't, and tell you clearly when it can't.

---

## What It Does

```
Your App                    No-BS Gateway                 Providers
────────                    ─────────────                 ─────────
                                                          
POST /v1/chat/completions   ┌─────────────┐              
  model: "openrouter/       │  Resolve     │    fetch()   
         openai/gpt-4"  ──▶ │  Validate    │ ──────────▶  OpenRouter
  messages: [...]           │  Proxy       │              
                            │  Retry       │    fetch()   
                            │  Log         │ ──────────▶  NVIDIA
                            └─────────────┘              
                                                          
GET /v1/models              Returns your configured       
                            models in OpenAI format       
```

- **OpenAI-compatible endpoints** — `POST /v1/chat/completions` and `GET /v1/models`. Any tool that speaks OpenAI can point at this gateway.
- **Anthropic provider support** — configure Anthropic (`api.anthropic.com`) as a provider and the gateway transparently translates your OpenAI-format requests into Anthropic's native `/v1/messages` format and back. Your client code never changes.
- **Streaming and non-streaming** — SSE streaming proxied through with stall detection. If the upstream goes silent for 30 seconds, you get an error, not an infinite hang.
- **Tool calling, images, thinking tokens** — passed through to the upstream provider as-is. The gateway checks the model's configured capabilities and rejects requests that use unsupported features *before* wasting an API call.
- **Retry with backoff** — configurable per provider and per model. Model settings override provider settings. Retries on 429, 500, 502, 503, 504, and network errors. Never retries on 400, 401, 403.
- **Model availability scanning** — on startup and every 30 minutes, the gateway calls each provider's `/models` endpoint and checks if your configured models still exist. Gone models get blocked with a clear `410 Gone` error. Anthropic is skipped during scans (no public `/models` endpoint); its models are treated as always available.
- **Web dashboard** — dark-themed UI at `http://localhost:4000/` showing providers, models, request log, errors, and stats. Auto-refreshes every 5 seconds.
- **SQLite logging** — every request and error stored locally. Auto-prunes after 7 days.
- **Config hot-reload** — edit the config file while running. Changes are picked up automatically.

---

## How It Works

### Architecture

Zero external dependencies except `better-sqlite3`. The HTTP server, fetch calls, streaming, file watching — all Node.js built-ins.

```
src/
├── index.ts        Entry point — boots everything, wires shutdown
├── config.ts       Loads & validates the JSON config, resolves defaults
├── server.ts       HTTP server — routing, CORS, body parsing, UI serving
├── registry.ts     In-memory Map of provider/modelId → config
├── proxy.ts        Builds upstream request, dispatches fetch, handles response
├── streaming.ts    SSE proxy with stall detection, model field rewriting
├── retry.ts        Exponential backoff, Retry-After header support
├── models.ts       GET /v1/models response builder
├── scanner.ts      Calls upstream /models to verify availability
├── errors.ts       OpenAI-compatible error formatting
├── logger.ts       Structured console logging
├── db.ts           SQLite schema, request/error logging, stats queries
└── ui/
    └── index.html  Single-file dashboard (vanilla HTML/CSS/JS)
```

### Model Addressing

Models are addressed as `provider/modelId`. The provider name comes from your config, the modelId is whatever the upstream provider calls it.

```
openrouter/openai/gpt-4
openrouter/anthropic/claude-opus-4
nvidia/meta/llama-3.1-405b-instruct
```

When the gateway proxies to the upstream, it strips the provider prefix and sends just the `modelId` (e.g., `openai/gpt-4`) to the provider's `/chat/completions` endpoint.

### Fallback Models

When a model exhausts all its retries, the gateway can automatically try other models before returning an error. This is controlled by three top-level config properties:

| Property | Type | Description |
|---|---|---|
| `cascadeEnabled` | boolean | Master switch. `false` disables all fallback regardless of other settings |
| `fallBackModality` | `"cascade"` \| `"model_specific"` | Which fallback strategy to use |
| `fallbackLimit` | number | Max number of fallback hops after the primary model. `0` disables fallback even if `cascadeEnabled` is `true` |

**Property hierarchy applies here too** — each fallback candidate is attempted with its own resolved retry settings (model overrides provider).

**Streaming requests**: fallback is only possible before the first SSE chunk has been sent. Once streaming has started, a failure injects an error event into the stream and stops — no silent model switching mid-response.

> See full working examples in:
> - [`examples/cascade-fallback.config.json`](examples/cascade-fallback.config.json) — cascade mode
> - [`examples/model-specific-fallback.config.json`](examples/model-specific-fallback.config.json) — model-specific mode

#### Mode A: Cascade

`"fallBackModality": "cascade"`

Models are assigned a global numeric order via the `fallbackOrder` field. When the requested model fails, the gateway tries the model with the next order number (`n+1`), then `n+2`, and so on — across all providers — until one succeeds or `fallbackLimit` is reached.

```json
{
  "cascadeEnabled": true,
  "fallBackModality": "cascade",
  "fallbackLimit": 3,
  "providers": [
    {
      "openrouter": {
        "models": [
          { "modelId": "openai/gpt-4",         "fallbackOrder": 1, "enabled": true, ... },
          { "modelId": "anthropic/claude-3",   "fallbackOrder": 2, "enabled": true, ... }
        ]
      }
    },
    {
      "nvidia": {
        "models": [
          { "modelId": "meta/llama-3.1-405b",  "fallbackOrder": 3, "enabled": true, ... }
        ]
      }
    }
  ]
}
```

Call with `openrouter/openai/gpt-4` (order 1) → it fails → gateway tries order 2 (`openrouter/anthropic/claude-3`) → fails → tries order 3 (`nvidia/meta/llama-3.1-405b`).

**Rules:**
- `fallbackOrder` must be a positive integer, globally unique across all models.
- Gaps are allowed (orders 1, 3, 5 are valid — 2 and 4 will simply be skipped).
- If the requested model has no `fallbackOrder`, cascade is treated as unconfigured for that call — retries still happen, but no model rotation.
- The UI shows a red ⚠ warning on any model without `fallbackOrder` when cascade mode is active.

#### Mode B: Model-Specific

`"fallBackModality": "model_specific"`

Each model declares its own ordered list of fallback candidates in a `fallbackModels` array. Each entry is a `"providerName/modelId"` key that must match a model in your config.

```json
{
  "cascadeEnabled": true,
  "fallBackModality": "model_specific",
  "fallbackLimit": 2,
  "providers": [
    {
      "openrouter": {
        "models": [
          {
            "modelId": "openai/gpt-4",
            "enabled": true,
            "fallbackModels": [
              "nvidia/meta/llama-3.1-405b-instruct",
              "openrouter/anthropic/claude-3-haiku"
            ],
            ...
          }
        ]
      }
    }
  ]
}
```

Call with `openrouter/openai/gpt-4` → fails → tries `nvidia/meta/llama-3.1-405b-instruct` → fails → tries `openrouter/anthropic/claude-3-haiku`.

**Rules:**
- Each entry must be a `"providerName/modelId"` key configured in your gateway.
- Self-references and duplicate entries in the list are rejected at startup.
- Invalid/disabled/unavailable targets are skipped at runtime with a warning logged. If valid targets remain, the chain continues. If all are invalid, the request fails normally.
- A config error on a `fallbackModels` reference is shown in the UI and logged, but the primary model still serves requests.

#### Validation

Fallback config is validated when the config file is loaded:

- **On startup** — any validation error (bad modality value, negative `fallbackLimit`, duplicate `fallbackOrder`, unknown model reference, self-reference) is **fatal**. The process exits with a clear error message.
- **On hot-reload** — fallback-field validation errors are **warnings only**. The previous valid config is kept in memory and the gateway continues serving. The error is logged to console and visible in the dashboard.

### Retry Logic

Retry parameters cascade: **model-level wins over provider-level**.

```json
{
  "openrouter": {
    "retries": 3,              // ← provider default
    "retriesDelayMs": 5000,
    "models": [
      {
        "modelId": "openai/gpt-4",
        "retries": 5,            // ← this model gets 5 retries, not 3
        "retriesDelayMs": 8000   // ← and 8s delay, not 5s
      },
      {
        "modelId": "anthropic/claude-opus-4"
        // ← this model inherits provider's 3 retries / 5s delay
      }
    ]
  }
}
```

Backoff is exponential: `delay × attempt` capped at 30 seconds. If the upstream returns a `Retry-After` header (common on 429s), that value is respected.

For **streaming requests**: retries can only happen before the first SSE chunk is sent to the client. Once streaming starts, a mid-stream failure injects an error event into the SSE stream and closes.

### Capability Gating

Each model declares what it supports:

```json
"capabilities": {
  "tools": true,       // function/tool calling
  "images": true,      // image_url content in messages
  "streaming": true,   // stream: true
  "thinking": false,   // thinking/reasoning tokens
  "files": false       // file attachments
}
```

If you send a request with `tools` to a model that has `"tools": false`, the gateway returns `400 capability_not_supported` immediately — no upstream call wasted.

### What Happens on Errors

| Situation | HTTP | Error Type | What You Get |
|---|---|---|---|
| Model not in config | 404 | `model_not_found` | Lists all available models |
| Model disabled | 403 | `model_disabled` | Clear message |
| Provider disabled | 403 | `provider_disabled` | Clear message |
| Model gone from upstream | 410 | `model_gone` | Scanner detected removal |
| Unsupported capability | 400 | `capability_error` | Which capability is missing |
| Upstream returned error | 502 | `upstream_error` | Upstream status + body excerpt |
| Upstream timed out | 504 | `timeout_error` | Timeout details |
| Rate limited (after retries) | 429 | `rate_limit_error` | Rate limit info |

All errors follow OpenAI's format:

```json
{
  "error": {
    "message": "Model \"foo/bar\" not found. Available models: openrouter/openai/gpt-4, nvidia/meta/llama-3.1-405b-instruct",
    "type": "model_not_found",
    "code": "model_not_found"
  }
}
```

---

## How to Run

### Prerequisites

- Node.js 20+ (uses native `fetch`, ESM)

### Install

```bash
cd gateway
npm install
```

### Configure

Edit `no-bs-ai-gateway.config.json` with your actual API keys and models:

```json
{
  "port": 4000,
  "host": "127.0.0.1",
  "providers": [
    {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "sk-or-YOUR_KEY_HERE",
        "retries": 3,
        "retriesDelayMs": 5000,
        "timeout": 60000,
        "enabled": true,
        "models": [
          {
            "modelId": "openai/gpt-4",
            "enabled": true,
            "contextWindow": 128000,
            "maxTokens": 16384,
            "retries": 5,
            "capabilities": {
              "tools": true,
              "images": true,
              "streaming": true,
              "thinking": false,
              "files": false
            }
          }
        ]
      }
    },
    {
      "nvidia": {
        "baseUrl": "https://integrate.api.nvidia.com/v1",
        "apiKey": "nvapi-YOUR_KEY_HERE",
        "retries": 3,
        "retriesDelayMs": 5000,
        "timeout": 60000,
        "enabled": true,
        "models": [
          {
            "modelId": "meta/llama-3.1-405b-instruct",
            "enabled": true,
            "contextWindow": 128000,
            "maxTokens": 4096,
            "capabilities": {
              "tools": true,
              "images": false,
              "streaming": true,
              "thinking": false,
              "files": false
            }
          }
        ]
      }
    },
    {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com/v1",
        "apiKey": "sk-ant-YOUR_KEY_HERE",
        "authHeader": "x-api-key",
        "anthropicVersion": "2023-06-01",
        "retries": 2,
        "retriesDelayMs": 2000,
        "timeout": 60000,
        "enabled": true,
        "models": [
          {
            "modelId": "claude-opus-4-6",
            "enabled": true,
            "contextWindow": 200000,
            "maxTokens": 4096,
            "capabilities": {
              "tools": true,
              "images": true,
              "streaming": true,
              "thinking": true,
              "files": false
            }
          }
        ]
      }
    }
  ]
}
```

### Start

```bash
# Production
npm start

# Development (auto-restarts on code changes)
npm run dev

# With a custom config path
npm start -- --config /path/to/my-config.json
```

You'll see:

```
╔══════════════════════════════════════════╗
║        No-BS AI Gateway v0.1.0          ║
╚══════════════════════════════════════════╝

[2026-04-20T10:00:00.000Z] [INFO] [startup] Config loaded successfully
[2026-04-20T10:00:00.001Z] [INFO] [startup] Database initialized at D:\gateway\no-bs-ai-gateway.db
[2026-04-20T10:00:00.002Z] [INFO] [startup] Registry built: 3 enabled models, 0 disabled
[2026-04-20T10:00:00.003Z] [INFO] [startup] Server listening on http://127.0.0.1:4000
[2026-04-20T10:00:00.004Z] [INFO] [startup] Web UI:              http://127.0.0.1:4000/
[2026-04-20T10:00:00.004Z] [INFO] [startup] Chat UI:             http://127.0.0.1:4000/chat
[2026-04-20T10:00:00.005Z] [INFO] [startup] Models endpoint:     http://127.0.0.1:4000/v1/models
[2026-04-20T10:00:00.006Z] [INFO] [startup] Chat completions:    http://127.0.0.1:4000/v1/chat/completions
```

Then open in your browser:

| URL | Description |
|---|---|
| `http://127.0.0.1:4000/` | Dashboard — models, request log, stats |
| `http://127.0.0.1:4000/chat` | Chat UI — full chat interface with model selector |

### Test It

```bash
# List models
curl http://127.0.0.1:4000/v1/models

# Health check
curl http://127.0.0.1:4000/health
```

**OpenRouter — free model router (text + images, tools, thinking)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter/openrouter/free",
    "messages": [{"role": "user", "content": "Who is Macron in France?"}],
    "max_tokens": 200
  }'
```

**OpenRouter — Elephant Alpha (text-only, tools)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter/openrouter/elephant-alpha",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**OpenRouter — Gemma 4 31B free (text + images, tools, thinking)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter/google/gemma-4-31b-it:free",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**OpenRouter — NVIDIA Nemotron 3 Super free (text, tools, thinking)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**OpenRouter — LFM2.5 Thinking free (text, thinking)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openrouter/liquid/lfm-2.5-1.2b-thinking:free",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**NVIDIA — GLM-5.1 (text, tools, thinking)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/z-ai/glm-5.1",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**NVIDIA — MiniMax M2.7 (text, tools)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/minimaxai/minimax-m2.7",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**NVIDIA — Mistral Small 4 (text + images, tools, thinking)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/mistralai/mistral-small-4-119b-2603",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**NVIDIA — Qwen3.5-122B (text + images + video, tools)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/qwen/qwen3.5-122b-a10b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**Anthropic — Claude Opus (text + images, tools, thinking)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-opus-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

**Anthropic — Claude Sonnet (text + images, tools, thinking)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 200
  }'
```

> Anthropic requests are transparently translated: the gateway converts your OpenAI-format body to Anthropic's `/v1/messages` format, calls the API with `x-api-key` auth and the `anthropic-version` header, then translates the response back to OpenAI format before returning it to your client.

**Streaming example (any model)**
```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/z-ai/glm-5.1",
    "messages": [{"role": "user", "content": "Count from 1 to 10"}],
    "stream": true
  }'
```

> The `Authorization` header is accepted but ignored — API keys come from the config file.

### Web Dashboard

Open `http://127.0.0.1:4000/` in your browser:

- **Stats bar** — total requests, errors, error rate, avg latency
- **Models table** — all configured models with status dots (available / disabled / gone), capabilities badges, fallback order column (red ⚠ on unconfigured models when cascade is active)
- **Fallback header** — shows active mode badge, Cascade ON/OFF state, and an ⓘ tooltip explaining the current mode
- **Request log** — every call with timestamp, model, status, latency, tokens, retries. Click a row to expand error details
- **Error log** — filtered view of errors with type, HTTP status, attempt number

Auto-refreshes every 5 seconds. No configuration needed.

### Chat Portal

Open `http://127.0.0.1:4000/chat` in your browser for a full chat interface:

- **Model selector** — dropdown grouped by provider. Lists all enabled models from the gateway config. Picks up changes after a page refresh.
- **System prompt** — collapsible text area for a persistent system message prepended to every request.
- **Parameter sliders** — temperature, max tokens, top-p, frequency penalty, presence penalty. All sliders are live and applied to the next request.
- **Stop sequences** — comma-separated list of stop tokens injected into the request.
- **Streaming toggle** — switch between SSE streaming (live token-by-token output with a blinking cursor) and standard non-streaming (waits for the full response).
- **Markdown rendering** — toggle between rendered markdown and plain text. Rendering is applied on message finalisation, not during streaming.
- **Multiple conversations** — sidebar lists all saved conversations. Each one is stored independently in `localStorage`. Rename or delete from the sidebar.
- **Token stats** — input/output token counts shown per message and as a running session total in the header.
- **Stop button** — abort an in-flight request mid-stream without reloading the page.
- **Context hygiene** — empty assistant messages (from interrupted or failed requests) are automatically stripped from the conversation history before each API call so they don't pollute the model's context window.

No login, no server state — all conversation history lives in your browser's `localStorage`.

---

## Config Reference

### Root

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | number | `4000` | Server port |
| `host` | string | `"127.0.0.1"` | Bind address. Use `127.0.0.1` to keep it local |
| `maxBodySize` | number | `52428800` | Max request body in bytes (50MB) |
| `dbRetentionDays` | number | `7` | Auto-prune DB records older than this |
| `scanIntervalMs` | number | `1800000` | Model availability scan interval (30 min) |
| `cascadeEnabled` | boolean | `false` | Enable fallback model rotation |
| `fallBackModality` | string | `"cascade"` | Fallback strategy: `"cascade"` or `"model_specific"` |
| `fallbackLimit` | number | `0` | Max fallback hops (0 = disabled) |
| `logLevel` | string | `"INFO"` | Logging verbosity: `"SILENT"`, `"ERROR"`, `"WARN"`, `"INFO"`, `"VERBOSE"`, `"DEBUG"` |
| `streamStallTimeoutMs` | number | `60000` | SSE no-data stall timeout — abort the stream if upstream goes silent for this long |
| `scanTimeoutMs` | number | `15000` | Per-provider timeout for the upstream `/models` availability scan |
| `providers` | array | required | List of provider entries |

### Provider

| Field | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | string | required | Provider's OpenAI-compatible base URL |
| `apiKey` | string | required | API key for the provider |
| `retries` | number | `0` | Default retry count for all models in this provider |
| `retriesDelayMs` | number | `1000` | Default retry delay in ms |
| `timeout` | number | `60000` | Upstream request timeout in ms |
| `enabled` | boolean | required | Whether this provider is active |
| `authHeader` | string | `"Authorization"` | Auth header name. Use `"x-api-key"` for Anthropic-style auth |
| `anthropicVersion` | string | — | Anthropic API version header value (e.g. `"2023-06-01"`). Only needed for the Anthropic provider |
| `models` | array | required | List of model configs |

### Model

| Field | Type | Default | Description |
|---|---|---|---|
| `modelId` | string | required | Upstream model identifier (sent to the provider) |
| `enabled` | boolean | required | Whether this model is active |
| `contextWindow` | number | `128000` | Context window size in tokens |
| `maxTokens` | number | `4096` | Max output tokens |
| `retries` | number | provider's value | Overrides provider retry count for this model |
| `retriesDelayMs` | number | provider's value | Overrides provider retry delay for this model |
| `fallbackOrder` | number | — | *(cascade mode)* Global position in the fallback chain. Positive integer, must be unique across all models |
| `fallbackModels` | string[] | — | *(model_specific mode)* Ordered list of `"providerName/modelId"` fallback targets |
| `capabilities` | object | all false except streaming | What this model supports |

### Capabilities

| Field | Type | Default | Description |
|---|---|---|---|
| `tools` | boolean | `false` | Function/tool calling |
| `images` | boolean | `false` | Image content in messages |
| `streaming` | boolean | `true` | SSE streaming responses |
| `thinking` | boolean | `false` | Thinking/reasoning tokens |
| `files` | boolean | `false` | File attachments |

---

## Logging

The gateway supports configurable log verbosity via the `logLevel` config field:

| Level | Output |
|-------|--------|
| `SILENT` | No output except startup errors |
| `ERROR` | Only errors |
| `WARN` | Errors + warnings |
| `INFO` | Errors + warnings + basic info (default) |
| `VERBOSE` | INFO + request/response summaries, timing, token counts |
| `DEBUG` | VERBOSE + full request/response bodies, headers, chunk content |

**Example config with verbose logging:**
```json
{
  "port": 4000,
  "host": "127.0.0.1",
  "logLevel": "VERBOSE",
  "providers": [...]
}
```

At `VERBOSE` level, you'll see:
- Request timing and latency
- Token input/output counts
- Error response bodies

At `DEBUG` level, you'll additionally see:
- Full request bodies (truncated at 2000 chars)
- Full response bodies (truncated at 2000 chars)
- SSE chunk content previews
- Sanitized headers (API keys masked)

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Web dashboard |
| `GET` | `/chat` | Chat portal — interactive chat UI with model selector, streaming, conversations |
| `GET` | `/health` | Health check (uptime, model count) |
| `GET` | `/v1/models` | OpenAI-compatible model list |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions proxy |
| `GET` | `/api/stats` | Dashboard stats (JSON) |
| `GET` | `/api/requests?limit=100&offset=0` | Request log (JSON) |
| `GET` | `/api/errors?limit=100&offset=0` | Error log (JSON) |
| `GET` | `/api/models` | Model status with availability info (JSON) |
| `GET` | `/api/config-summary` | Active fallback config summary (JSON) |

---

## Security Notes

- **Binds to `127.0.0.1` by default.** Your API keys are in the config file and there's no gateway-level auth. If you change `host` to `0.0.0.0`, anyone on your network can use your keys.
- **Config file contains secrets.** Keep it out of version control. The `.gitignore` already excludes `*.db` but add your config file if it has real keys.
- **No input sanitization beyond JSON parsing.** The gateway passes your request body through to the upstream provider. The upstream is responsible for content filtering.

---

## License

MIT
