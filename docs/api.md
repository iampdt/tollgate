# API

Base URL of the public deployment: `https://tollgate.iampdt.workers.dev`

Every request needs `Authorization: Bearer <key>`. `tg_demo_public` is a public key with
small limits.

## POST /v1/chat/completions

The OpenAI chat completions request. Fields used:

| Field | Notes |
| --- | --- |
| `model` | A route name (`fast`, `smart`, …) or one model as `provider/model`. `GET /v1/models` lists both. |
| `messages` | Roles `system`, `developer` (treated as system), `user`, `assistant`. Content is a string or an array of text parts. |
| `temperature`, `top_p`, `stop` | Passed to the upstream. |
| `max_tokens` or `max_completion_tokens` | 1 to 8192. |
| `stream` | `true` for server-sent events. |
| `stream_options.include_usage` | Adds a last chunk with token usage and the gateway's summary. |

Other fields are ignored. Tool calling and non-text content are not supported.

Request headers:

| Header | Values | Default |
| --- | --- | --- |
| `X-Tollgate-Cache` | `off`, `exact`, `semantic` | the key's setting |
| `X-Tollgate-Cache-Ttl` | 60 – 86400 seconds | 3600 |
| `X-Tollgate-Similarity-Threshold` | 0.5 – 1 | 0.85 |

The response is the OpenAI shape plus a `tollgate` object:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "fast",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 44, "completion_tokens": 200, "total_tokens": 244 },
  "tollgate": {
    "request_id": "chatcmpl-…",
    "cache": "miss",
    "similarity": null,
    "judged": null,
    "provider": "workers-ai",
    "model": "@cf/meta/llama-3.2-3b-instruct",
    "attempts": [{ "target": "workers-ai/@cf/meta/llama-3.2-3b-instruct", "outcome": "ok", "ms": 311 }],
    "cost_micros": 69,
    "saved_micros": 0,
    "latency_ms": 1380,
    "first_token_ms": 354,
    "overhead_ms": 43,
    "admit_ms": 43,
    "cache_ms": 5
  }
}
```

`cost_micros` is the provider's list price in millionths of a US dollar. `cache` is `off`,
`miss`, `exact` or `semantic`.

Response headers: `X-Tollgate-Request-Id`, `X-Tollgate-Cache`, `X-Tollgate-Similarity`,
`X-Tollgate-Provider`, `X-Tollgate-Model`, `X-Tollgate-Fallbacks`,
`X-RateLimit-Remaining-Requests`.

### Streaming

Standard `chat.completion.chunk` events ending with `data: [DONE]`. If the upstream breaks
after the first token, the stream ends with

```
data: {"error":{"message":"The upstream stopped before finishing its answer.","type":"upstream_error","code":"stream_broken"}}
```

and **no** `[DONE]`.

### Errors

OpenAI's error shape: `{"error": {"message", "type", "code"}}`.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | The body failed validation; the message names the field |
| 400 | `upstream_rejected_request` | An upstream called the request invalid; not retried elsewhere |
| 401 | `invalid_api_key` | Missing or unknown key |
| 404 | `model_not_found` | Not a route and not in the catalog |
| 413 | `request_too_large` | Body over 256 KB |
| 429 | `rate_limited` | Over requests per minute; see `Retry-After` |
| 429 | `budget_exhausted` | Day's tokens used; resets 00:00 UTC |
| 502 | `all_upstreams_failed` | `error.attempts` lists each try |
| 503 | `circuit_open` | Every upstream is being skipped; `Retry-After: 30` |
| 503 | `no_upstream_configured` | No provider behind the route has credentials |
| 504 | `upstream_timeout` | No upstream sent a first token in time |

## GET /v1/models

Routes (`"kind": "route"`, with their targets) and the catalogued models of configured
providers.

## Dashboard API

Authenticated with the same API key; each key sees only its own data.

| Endpoint | Returns |
| --- | --- |
| `GET /api/usage` | The key's limits and today's use |
| `GET /api/traces?limit=50` | Recent traces, newest first (up to 200) |
| `GET /api/traces/:id` | One trace |
| `GET /api/stats?hours=24` | Totals, cache and fallback counts, latency percentiles, per-hour and per-upstream breakdown (1 to 168 hours) |
| `GET /api/health` | Routes, their upstreams and circuit states; configured providers |

## Admin API

`Authorization: Bearer <ADMIN_TOKEN>`. Switched off entirely when no `ADMIN_TOKEN` is set.

| Endpoint | Does |
| --- | --- |
| `POST /api/admin/keys` | Create a key: `{name, requestsPerMinute, tokensPerDay, cacheMode}`. The key is returned once. |
| `GET /api/admin/keys` | List keys (prefix only) |
| `DELETE /api/admin/keys/:id` | Revoke. A revoked key can keep working for up to 30 s in isolates that remember it. |
| `POST /api/admin/similarity` | `{pairs: [[a, b], …], judge: true}` → similarity and judge verdict per pair (up to 20) |
| `POST /api/admin/latency` | Time each storage call from inside the Worker |
| `POST /api/admin/index-probe` | Insert or query a probe vector, for measuring index delay |
| `POST /api/admin/breakers/reset` | Close every circuit |
| `POST /api/admin/maintenance` | Delete old traces and expired vectors now (also runs daily) |
