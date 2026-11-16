# Development

## Requirements

Node 22 or newer. For anything beyond the mock upstream, a free Cloudflare account
(`npx wrangler login`).

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars               # set ADMIN_TOKEN
npx wrangler d1 migrations apply tollgate --local
npm run dev                                  # http://localhost:5173
```

The Worker, its Durable Objects, D1, KV and the Cache API all run locally. Workers AI and
Vectorize have no local version: when you are logged in to Cloudflare, the dev server uses
your account's (and your free allocation). The `mock/…` models work either way.

## Checks

```bash
npm run check        # typecheck, tests, build
npm test             # tests only
```

The tests run inside the Workers runtime against `wrangler.test.jsonc`, which has no
Workers AI or Vectorize binding. Without them the semantic cache uses a word-hashing
embedder and an in-memory index (`cache.ts`), and has no judge; the judge's behaviour is
tested by passing fakes to `lookupSemantic`. Timeouts in that config are short so the
timeout paths run in milliseconds.

| File | Covers |
| --- | --- |
| `test/units.test.ts` | Limit policy, circuit breaker, catalog, embedder, server-sent event parsing, both provider adapters |
| `test/cache.test.ts` | The judge's four outcomes, what gets stored, promotion of a semantic hit |
| `test/api.test.ts` | Whole requests through the Worker: validation, fallback, breaker, streaming, both caches, limits, demo key, dashboard and admin APIs |

## Deploy your own

```bash
npx wrangler d1 create tollgate                       # put the id in wrangler.jsonc
npx wrangler kv namespace create CACHE                # and this id
npx wrangler vectorize create tollgate-cache --dimensions=768 --metric=cosine
npx wrangler d1 migrations apply tollgate --remote
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Optional providers, each a secret:

```bash
npx wrangler secret put GROQ_API_KEY         # free tier
npx wrangler secret put GEMINI_API_KEY       # free tier
npx wrangler secret put OPENAI_API_KEY       # paid
npx wrangler secret put XAI_API_KEY          # paid
npx wrangler secret put OPENROUTER_API_KEY
```

A provider with no key is left out of every route; `GET /api/health` shows which are
configured. A Groq or xAI key stored as `GROK_API_KEY` is also accepted: the two names are
one letter apart, and the key's prefix (`gsk_` or `xai-`) says which it is.

Model line-ups change. `GET /api/admin/providers/<id>/models` lists what a key can reach
today; update `MODELS` and `ROUTES` in `catalog.ts` to match.

## Measurements

All four need `TOLLGATE_URL` and `ADMIN_TOKEN` in the environment.

```bash
npm run loadtest                      # latency and rate-limit exactness, mock upstream
npm run eval:cache                    # the labelled pairs through embedder and judge
npx tsx scripts/index-delay.ts 6      # seconds until a new vector is searchable
npx tsx scripts/providers.ts          # real requests through every configured model and route
```

## Adding a provider

1. If it speaks the OpenAI protocol, add a line to `configuredProviders` in `catalog.ts`
   using `openAiCompatible(id, baseUrl, key)`. Otherwise implement `Provider` (one
   `stream` method) in `src/worker/providers`.
2. Add its models to `MODELS`, with list prices if you want cost figures.
3. Put them in a route in `ROUTES`.

## Layout

```
src/worker/     the gateway
  chat.ts         one request, start to finish
  router.ts       fallback
  cache.ts        exact and semantic caches, the judge
  gate.ts         rate limit and budget (Durable Object)
  breaker.ts      circuit breaker (Durable Object)
  catalog.ts      providers, models, prices, routes
  providers/      workers-ai, openai-compat, mock
  traces.ts       trace storage and statistics
  keys.ts         API keys
  index.ts        HTTP routing, dashboard and admin APIs, cron
src/app/        the dashboard (React)
src/shared/     types shared by both
migrations/     D1 schema
scripts/        load test, cache evaluation, index delay, provider run
test/
```
