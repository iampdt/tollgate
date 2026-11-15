import { describe, expect, it } from "vitest";
import { type CachedAnswer, type CacheRequest, type Judge, lookupExact, lookupSemantic, type SemanticBackends, store, type VectorIndex, wordHashEmbedder, cosine } from "../src/worker/cache";
import { chat, completion, env, newKey, traceOf } from "./helpers";

function request(prompt: string, overrides: Partial<CacheRequest> = {}): CacheRequest {
  return {
    mode: "semantic",
    owner: crypto.randomUUID(),
    route: "mock/echo",
    params: { model: "mock/echo", messages: [{ role: "user", content: prompt }] },
    threshold: 0.8,
    ttlSeconds: 60,
    ...overrides,
  };
}

function backends(judge: Judge | null): SemanticBackends & { asked: [string, string][] } {
  const entries = new Map<string, { id: string; vector: number[] }[]>();
  const index: VectorIndex = {
    id: "test",
    async nearest(vector, scope) {
      return (entries.get(scope) ?? []).map((e) => ({ id: e.id, score: cosine(vector, e.vector) })).sort((a, b) => b.score - a.score)[0] ?? null;
    },
    async insert(id, vector, scope) {
      entries.set(scope, [...(entries.get(scope) ?? []), { id, vector }]);
    },
    async remove() {},
  };
  const asked: [string, string][] = [];
  const recording: Judge | null = judge && {
    id: judge.id,
    same: (stored, now) => (asked.push([stored, now]), judge.same(stored, now)),
  };
  return { embedder: wordHashEmbedder(), index, judge: recording, asked };
}

const answer: CachedAnswer = { text: "Go to Settings, then Security.", finish: "stop", promptTokens: 9, completionTokens: 7, target: "mock/echo", createdAt: 1 };

/** Stores an answer for `first` the way a real miss would, with the given backends' index. */
async function remember(first: CacheRequest, with_: SemanticBackends): Promise<void> {
  const missed = await lookupSemantic(env, first, with_);
  expect(missed.hit).toBeNull();
  const id = crypto.randomUUID();
  await env.CACHE.put(`s:${id}`, JSON.stringify({ ...answer, prompt: missed.pending?.prompt }), { expirationTtl: 60 });
  await with_.index.insert(id, missed.pending?.vector ?? [], missed.pending?.scope ?? "");
}

describe("the semantic cache's judge", () => {
  const stored = "How do I reset my account password?";
  const reworded = "how do I reset my account password please";

  it("is asked about the stored prompt and the new one, and its yes makes a hit", async () => {
    const with_ = backends({ id: "yes", same: async () => "accepted" });
    const first = request(stored);
    await remember(first, with_);
    const found = await lookupSemantic(env, { ...first, params: { ...first.params, messages: [{ role: "user", content: reworded }] } }, with_);
    expect(found.hit?.answer.text).toBe(answer.text);
    expect(found.hit?.similarity).toBeGreaterThan(0.8);
    expect(with_.asked).toEqual([[stored, reworded]]);
  });

  it("turns a close match into a miss when it says no, and the new prompt is still stored afterwards", async () => {
    const with_ = backends({ id: "no", same: async () => "rejected" });
    const first = request(stored);
    await remember(first, with_);
    const found = await lookupSemantic(env, { ...first, params: { ...first.params, messages: [{ role: "user", content: reworded }] } }, with_);
    expect(found.hit).toBeNull();
    expect(found.judged).toBe("rejected");
    expect(found.nearest).toBeGreaterThan(0.8);
    expect(found.pending?.prompt).toBe(reworded);
  });

  it("is not asked when nothing is similar enough", async () => {
    const with_ = backends({ id: "yes", same: async () => "accepted" });
    const first = request(stored);
    await remember(first, with_);
    const found = await lookupSemantic(env, { ...first, params: { ...first.params, messages: [{ role: "user", content: "What is the tallest mountain in Asia?" }] } }, with_);
    expect(found.hit).toBeNull();
    expect(with_.asked).toEqual([]);
  });

  it("running out of time is a miss, recorded as such", async () => {
    const with_ = backends({ id: "slow", same: async () => "timeout" });
    const first = request(stored);
    await remember(first, with_);
    const found = await lookupSemantic(env, { ...first, params: { ...first.params, messages: [{ role: "user", content: reworded }] } }, with_);
    expect(found).toMatchObject({ hit: null, judged: "timeout" });
    expect(found.pending?.prompt).toBe(reworded);
  });

  it("failing is a miss, not an error", async () => {
    const with_ = backends({
      id: "broken",
      same: async () => {
        throw new Error("model unavailable");
      },
    });
    const first = request(stored);
    await remember(first, with_);
    const found = await lookupSemantic(env, { ...first, params: { ...first.params, messages: [{ role: "user", content: reworded }] } }, with_);
    expect(found).toEqual({ hit: null, pending: null, nearest: null, judged: null });
  });

  it("is skipped for prompts that are not a single user question", async () => {
    const with_ = backends({ id: "yes", same: async () => "accepted" });
    const assistantLast = request("x", { params: { model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } });
    for (const skipped of [assistantLast, request("y".repeat(2001)), request(stored, { mode: "exact" })]) {
      expect(await lookupSemantic(env, skipped, with_)).toMatchObject({ hit: null, pending: null, nearest: null });
    }
  });
});

describe("storing answers", () => {
  it("keeps an exact entry only for the request that produced it", async () => {
    const one = request("alpha", { mode: "exact" });
    const exact = await lookupExact(one);
    expect(exact.hit).toBeNull();
    await store(env, one, exact.key, null, answer);
    expect((await lookupExact(one)).hit?.text).toBe(answer.text);
    expect((await lookupExact({ ...one, owner: "someone-else" })).hit).toBeNull();
    expect((await lookupExact({ ...one, params: { ...one.params, temperature: 0.5 } })).hit).toBeNull();
  });

  it("does nothing when caching is off or the answer is empty", async () => {
    const off = request("beta", { mode: "off" });
    expect(await lookupExact(off)).toEqual({ key: null, hit: null });
    const on = request("gamma", { mode: "exact" });
    const exact = await lookupExact(on);
    await store(env, on, exact.key, null, { ...answer, text: "" });
    expect((await lookupExact(on)).hit).toBeNull();
  });
});

describe("after a semantic hit", () => {
  it("the reworded request is an exact hit the next time", async () => {
    const { key } = await newKey({ cacheMode: "semantic" });
    const loose = { "X-Tollgate-Similarity-Threshold": "0.8" };
    const first = await completion(await chat("mock/echo", "How do I reset my account password?", { key }));
    await traceOf(first.id, key);
    const reworded = "how do I reset my account password please";
    const second = await completion(await chat("mock/echo", reworded, { key, headers: loose }));
    expect(second.tollgate.cache).toBe("semantic");
    await traceOf(second.id, key);
    const third = await completion(await chat("mock/echo", reworded, { key, headers: loose }));
    expect(third.tollgate.cache).toBe("exact");
    expect(third.choices[0]?.message.content).toBe("How do I reset my account password?");
  });
});
