# AGENTS.md

Working notes for anyone (or any coding agent) changing Tollgate. `docs/architecture.md`
explains the request path; `docs/decisions.md` (D1–D13) explains why it is that way.

## What it is

An OpenAI-compatible LLM gateway on Cloudflare's free tier: fallback across providers, circuit
breakers, per-key rate limits and budgets, exact and semantic caching, tracing.

## Layout

| Path | Holds |
| --- | --- |
| `src/worker/chat.ts` | The request path |
| `src/worker/router.ts`, `breaker.ts`, `gate.ts`, `cache.ts` | Fallback, circuit breaker, per-key gate (Durable Object), caches |
| `src/worker/catalog.ts` | Providers, models, prices, routes |
| `src/worker/providers/` | Upstream adapters, including a mock that fails on request |
| `src/app/` | The dashboard and playground |
| `migrations/` | D1 schema (`api_keys`, `traces`, `cache_vectors`) |
| `scripts/` | Load test, cache evaluation, provider runs, index-delay probe |
| `docs/results.md` | Every published number and how it was measured |

## Commands

```sh
npm run check        # types, tests (Workers runtime, real Durable Objects, D1, KV), build
npm run dev          # local app and Worker
npm run deploy       # check, then deploy
npm run loadtest     # needs TOLLGATE_URL and ADMIN_TOKEN; creates and revokes its own keys
npm run eval:cache
```

Local secrets live in the git-ignored `.dev.vars`; Worker secrets are set with
`npx wrangler secret put`.

## Rules

- Fallback ends at the first streamed token; a 400 from an upstream is returned, not retried.
- Traces never store prompt or answer text.
- Policy stays in pure functions (`admit`, `check`, `report`) so it's testable without a clock.
- Keep CPU per request small: the free plan allows 10 ms. Heavy statistics run in SQL.
- The public demo key must never reach a paid provider.
- Every number in the README and docs comes from `docs/results.md`; re-measure before changing one.
