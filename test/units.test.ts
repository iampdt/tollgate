import { describe, expect, it } from "vitest";
import { BASE_OPEN_MS, check, type Circuits, FAILURES_TO_OPEN, MAX_OPEN_MS, PROBE_LEASE_MS, report, stateOf } from "../src/worker/breaker";
import { cosine, wordHashEmbedder } from "../src/worker/cache";
import { costMicros, forTarget, parseTarget, resolve, ROUTES } from "../src/worker/catalog";
import { admit, freshState, type Limits } from "../src/worker/gate";
import { type Part, type Provider, ProviderError, sseData } from "../src/worker/providers/base";
import { mock } from "../src/worker/providers/mock";
import { openAiCompatible } from "../src/worker/providers/openai-compat";
import { workersAi } from "../src/worker/providers/workers-ai";

const T0 = Date.parse("2026-11-16T10:00:00Z");

describe("the rate limit and budget policy", () => {
  const limits: Limits = { requestsPerMinute: 60, tokensPerDay: 1000 };

  it("admits a burst up to the per-minute limit, then refuses with a wait", () => {
    let state = freshState(limits, T0);
    for (let i = 0; i < 60; i++) {
      const result = admit(state, limits, T0);
      expect(result.admission.ok).toBe(true);
      state = result.state;
    }
    const refused = admit(state, limits, T0);
    expect(refused.admission).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 1 });
  });

  it("refills at the configured rate and never above the limit", () => {
    let state = freshState(limits, T0);
    for (let i = 0; i < 60; i++) state = admit(state, limits, T0).state;
    // One request per second at 60 per minute.
    state = admit(state, limits, T0 + 1000).state;
    expect(admit(state, limits, T0 + 1000).admission.ok).toBe(false);
    const afterAnHour = admit(state, limits, T0 + 3_600_000);
    expect(afterAnHour.admission).toEqual({ ok: true, remaining: 59 });
  });

  it("says how long to wait when the limit is below one request per second", () => {
    const slow: Limits = { requestsPerMinute: 2, tokensPerDay: 1000 };
    let state = freshState(slow, T0);
    state = admit(state, slow, T0).state;
    state = admit(state, slow, T0).state;
    expect(admit(state, slow, T0).admission).toMatchObject({ ok: false, retryAfterSeconds: 30 });
  });

  it("refuses once the day's tokens are used, until midnight UTC", () => {
    const state = { ...freshState(limits, T0), tokensUsed: 1000 };
    const refused = admit(state, limits, T0);
    expect(refused.admission).toEqual({ ok: false, reason: "budget_exhausted", retryAfterSeconds: 14 * 3600 });
    const nextDay = admit(state, limits, T0 + 14 * 3_600_000);
    expect(nextDay.admission.ok).toBe(true);
    expect(nextDay.state.tokensUsed).toBe(0);
  });

  it("does not spend a rate-limit slot on a request refused for budget", () => {
    const state = { ...freshState(limits, T0), tokensUsed: 1000 };
    expect(admit(state, limits, T0).state.bucket).toBe(60);
  });
});

describe("the circuit breaker", () => {
  const fail = (circuits: Circuits, times: number, now: number) => {
    for (let i = 0; i < times; i++) circuits = report(circuits, [{ target: "a", ok: false }], now);
    return circuits;
  };

  it("stays closed below the failure threshold, and a success clears the count", () => {
    let circuits = fail({}, FAILURES_TO_OPEN - 1, T0);
    expect(stateOf(circuits.a, T0)).toBe("closed");
    circuits = report(circuits, [{ target: "a", ok: true }], T0);
    circuits = fail(circuits, FAILURES_TO_OPEN - 1, T0);
    expect(stateOf(circuits.a, T0)).toBe("closed");
  });

  it("opens after enough failures in a row and is skipped until the cool-off ends", () => {
    const circuits = fail({}, FAILURES_TO_OPEN, T0);
    expect(check(circuits, ["a", "b"], T0 + 1).states).toEqual({ a: "open", b: "closed" });
    expect(check(circuits, ["a"], T0 + BASE_OPEN_MS - 1).states.a).toBe("open");
  });

  it("lets exactly one request test a half-open upstream", () => {
    const circuits = fail({}, FAILURES_TO_OPEN, T0);
    const later = T0 + BASE_OPEN_MS;
    const first = check(circuits, ["a"], later);
    expect(first.states.a).toBe("half_open");
    const second = check(first.circuits, ["a"], later + 5);
    expect(second.states.a).toBe("open");
    // If the test never reports back, another request gets the turn once the lease runs out.
    expect(check(second.circuits, ["a"], later + PROBE_LEASE_MS).states.a).toBe("half_open");
  });

  it("closes on a successful test", () => {
    const opened = fail({}, FAILURES_TO_OPEN, T0);
    const probing = check(opened, ["a"], T0 + BASE_OPEN_MS).circuits;
    const closed = report(probing, [{ target: "a", ok: true }], T0 + BASE_OPEN_MS + 50);
    expect(check(closed, ["a"], T0 + BASE_OPEN_MS + 51).states.a).toBe("closed");
  });

  it("opens for twice as long after each failed test, up to a ceiling", () => {
    let circuits = fail({}, FAILURES_TO_OPEN, T0);
    let now = T0;
    let openMs = BASE_OPEN_MS;
    for (let round = 0; round < 6; round++) {
      now += openMs;
      circuits = check(circuits, ["a"], now).circuits;
      circuits = report(circuits, [{ target: "a", ok: false }], now);
      openMs = Math.min(MAX_OPEN_MS, openMs * 2);
      expect(circuits.a?.openUntil).toBe(now + openMs);
    }
    expect(openMs).toBe(MAX_OPEN_MS);
  });

  it("does not lengthen the cool-off for failures that were already in flight", () => {
    let circuits = fail({}, FAILURES_TO_OPEN, T0);
    circuits = report(circuits, [{ target: "a", ok: false }], T0 + 10);
    expect(circuits.a?.openMs).toBe(BASE_OPEN_MS);
  });
});

describe("the catalog", () => {
  const providers = new Map<string, Provider>([["mock", mock()]]);

  it("gives a route's targets in order, leaving out providers without credentials", () => {
    expect(resolve("demo-outage", providers)?.targets.map((t) => t.id)).toEqual(["mock/fail-503", "mock/canned"]);
    expect(resolve("fast", providers)?.targets).toEqual([]);
  });

  it("addresses one model directly, with no fallback", () => {
    expect(resolve("mock/echo", providers)?.targets).toEqual([{ id: "mock/echo", provider: "mock", model: "echo" }]);
  });

  it("keeps the slashes of a model name out of the provider", () => {
    const withAi = new Map(providers).set("workers-ai", mock());
    expect(resolve("workers-ai/@cf/meta/llama-3.2-3b-instruct", withAi)?.targets[0]).toMatchObject({ provider: "workers-ai", model: "@cf/meta/llama-3.2-3b-instruct" });
  });

  it("leaves out providers the demo key may not spend", () => {
    const all = new Map<string, Provider>([["mock", mock()], ["groq", mock()], ["gemini", mock()], ["openai", mock()], ["workers-ai", mock()]]);
    expect(resolve("premium", all)?.targets.map((t) => t.provider)).toEqual(["openai", "gemini", "groq", "workers-ai"]);
    expect(resolve("premium", all, true)?.targets.map((t) => t.provider)).toEqual(["groq", "workers-ai"]);
    expect(resolve("openai/gpt-4.1-mini", all, true)?.targets).toEqual([]);
    expect(resolve("fast", all, true)?.targets.map((t) => t.provider)).toEqual(["groq", "workers-ai", "workers-ai"]);
  });

  it("does not know models outside the catalog", () => {
    expect(resolve("workers-ai/@cf/openai/gpt-oss-120b", providers)).toBeNull();
    expect(resolve("nope", providers)).toBeNull();
  });

  it("every route points at catalogued models", () => {
    for (const route of Object.values(ROUTES)) for (const target of route.targets) expect(resolve(target, new Map())).not.toBeNull();
  });

  it("gives a thinking model room beyond the caller's limit, and only when there is a limit", () => {
    const groq = parseTarget("groq/openai/gpt-oss-20b");
    expect(forTarget(groq, { max_tokens: 40 })).toMatchObject({ model: "openai/gpt-oss-20b", max_tokens: 200, extra: { reasoning_effort: "low" } });
    expect(forTarget(groq, {})).not.toHaveProperty("max_tokens");
    expect(forTarget(parseTarget("mock/echo"), { max_tokens: 40 })).toMatchObject({ model: "echo", max_tokens: 40 });
  });

  it("prices tokens in millionths of a dollar", () => {
    // 1,000 in at $0.293 per million and 500 out at $2.253 per million.
    expect(costMicros("workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast", 1000, 500)).toBe(Math.round(293 + 1126.5));
    expect(costMicros("somewhere/unpriced-model", 1000, 500)).toBe(0);
  });
});

describe("the offline embedder", () => {
  const embedder = wordHashEmbedder();
  const similarity = async (a: string, b: string) => cosine(await embedder.embed(a), await embedder.embed(b));

  it("scores identical text 1, shared wording high and unrelated text low", async () => {
    expect(await similarity("How do I reset my password?", "how do i reset my password")).toBeCloseTo(1, 5);
    expect(await similarity("How do I reset my password?", "How do I reset my password please?")).toBeGreaterThan(0.85);
    expect(await similarity("How do I reset my password?", "What is the tallest mountain in Asia?")).toBeLessThan(0.3);
  });
});

function bytes(text: string, pieces: number): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  const size = Math.ceil(encoded.length / pieces);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < encoded.length; i += size) controller.enqueue(encoded.slice(i, i + size));
      controller.close();
    },
  });
}

async function collect(stream: AsyncGenerator<Part>): Promise<{ text: string; parts: Part[] }> {
  const parts: Part[] = [];
  for await (const part of stream) parts.push(part);
  return { text: parts.map((p) => p.delta ?? "").join(""), parts };
}

describe("reading server-sent events", () => {
  it("reassembles events split across network chunks, including multi-byte characters", async () => {
    const text = 'data: {"a":"héllo"}\r\n\r\n: comment\n\ndata: {"a":"wörld €"}\n\ndata: [DONE]';
    for (const pieces of [1, 3, 7, 40]) {
      const seen: string[] = [];
      for await (const data of sseData(bytes(text, pieces), new AbortController().signal)) seen.push(data);
      expect(seen).toEqual(['{"a":"héllo"}', '{"a":"wörld €"}', "[DONE]"]);
    }
  });
});

describe("the OpenAI-compatible adapter", () => {
  const signal = () => new AbortController().signal;
  const params = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

  it("sends the request as a stream with usage, and reads text, finish reason and usage", async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("Authorization") };
      return new Response(
        bytes(
          'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"length"}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n' +
            "data: [DONE]\n\n",
          5,
        ),
      );
    }) as unknown as typeof fetch;
    const result = await collect(openAiCompatible("groq", "https://x.test/v1", "secret", { fetcher }).stream(params, signal()));
    expect(result.text).toBe("Hello");
    expect(result.parts.find((p) => p.finish)?.finish).toBe("length");
    expect(result.parts.find((p) => p.usage)?.usage).toEqual({ promptTokens: 7, completionTokens: 2 });
    expect(sent).toMatchObject({ url: "https://x.test/v1/chat/completions", auth: "Bearer secret", body: { model: "m", stream: true, stream_options: { include_usage: true } } });
  });

  it.each([
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [401, "auth"],
    [400, "bad_request"],
    [404, "server"],
    [504, "timeout"],
  ])("turns HTTP %i into a %s failure", async (status, kind) => {
    const fetcher = (async () => new Response("nope", { status })) as unknown as typeof fetch;
    const error = await collect(openAiCompatible("x", "https://x.test", "k", { fetcher }).stream(params, signal())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind, status });
  });

  it("names the token limit the way the provider wants it, and adds the model's extra fields", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(bytes("data: [DONE]\n\n", 1));
    }) as unknown as typeof fetch;
    const limited = { ...params, max_tokens: 64, extra: { reasoning_effort: "low" } };
    await collect(openAiCompatible("groq", "https://x.test", "k", { fetcher }).stream(limited, signal()));
    await collect(openAiCompatible("openai", "https://x.test", "k", { fetcher, maxTokensField: "max_completion_tokens" }).stream(limited, signal()));
    expect(bodies[0]).toMatchObject({ max_tokens: 64, reasoning_effort: "low", stream: true });
    expect(bodies[0]).not.toHaveProperty("extra");
    expect(bodies[1]).toMatchObject({ max_completion_tokens: 64, reasoning_effort: "low" });
    expect(bodies[1]).not.toHaveProperty("max_tokens");
  });

  it("reports a network failure, and an error sent inside the stream", async () => {
    const down = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    await expect(collect(openAiCompatible("x", "https://x.test", "k", { fetcher: down }).stream(params, signal()))).rejects.toMatchObject({ kind: "network" });
    const inline = (async () => new Response(bytes('data: {"error":{"message":"overloaded"}}\n\n', 1))) as unknown as typeof fetch;
    await expect(collect(openAiCompatible("x", "https://x.test", "k", { fetcher: inline }).stream(params, signal()))).rejects.toMatchObject({ kind: "server", message: "overloaded" });
  });
});

describe("the Workers AI adapter", () => {
  const params = { model: "@cf/x", messages: [{ role: "user" as const, content: "hi" }], max_tokens: 20 };
  const fakeAi = (run: (model: string, input: Record<string, unknown>) => unknown) => ({ run }) as unknown as Ai;

  it("reads Workers AI's own stream shape and the OpenAI shape", async () => {
    const own = fakeAi(() => bytes('data: {"response":"Hi"}\n\ndata: {"response":" there","usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n', 4));
    const a = await collect(workersAi(own).stream(params, new AbortController().signal));
    expect(a.text).toBe("Hi there");
    expect(a.parts.find((p) => p.usage)?.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
    expect(a.parts.at(-1)).toEqual({ finish: "stop" });

    const openai = fakeAi(() => bytes('data: {"choices":[{"delta":{"content":"Yo"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n', 2));
    const b = await collect(workersAi(openai).stream(params, new AbortController().signal));
    expect(b.text).toBe("Yo");
    expect(b.parts.at(-1)).toEqual({ finish: "length" });
  });

  it("passes the model, the messages and the token limit", async () => {
    let seen: { model: string; input: Record<string, unknown> } | null = null;
    const ai = fakeAi((model, input) => ((seen = { model, input }), bytes("data: [DONE]\n\n", 1)));
    await collect(workersAi(ai).stream({ ...params, temperature: 0 }, new AbortController().signal));
    expect(seen).toMatchObject({ model: "@cf/x", input: { stream: true, max_tokens: 20, temperature: 0, messages: params.messages } });
  });

  it.each([
    ["3036: you have used up your daily free allocation of 10,000 neurons", "rate_limited"],
    ["5007: No such model @cf/x", "bad_request"],
    ["3040: Capacity temporarily exceeded", "server"],
    ["something else", "server"],
  ])("classifies %j as %s", async (message, kind) => {
    const ai = fakeAi(() => {
      throw new Error(message);
    });
    await expect(collect(workersAi(ai).stream(params, new AbortController().signal))).rejects.toMatchObject({ kind });
  });
});
