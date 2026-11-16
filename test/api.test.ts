import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_KEY, type Health, type Stats, type Trace, type Usage } from "../src/shared/api";
import { FAILURES_TO_OPEN } from "../src/worker/breaker";
import { DEMO_MAX_PROMPT_CHARS, DEMO_VISITOR } from "../src/worker/keys";
import { CANNED } from "../src/worker/providers/mock";
import { adminCall, call, chat, completion, env, events, newAddress, newKey, resetBreakers, traceOf } from "./helpers";

beforeEach(resetBreakers);

describe("authentication and validation", () => {
  it("refuses a missing or unknown key", async () => {
    expect((await chat("mock/echo", "hi", { key: null })).status).toBe(401);
    const unknown = await chat("mock/echo", "hi", { key: "tg_live_nope" });
    expect(unknown.status).toBe(401);
    expect((await completion(unknown)).error?.code).toBe("invalid_api_key");
  });

  it("refuses a malformed body, naming the field", async () => {
    const notJson = await call("/v1/chat/completions", { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
    const noMessages = await call("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "mock/echo", messages: [] }) });
    expect(noMessages.status).toBe(400);
    expect((await completion(noMessages)).error?.message).toContain("messages");
  });

  it("refuses an unknown model, and a model outside the catalog", async () => {
    expect((await chat("gpt-99", "hi")).status).toBe(404);
    expect((await chat("workers-ai/@cf/openai/gpt-oss-120b", "hi")).status).toBe(404);
  });

  it("says so when nothing behind a route is configured", async () => {
    const response = await chat("fast", "hi");
    expect(response.status).toBe(503);
    expect((await completion(response)).error?.code).toBe("no_upstream_configured");
  });

  it("accepts the multi-part message form and the developer role", async () => {
    const response = await chat("mock/echo", [
      { role: "developer", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "part one, " }, { type: "text", text: "part two" }] as unknown as string },
    ]);
    expect((await completion(response)).choices[0]?.message.content).toBe("part one, part two");
  });

  it("answers preflight requests so a browser can call it", async () => {
    const response = await call("/v1/chat/completions", { method: "OPTIONS", key: null });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("a plain completion", () => {
  it("has the OpenAI shape, plus what the gateway did", async () => {
    const response = await chat("mock/echo", "hello there");
    expect(response.status).toBe(200);
    const body = await completion(response);
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices).toEqual([{ index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }]);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    expect(body.tollgate).toMatchObject({ provider: "mock", model: "echo", cache: "miss" });
    expect(response.headers.get("X-Tollgate-Provider")).toBe("mock");
    expect(response.headers.get("X-Tollgate-Request-Id")).toBe(body.id);
  });

  it("is traced without storing any text", async () => {
    const { key } = await newKey();
    const secret = "the launch codes are 0000";
    const body = await completion(await chat("mock/echo", secret, { key }));
    const trace = await traceOf(body.id, key);
    expect(trace).toMatchObject({ outcome: "ok", status: 200, provider: "mock", modelUsed: "echo", cache: "off", stream: false });
    expect(trace.attempts).toEqual([{ target: "mock/echo", outcome: "ok", ms: expect.any(Number) }]);
    const stored = await env.DB.prepare("SELECT * FROM traces WHERE id = ?").bind(body.id).first();
    expect(JSON.stringify(stored)).not.toContain("launch codes");
  });
});

describe("fallback", () => {
  it("moves to the next upstream when one fails, and says which", async () => {
    const response = await chat("mock-fallback", "still here");
    const body = await completion(response);
    expect(response.status).toBe(200);
    expect(body.choices[0]?.message.content).toBe("still here");
    expect(body.tollgate.attempts.map((a) => [a.target, a.outcome])).toEqual([
      ["mock/fail-503", "server"],
      ["mock/echo", "ok"],
    ]);
    expect(response.headers.get("X-Tollgate-Fallbacks")).toBe("1");
  });

  it("moves on from an upstream that is rate limiting", async () => {
    const body = await completion(await chat("mock-busy", "hi"));
    expect(body.tollgate.attempts.map((a) => a.outcome)).toEqual(["rate_limited", "ok"]);
  });

  it("gives up on an upstream that sends no first token in time", async () => {
    const started = Date.now();
    const body = await completion(await chat("mock-timeout", "hi"));
    expect(body.tollgate.attempts.map((a) => a.outcome)).toEqual(["timeout", "ok"]);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("replaces an upstream that breaks half-way, when nothing has been sent yet", async () => {
    const response = await chat("mock-broken", "whole answer");
    const body = await completion(response);
    expect(body.choices[0]?.message.content).toBe("whole answer");
    expect(body.tollgate.attempts.map((a) => a.outcome)).toEqual(["server", "ok"]);
  });

  it("treats an empty answer as a failure and asks the next upstream", async () => {
    const body = await completion(await chat("mock-empty", "say something"));
    expect(body.choices[0]?.message.content).toBe("say something");
    expect(body.tollgate.attempts.map((a) => [a.target, a.outcome])).toEqual([
      ["mock/empty", "server"],
      ["mock/echo", "ok"],
    ]);
    const alone = await chat("mock/empty", "say something", { stream: true });
    expect(alone.status).toBe(502);
  });

  it("returns 502 with every attempt when all upstreams fail", async () => {
    const response = await chat("mock-down", "hi");
    expect(response.status).toBe(502);
    const body = await completion(response);
    expect(body.error?.code).toBe("all_upstreams_failed");
    expect(body.error?.attempts?.map((a) => a.outcome)).toEqual(["server", "auth"]);
  });

  it("returns 504 when the only upstream times out", async () => {
    const response = await chat("mock/timeout", "hi");
    expect(response.status).toBe(504);
    expect((await completion(response)).error?.code).toBe("upstream_timeout");
  });

  it("does not try elsewhere when an upstream says the request itself is invalid", async () => {
    const response = await chat("mock/fail-400", "hi");
    expect(response.status).toBe(400);
    expect((await completion(response)).error?.code).toBe("upstream_rejected_request");
  });
});

describe("the circuit breaker, end to end", () => {
  it("stops calling an upstream that keeps failing, and shows it as open", async () => {
    const { key } = await newKey();
    for (let i = 0; i < FAILURES_TO_OPEN; i++) {
      const body = await completion(await chat("mock-fallback", `try ${i}`, { key }));
      expect(body.tollgate.attempts[0]?.outcome).toBe("server");
      await traceOf(body.id, key); // the failure is reported after the response
    }
    const body = await completion(await chat("mock-fallback", "after", { key }));
    expect(body.tollgate.attempts.map((a) => [a.target, a.outcome])).toEqual([
      ["mock/fail-503", "skipped_open"],
      ["mock/echo", "ok"],
    ]);
    const health = (await (await call("/api/health", { key })).json()) as Health;
    const route = health.routes.find((r) => r.name === "mock-fallback");
    expect(route?.targets.map((t) => t.state)).toEqual(["open", "closed"]);
  });

  it("returns 503 without calling anything when every upstream is open", async () => {
    const { key } = await newKey();
    for (let i = 0; i < FAILURES_TO_OPEN; i++) {
      const response = await chat("mock/fail-503", "x", { key });
      await traceOf(response.headers.get("X-Tollgate-Request-Id") ?? "", key);
      await response.text();
    }
    const response = await chat("mock/fail-503", "x", { key });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect((await completion(response)).error?.code).toBe("circuit_open");
  });

  it("does not count rejected requests against an upstream", async () => {
    const { key } = await newKey();
    for (let i = 0; i < FAILURES_TO_OPEN + 2; i++) {
      const response = await chat("mock/fail-400", "x", { key });
      await traceOf(response.headers.get("X-Tollgate-Request-Id") ?? "", key);
      expect(response.status).toBe(400);
      await response.text();
    }
  });
});

describe("streaming", () => {
  it("sends OpenAI chunks and ends with [DONE]", async () => {
    const response = await chat("mock/echo", "one two three four five six seven eight nine", { stream: true });
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const stream = await events(response);
    expect(stream.text).toBe("one two three four five six seven eight nine");
    expect(stream.done).toBe(true);
    expect(stream.events[0]).toMatchObject({ object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] });
    expect(stream.events.at(-1)).toMatchObject({ choices: [{ delta: {}, finish_reason: "stop" }] });
  });

  it("adds usage and the gateway's summary as a last chunk when asked", async () => {
    const response = await chat("mock/echo", "hi", { stream: true, extra: { stream_options: { include_usage: true } } });
    const last = (await events(response)).events.at(-1);
    expect(last).toMatchObject({ choices: [], usage: { completion_tokens: 1 }, tollgate: { provider: "mock", cache: "miss" } });
  });

  it("falls back before the first token", async () => {
    const response = await chat("mock-fallback", "streamed anyway", { stream: true });
    expect(response.headers.get("X-Tollgate-Model")).toBe("echo");
    expect(response.headers.get("X-Tollgate-Fallbacks")).toBe("1");
    expect((await events(response)).text).toBe("streamed anyway");
  });

  it("ends without [DONE], and with an error event, when the upstream breaks mid-answer", async () => {
    const { key } = await newKey();
    const response = await chat("mock/midstream", "x", { stream: true, key });
    const stream = await events(response);
    expect(stream.text).toBe("one two three ");
    expect(stream.done).toBe(false);
    expect(stream.events.at(-1)).toMatchObject({ error: { code: "stream_broken" } });
    const trace = await traceOf(response.headers.get("X-Tollgate-Request-Id") ?? "", key);
    expect(trace.outcome).toBe("stream_broken");
    expect(trace.completionTokens).toBeGreaterThan(0);
  });

  it("returns a normal error response when no upstream starts", async () => {
    const response = await chat("mock-down", "x", { stream: true });
    expect(response.status).toBe(502);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("the exact cache", () => {
  it("answers a repeated request from the cache, per key", async () => {
    const { key } = await newKey({ cacheMode: "exact" });
    const other = (await newKey({ cacheMode: "exact" })).key;
    const first = await completion(await chat("mock/echo", "cache me", { key }));
    expect(first.tollgate.cache).toBe("miss");
    await traceOf(first.id, key);

    const again = await chat("mock/echo", "cache me", { key });
    const second = await completion(again);
    expect(second.tollgate.cache).toBe("exact");
    expect(second.choices[0]?.message.content).toBe("cache me");
    expect(second.usage).toEqual(first.usage);
    expect(again.headers.get("X-Tollgate-Cache")).toBe("exact");

    expect((await completion(await chat("mock/echo", "cache me", { key: other }))).tollgate.cache).toBe("miss");
  });

  it("treats different settings, history or wording as different requests", async () => {
    const { key } = await newKey({ cacheMode: "exact" });
    const first = await completion(await chat("mock/echo", "same words", { key }));
    await traceOf(first.id, key);
    const variants = [
      chat("mock/echo", "same words", { key, extra: { temperature: 0.7 } }),
      chat("mock/echo", "same words", { key, extra: { max_tokens: 50 } }),
      chat("mock/echo", "same words.", { key }),
      chat("mock/echo", [{ role: "system", content: "be terse" }, { role: "user", content: "same words" }], { key }),
      chat("mock-fallback", "same words", { key }),
    ];
    for (const variant of variants) expect((await completion(await variant)).tollgate.cache).toBe("miss");
  });

  it("can be switched off per request, and serves hits as a stream too", async () => {
    const { key } = await newKey({ cacheMode: "exact" });
    const first = await completion(await chat("mock/echo", "stream the hit", { key }));
    await traceOf(first.id, key);
    const bypass = await completion(await chat("mock/echo", "stream the hit", { key, headers: { "X-Tollgate-Cache": "off" } }));
    expect(bypass.tollgate.cache).toBe("off");

    const streamed = await chat("mock/echo", "stream the hit", { key, stream: true, extra: { stream_options: { include_usage: true } } });
    expect(streamed.headers.get("X-Tollgate-Cache")).toBe("exact");
    const stream = await events(streamed);
    expect(stream.text).toBe("stream the hit");
    expect(stream.done).toBe(true);
    expect(stream.events.at(-1)).toMatchObject({ tollgate: { cache: "exact" } });
  });

  it("does not keep a broken or failed answer", async () => {
    const { key } = await newKey({ cacheMode: "exact" });
    const broken = await chat("mock/midstream", "x", { key, stream: true });
    await events(broken);
    await traceOf(broken.headers.get("X-Tollgate-Request-Id") ?? "", key);
    const again = await chat("mock/midstream", "x", { key, stream: true });
    expect(again.headers.get("X-Tollgate-Cache")).toBe("miss");
    await events(again);
  });

  it("records what a hit saved", async () => {
    const { key } = await newKey({ cacheMode: "exact" });
    const first = await completion(await chat("mock/echo", "count me", { key }));
    await traceOf(first.id, key);
    const second = await completion(await chat("mock/echo", "count me", { key }));
    const trace = await traceOf(second.id, key);
    expect(trace).toMatchObject({ outcome: "cached", cache: "exact", costMicros: 0, provider: "mock" });
    expect(trace.promptTokens).toBe(first.usage.prompt_tokens);
  });
});

describe("the semantic cache", () => {
  const ask = "How do I reset my account password?";

  it("answers a reworded question from the cache and reports the similarity", async () => {
    const { key } = await newKey({ cacheMode: "semantic" });
    const first = await completion(await chat("mock/echo", ask, { key }));
    expect(first.tollgate.cache).toBe("miss");
    await traceOf(first.id, key);

    const response = await chat("mock/echo", "how do I reset my account password please", { key, headers: { "X-Tollgate-Similarity-Threshold": "0.8" } });
    const second = await completion(response);
    expect(second.tollgate.cache).toBe("semantic");
    expect(second.choices[0]?.message.content).toBe(ask);
    expect(second.tollgate.similarity).toBeGreaterThan(0.8);
    expect(Number(response.headers.get("X-Tollgate-Similarity"))).toBeGreaterThan(0.8);
  });

  it("misses when the question is different, or the threshold is stricter than the match", async () => {
    const { key } = await newKey({ cacheMode: "semantic" });
    const first = await completion(await chat("mock/echo", ask, { key }));
    await traceOf(first.id, key);
    expect((await completion(await chat("mock/echo", "What is the capital of Peru?", { key }))).tollgate.cache).toBe("miss");
    const strict = await chat("mock/echo", "how do I reset my account password please", { key, headers: { "X-Tollgate-Similarity-Threshold": "0.999" } });
    expect((await completion(strict)).tollgate.cache).toBe("miss");
  });

  it("only matches within the same key, route, earlier turns and settings", async () => {
    const { key } = await newKey({ cacheMode: "semantic" });
    const other = (await newKey({ cacheMode: "semantic" })).key;
    const first = await completion(await chat("mock/echo", ask, { key }));
    await traceOf(first.id, key);
    const loose = { "X-Tollgate-Similarity-Threshold": "0.8" };
    const reworded = "how do I reset my account password please";
    const variants = [
      chat("mock/echo", reworded, { key: other, headers: loose }),
      chat("mock-fallback", reworded, { key, headers: loose }),
      chat("mock/echo", reworded, { key, headers: loose, extra: { temperature: 1 } }),
      chat("mock/echo", [{ role: "system", content: "You are a pirate." }, { role: "user", content: reworded }], { key, headers: loose }),
    ];
    for (const variant of variants) expect((await completion(await variant)).tollgate.cache).toBe("miss");
  });

  it("is not used when the key or the request asks for exact matching only", async () => {
    const { key } = await newKey({ cacheMode: "semantic" });
    const first = await completion(await chat("mock/echo", ask, { key }));
    await traceOf(first.id, key);
    const exactOnly = await chat("mock/echo", "how do I reset my account password please", { key, headers: { "X-Tollgate-Cache": "exact", "X-Tollgate-Similarity-Threshold": "0.8" } });
    expect((await completion(exactOnly)).tollgate.cache).toBe("miss");
  });
});

describe("rate limits and budgets", () => {
  it("admits exactly the limit when requests arrive together", async () => {
    const { key } = await newKey({ requestsPerMinute: 10 });
    const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => chat("mock/echo", `burst ${i}`, { key })));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30);
    const refused = responses.find((r) => r.status === 429);
    expect(Number(refused?.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await completion(refused as Response)).error?.code).toBe("rate_limited");
    await Promise.all(responses.filter((r) => !r.bodyUsed).map((r) => r.body?.cancel()));
  });

  it("stops a key that has used its daily tokens", async () => {
    const { key } = await newKey({ tokensPerDay: 30 });
    const long = "word ".repeat(40);
    const first = await completion(await chat("mock/echo", long, { key }));
    expect(first.usage.total_tokens).toBeGreaterThan(30);
    await traceOf(first.id, key);
    const usage = (await (await call("/api/usage", { key })).json()) as Usage;
    expect(usage.tokensUsedToday).toBe(first.usage.total_tokens);

    const refused = await chat("mock/echo", "one more", { key });
    expect(refused.status).toBe(429);
    expect((await completion(refused)).error?.code).toBe("budget_exhausted");
  });

  it("does not charge the budget for cache hits", async () => {
    const { key } = await newKey({ cacheMode: "exact" });
    const first = await completion(await chat("mock/echo", "free the second time", { key }));
    await traceOf(first.id, key);
    const second = await completion(await chat("mock/echo", "free the second time", { key }));
    await traceOf(second.id, key);
    const usage = (await (await call("/api/usage", { key })).json()) as Usage;
    expect(usage).toMatchObject({ tokensUsedToday: first.usage.total_tokens, requestsToday: 2 });
  });

  it("stops working when a key is revoked", async () => {
    const { id, key } = await newKey();
    expect((await chat("mock/echo", "hi", { key })).status).toBe(200);
    expect((await adminCall(`/api/admin/keys/${id}`, "DELETE")).status).toBe(200);
    expect((await chat("mock/echo", "hi", { key })).status).toBe(401);
  });
});

describe("the public demo key", () => {
  it("limits each visitor separately", async () => {
    const mine = newAddress();
    const statuses: number[] = [];
    for (let i = 0; i < DEMO_VISITOR.requestsPerMinute + 1; i++) {
      const response = await chat("mock/echo", `demo ${i}`, { address: mine, headers: { "X-Tollgate-Cache": "off" } });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(DEMO_VISITOR.requestsPerMinute);
    expect(statuses.at(-1)).toBe(429);
    expect((await chat("mock/echo", "someone else", { address: newAddress() })).status).toBe(200);
  });

  it("caps the prompt and the answer length", async () => {
    const tooLong = await chat("mock/echo", "x".repeat(DEMO_MAX_PROMPT_CHARS + 1));
    expect(tooLong.status).toBe(400);
    expect((await completion(tooLong)).error?.code).toBe("demo_prompt_too_long");
  });

  it("is refused providers it may not spend, by name and inside routes", async () => {
    const direct = await chat("gemini/gemini-3.5-flash-lite", "hi");
    expect(direct.status).toBe(403);
    expect((await completion(direct)).error?.code).toBe("not_available_on_demo_key");
    // In a route the provider is simply left out; here nothing else is configured behind it.
    expect((await chat("smart", "hi")).status).toBe(403);
    const listed = (await (await call("/api/health")).json()) as { providers: { id: string; demo: boolean; paid: boolean }[] };
    expect(listed.providers.find((p) => p.id === "openai")).toMatchObject({ paid: true, demo: false });
    expect(listed.providers.find((p) => p.id === "groq")).toMatchObject({ paid: false, demo: true });
  });

  it("ends the outage demo with the mock's canned reply when no real upstream is configured, and never caches it", async () => {
    const address = newAddress();
    for (let i = 0; i < 2; i++) {
      const body = await completion(await chat("demo-outage", "anyone there?", { address }));
      expect(body.choices[0]?.message.content).toBe(CANNED);
      expect(body.tollgate.cache).toBe("miss");
      await traceOf(body.id, DEMO_KEY);
    }
  });
});

describe("the dashboard API", () => {
  it("lists routes and configured models", async () => {
    const body = (await (await call("/v1/models", { method: "GET" })).json()) as { data: { id: string; kind: string }[] };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("fast");
    expect(ids).toContain("mock/echo");
    expect(ids).not.toContain("groq/llama-3.1-8b-instant");
  });

  it("shows a key only its own traces", async () => {
    const a = await newKey();
    const b = await newKey();
    const body = await completion(await chat("mock/echo", "mine", { key: a.key }));
    await traceOf(body.id, a.key);
    const mine = (await (await call("/api/traces", { key: a.key })).json()) as { traces: Trace[] };
    expect(mine.traces.map((t) => t.id)).toEqual([body.id]);
    expect((await call(`/api/traces/${body.id}`, { key: b.key })).status).toBe(404);
    expect((await call("/api/traces", { key: null })).status).toBe(401);
  });

  it("adds up a key's traffic", async () => {
    const { key } = await newKey({ cacheMode: "exact", requestsPerMinute: 6 });
    const wait = async (response: Response) => traceOf(response.headers.get("X-Tollgate-Request-Id") ?? "", key).then(() => response.text());
    await wait(await chat("mock/echo", "alpha", { key }));
    await wait(await chat("mock/echo", "alpha", { key })); // exact hit
    await wait(await chat("mock-fallback", "beta", { key })); // one fallback
    await wait(await chat("mock-down", "gamma", { key })); // fails
    await wait(await chat("mock/echo", "delta", { key, stream: true }));
    await wait(await chat("mock/echo", "epsilon", { key }));
    await wait(await chat("mock/echo", "zeta", { key })); // over the limit of 6

    const stats = (await (await call("/api/stats?hours=1", { key })).json()) as Stats;
    expect(stats).toMatchObject({ requests: 7, served: 5, cacheExact: 1, cacheSemantic: 0, rateLimited: 1, failed: 1, fellBack: 1 });
    expect(stats.completionTokens).toBeGreaterThan(0);
    expect(stats.latency.upstreamP50).not.toBeNull();
    expect(stats.latency.cachedP50).not.toBeNull();
    expect(stats.hourly).toHaveLength(1);
    expect(stats.hourly[0]).toMatchObject({ upstream: 4, cached: 1, rejected: 1, failed: 1 });
    const echo = stats.byProvider.find((p) => p.provider === "mock/echo");
    expect(echo).toEqual({ provider: "mock/echo", requests: 4, failures: 0 });
    expect(stats.byProvider.find((p) => p.provider === "mock/fail-503")).toMatchObject({ requests: 2, failures: 2 });
  });
});

describe("the admin API", () => {
  it("needs the admin token", async () => {
    expect((await call("/api/admin/keys", { method: "GET", key: DEMO_KEY })).status).toBe(401);
    expect((await call("/api/admin/keys", { method: "GET", key: null })).status).toBe(401);
  });

  it("creates a key, shows it once, and lists only its prefix", async () => {
    const created = await newKey({ name: "listed" });
    expect(created.key).toMatch(/^tg_live_[A-Za-z0-9]{40}$/);
    const listed = await (await adminCall("/api/admin/keys", "GET")).text();
    expect(listed).toContain(created.key.slice(0, 12));
    expect(listed).not.toContain(created.key);
    const stored = await env.DB.prepare("SELECT key_hash FROM api_keys WHERE id = ?").bind(created.id).first<{ key_hash: string }>();
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scores prompt pairs with the cache's embedder", async () => {
    const response = await adminCall("/api/admin/similarity", "POST", { pairs: [["reset my password", "reset my password"], ["reset my password", "tallest mountain"]] });
    const body = (await response.json()) as { embedder: string; scores: number[] };
    expect(body.embedder).toBe("word-hash");
    expect(body.scores[0]).toBeCloseTo(1, 5);
    expect(body.scores[1]).toBeLessThan(0.3);
  });

  it("deletes old traces and expired cache vectors", async () => {
    const old = Date.now() - 8 * 24 * 3_600_000;
    await env.DB.prepare(
      "INSERT INTO traces (id, ts, key_id, model_requested, status, outcome, cache, stream, attempts, latency_ms) VALUES ('old', ?, 'k', 'm', 200, 'ok', 'off', 0, '[]', 1), ('new', ?, 'k', 'm', 200, 'ok', 'off', 0, '[]', 1)",
    )
      .bind(old, Date.now())
      .run();
    await env.DB.prepare("INSERT INTO cache_vectors (id, expires_at) VALUES ('gone', ?), ('kept', ?)").bind(Date.now() - 1, Date.now() + 60_000).run();
    const result = (await (await adminCall("/api/admin/maintenance")).json()) as { tracesDeleted: number; vectorsDeleted: number };
    expect(result).toEqual({ tracesDeleted: 1, vectorsDeleted: 1 });
    const left = await env.DB.prepare("SELECT id FROM cache_vectors").all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toContain("kept");
    expect(left.results.map((r) => r.id)).not.toContain("gone");
  });
});
