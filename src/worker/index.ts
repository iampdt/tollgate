// The Worker. Static files (the dashboard) are served by the platform; /v1 is the gateway,
// /api is what the dashboard and the admin tools read.

import { z } from "zod";
import { DEMO_KEY, type Health, type Usage } from "../shared/api";
import { EMBEDDING_MODEL, cosine, semanticBackends, sweep } from "./cache";
import { configuredProviders, MODELS, providerKeys, PROVIDERS, ROUTES } from "./catalog";
import { chat } from "./chat";
import type { AppEnv } from "./env";
import { CORS, fail, json } from "./http";
import { authenticate, createKey, DEMO_TOTAL, DEMO_VISITOR, forget, gatesFor, isAdmin, listKeys, revokeKey } from "./keys";
import { one, prune, recent, stats } from "./traces";

export { Breaker } from "./breaker";
export { KeyGate } from "./gate";

const newKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  requestsPerMinute: z.number().int().min(1).max(6000).default(60),
  tokensPerDay: z.number().int().min(1).max(1_000_000_000).default(200_000),
  cacheMode: z.enum(["off", "exact", "semantic"]).default("exact"),
});

const similaritySchema = z.object({
  pairs: z.array(z.tuple([z.string().min(1).max(2000), z.string().min(1).max(2000)])).min(1).max(20),
  judge: z.boolean().default(false),
});

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  try {
    return schema.parse(await request.json());
  } catch (error) {
    return fail(400, "invalid_request", error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "The body is not valid JSON.");
  }
}

async function health(env: AppEnv): Promise<Health> {
  const providers = configuredProviders(env);
  const targets = [...new Set(Object.values(ROUTES).flatMap((route) => route.targets))];
  const states = await env.BREAKERS.get(env.BREAKERS.idFromName("global")).states(targets);
  const { embedder, index, judge } = semanticBackends(env);
  return {
    routes: Object.entries(ROUTES).map(([name, route]) => ({
      name,
      description: route.description,
      targets: route.targets.map((target) => ({
        target,
        configured: providers.has(target.slice(0, target.indexOf("/"))),
        state: states[target] ?? "closed",
      })),
    })),
    providers: PROVIDERS.map((p) => ({ id: p.id, configured: providers.has(p.id), needs: p.needs, paid: p.paid, demo: p.demo })),
    semanticCache: { embedder: embedder.id, index: index.id, judge: judge?.id ?? null },
  };
}

async function admin(request: Request, env: AppEnv, path: string): Promise<Response> {
  if (!env.ADMIN_TOKEN) return fail(404, "admin_disabled", "The admin API is switched off: no ADMIN_TOKEN is set.");
  if (!(await isAdmin(env, request))) return fail(401, "invalid_admin_token", "Missing or wrong admin token.");

  if (path === "/api/admin/keys" && request.method === "POST") {
    const input = await body(request, newKeySchema);
    if (input instanceof Response) return input;
    const created = await createKey(env, input);
    return json({ ...created, ...input, note: "Store this key now. Only its hash is kept; it cannot be shown again." }, 201);
  }
  if (path === "/api/admin/keys" && request.method === "GET") return json({ keys: await listKeys(env) });
  const revoke = /^\/api\/admin\/keys\/([\w-]+)$/.exec(path);
  if (revoke?.[1] && request.method === "DELETE") {
    return (await revokeKey(env, revoke[1])) ? json({ revoked: revoke[1] }) : fail(404, "key_not_found", "No active key has that id.");
  }
  if (path === "/api/admin/similarity" && request.method === "POST") {
    // Runs pairs of prompts through both steps of the semantic cache, for evaluating it:
    // the embedder's similarity, and (where a judge is configured) the judge's verdict.
    const input = await body(request, similaritySchema);
    if (input instanceof Response) return input;
    const { embedder, judge } = semanticBackends(env);
    const vectors = await embedder.embedAll(input.pairs.flat());
    const scores = input.pairs.map((_, i) => cosine(vectors[2 * i] ?? [], vectors[2 * i + 1] ?? []));
    const verdicts = judge && input.judge ? await Promise.all(input.pairs.map(([a, b]) => judge.same(a, b))) : null;
    return json({ embedder: embedder.id, judge: judge?.id ?? null, scores, verdicts });
  }
  const upstreamModels = /^\/api\/admin\/providers\/([\w-]+)\/models$/.exec(path);
  if (upstreamModels?.[1] && request.method === "GET") {
    // The model ids a provider's key can reach, for keeping the catalog current.
    const info = PROVIDERS.find((p) => p.id === upstreamModels[1]);
    const key = providerKeys(env)[upstreamModels[1]];
    if (!info?.baseUrl || !key) return fail(404, "provider_not_configured", "That provider has no key on this deployment.");
    const response = await fetch(`${info.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) return fail(502, "provider_error", `${info.id} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const listed = (await response.json()) as { data?: { id: string }[] };
    return json({ provider: info.id, models: (listed.data ?? []).map((m) => m.id).sort() });
  }
  if (path === "/api/admin/breakers/reset" && request.method === "POST") {
    await env.BREAKERS.get(env.BREAKERS.idFromName("global")).reset();
    forget();
    return json({ reset: true });
  }
  if (path === "/api/admin/latency" && request.method === "POST") {
    // Times each storage call the request path can make, from this location, a few times over.
    return json(await measure(env, request));
  }
  if (path === "/api/admin/index-probe" && request.method === "POST") {
    // For measuring how long the vector index takes to make a new entry searchable:
    // {"op":"insert"} files one vector under a fresh scope, {"op":"query","scope":…} looks for it.
    const input = (await request.json()) as { op: "insert" | "query"; scope?: string };
    const { embedder, index } = semanticBackends(env);
    const vector = await embedder.embed("index probe");
    if (input.op === "insert") {
      const scope = `probe-${crypto.randomUUID()}`;
      const id = crypto.randomUUID();
      await index.insert(id, vector, scope);
      // Recorded as already expired, so the next maintenance run deletes it.
      await env.DB.prepare("INSERT INTO cache_vectors (id, expires_at) VALUES (?, 0)").bind(id).run();
      return json({ scope });
    }
    return json({ found: (await index.nearest(vector, input.scope ?? "")) !== null });
  }
  if (path === "/api/admin/maintenance" && request.method === "POST") {
    const now = Date.now();
    return json({ tracesDeleted: await prune(env, now), vectorsDeleted: await sweep(env, now) });
  }
  return fail(404, "not_found", "No such admin endpoint.");
}

async function measure(env: AppEnv, request: Request): Promise<Record<string, number[]>> {
  const rounds = 5;
  const out: Record<string, number[]> = {};
  const time = async (name: string, work: () => Promise<unknown>) => {
    const started = Date.now();
    await work();
    (out[name] ??= []).push(Date.now() - started);
  };
  const { embedder, index } = semanticBackends(env);
  const vector = await embedder.embed("warm up");
  const cache = await caches.open("tollgate-bench");
  const origin = new URL(request.url).origin;
  const hot = `bench:hot:${crypto.randomUUID()}`;
  await env.CACHE.put(hot, "x", { expirationTtl: 60 });
  await cache.put(`${origin}/bench/hot`, new Response("x", { headers: { "Cache-Control": "max-age=60" } }));
  for (let i = 0; i < rounds; i++) {
    await time("kv_miss", () => env.CACHE.get(`bench:miss:${crypto.randomUUID()}`));
    await time("kv_hit", () => env.CACHE.get(hot));
    await time("d1_read", () => env.DB.prepare("SELECT id FROM api_keys WHERE key_hash = ?").bind(`bench-${i}`).first());
    await time("cache_api_miss", () => cache.match(`${origin}/bench/${crypto.randomUUID()}`));
    await time("cache_api_hit", () => cache.match(`${origin}/bench/hot`));
    await time("gate_usage", () => env.GATES.get(env.GATES.idFromName("bench")).usage());
    await time("gate_admit", () => env.GATES.get(env.GATES.idFromName("bench")).admit({ requestsPerMinute: 6000, tokensPerDay: 1e9 }));
    await time("breaker_check", () => env.BREAKERS.get(env.BREAKERS.idFromName("global")).check(["mock/echo"]));
    await time("embed", () => embedder.embed(`how long does embedding take, round ${i}`));
    await time("vector_query", () => index.nearest(vector, "bench-scope"));
  }
  return out;
}

async function dashboard(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const key = await authenticate(env, request);
  if (!key) return fail(401, "invalid_api_key", "Missing or unknown API key.");

  if (url.pathname === "/api/health") return json(await health(env));
  if (url.pathname === "/api/usage") {
    const [own] = await gatesFor(key, request);
    const used = own ? await env.GATES.get(env.GATES.idFromName(own.name)).usage() : { tokensUsedToday: 0, requestsToday: 0 };
    const usage: Usage = {
      keyName: key.name,
      requestsPerMinute: key.requestsPerMinute,
      tokensPerDay: key.tokensPerDay,
      cacheMode: key.cacheMode,
      ...used,
    };
    return json(usage);
  }
  if (url.pathname === "/api/stats") {
    const hours = Math.min(168, Math.max(1, Math.round(Number(url.searchParams.get("hours")) || 24)));
    return json(await stats(env, key.id, hours, Date.now()));
  }
  if (url.pathname === "/api/traces") {
    const limit = Math.min(200, Math.max(1, Math.round(Number(url.searchParams.get("limit")) || 50)));
    return json({ traces: await recent(env, key.id, limit) });
  }
  const trace = /^\/api\/traces\/([\w-]+)$/.exec(url.pathname);
  if (trace?.[1]) {
    const found = await one(env, key.id, trace[1]);
    return found ? json(found) : fail(404, "trace_not_found", "No trace with that id for this key.");
  }
  return fail(404, "not_found", "No such endpoint.");
}

function models(env: AppEnv): Response {
  const providers = configuredProviders(env);
  const created = 1794700800;
  const data = [
    ...Object.entries(ROUTES).map(([id, route]) => ({ id, object: "model", created, owned_by: "tollgate", kind: "route", description: route.description, targets: route.targets })),
    ...Object.keys(MODELS)
      .filter((id) => providers.has(id.slice(0, id.indexOf("/"))))
      .map((id) => ({ id, object: "model", created, owned_by: id.slice(0, id.indexOf("/")), kind: "model" })),
  ];
  return json({ object: "list", data });
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === "/v1/chat/completions") {
        return request.method === "POST" ? await chat(request, env, ctx) : fail(405, "method_not_allowed", "Use POST.");
      }
      if (url.pathname === "/v1/models" && request.method === "GET") return models(env);
      if (url.pathname === "/api/demo") {
        return json({ key: DEMO_KEY, perVisitor: DEMO_VISITOR, total: DEMO_TOTAL, embeddingModel: env.AI ? EMBEDDING_MODEL : null });
      }
      if (url.pathname.startsWith("/api/admin/")) return await admin(request, env, url.pathname);
      if (url.pathname.startsWith("/api/")) return await dashboard(request, env, url);
      return fail(404, "not_found", "No such endpoint. The gateway is at /v1/chat/completions.");
    } catch (error) {
      console.error("unhandled:", error);
      return fail(500, "internal_error", "The gateway failed while handling this request.");
    }
  },

  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    ctx.waitUntil(Promise.all([prune(env, now), sweep(env, now)]));
  },
} satisfies ExportedHandler<AppEnv>;
