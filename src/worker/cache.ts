// Two caches in front of the upstreams.
//
// Exact: the same request (route, messages, sampling settings) from the same key returns the
// stored answer. Keyed by a hash and kept in the Cache API of the Cloudflare location that
// served the request: a lookup there takes about 3 ms, where a miss in the global key-value
// store took about 190 ms (measured; see docs/results.md). The price is that a hit needs the
// earlier request to have come through the same location.
//
// Semantic: a request whose last user message means the same as an earlier one returns that
// earlier answer. Two steps, because the first alone is not safe:
//   1. The message is embedded and the nearest stored message is found. Everything else about
//      the request (key, route, earlier turns, settings) has to match exactly, which is
//      arranged by searching only among vectors filed under a hash of all of that.
//   2. A model is asked whether the two messages really ask for the same thing. Embeddings
//      put "convert dollars to euros" and "convert euros to dollars" at 0.99; on a labelled
//      set no threshold kept wrong answers out without also rejecting most rewordings
//      (docs/results.md). The judge is what keeps them out.
// These answers are global: the vectors live in Vectorize and the answers in KV.

import type { CacheMode } from "../shared/api";
import type { AppEnv } from "./env";
import type { ChatParams, Message } from "./providers/base";

export const DEFAULT_TTL_SECONDS = 3600;
/** Cosine similarity a stored prompt needs before the judge is asked about it. */
export const DEFAULT_THRESHOLD = 0.85;
const MAX_SEMANTIC_CHARS = 2000;
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const JUDGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/**
 * A judge slower than this is not waited for; the request is treated as a miss. Measured on
 * the deployment, a verdict usually takes about half a second and occasionally two or three.
 */
export const JUDGE_TIMEOUT_MS = 1500;

export interface CachedAnswer {
  text: string;
  finish: "stop" | "length";
  promptTokens: number;
  completionTokens: number;
  /** The upstream that produced it, as "provider/model". */
  target: string;
  createdAt: number;
  /** Semantic entries only: the user message this answered, for the judge to compare against. */
  prompt?: string;
}

export interface Embedder {
  id: string;
  embed(text: string): Promise<number[]>;
  /** Several texts in one call to the model. */
  embedAll(texts: string[]): Promise<number[][]>;
}

export interface VectorIndex {
  id: string;
  nearest(vector: number[], scope: string): Promise<{ id: string; score: number } | null>;
  insert(id: string, vector: number[], scope: string): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

export type Verdict = "accepted" | "rejected" | "timeout";

export interface Judge {
  id: string;
  /** Would a correct answer to `stored` also answer `asked`? "timeout" when no verdict came in time. */
  same(stored: string, asked: string): Promise<Verdict>;
}

export interface SemanticBackends {
  embedder: Embedder;
  index: VectorIndex;
  /** Null when no model is available; matches then rest on the threshold alone. */
  judge: Judge | null;
}

export const JUDGE_INSTRUCTIONS =
  "You compare two questions. Answer YES only if a correct answer to Question A would also be a correct and complete answer to Question B. " +
  "If they ask about different things, different items, different numbers, opposite directions, or one negates the other, answer NO. " +
  "Reply with exactly one word: YES or NO.";

function modelJudge(ai: Ai): Judge {
  const run = ai.run as unknown as (model: string, input: unknown) => Promise<{ response?: string; choices?: { message?: { content?: string } }[] }>;
  return {
    id: JUDGE_MODEL,
    async same(stored, asked) {
      const verdict = run
        .call(ai, JUDGE_MODEL, {
          messages: [
            { role: "system", content: JUDGE_INSTRUCTIONS },
            { role: "user", content: `Question A: ${stored}\nQuestion B: ${asked}` },
          ],
          max_tokens: 4,
          temperature: 0,
        })
        .then((out): Verdict => (/^\s*yes/i.test(out.response ?? out.choices?.[0]?.message?.content ?? "") ? "accepted" : "rejected"));
      const timeout = new Promise<Verdict>((resolve) => setTimeout(() => resolve("timeout"), JUDGE_TIMEOUT_MS));
      return Promise.race([verdict, timeout]);
    },
  };
}

// ── Workers AI + Vectorize ──────────────────────────────────────────────────

function workersAiEmbedder(ai: Ai): Embedder {
  const run = ai.run as unknown as (model: string, input: unknown) => Promise<{ data?: number[][] }>;
  const embedAll = async (texts: string[]) => {
    const vectors = (await run.call(ai, EMBEDDING_MODEL, { text: texts })).data;
    if (!vectors || vectors.length !== texts.length) throw new Error("the embedding model returned nothing");
    return vectors;
  };
  return { id: EMBEDDING_MODEL, embedAll, embed: async (text) => (await embedAll([text]))[0] ?? [] };
}

function vectorize(index: VectorizeIndex): VectorIndex {
  return {
    id: "vectorize",
    async nearest(vector, scope) {
      const match = (await index.query(vector, { topK: 1, namespace: scope })).matches[0];
      return match ? { id: match.id, score: match.score } : null;
    },
    async insert(id, vector, scope) {
      await index.upsert([{ id, values: vector, namespace: scope }]);
    },
    async remove(ids) {
      if (ids.length) await index.deleteByIds(ids);
    },
  };
}

// ── Local stand-ins, used when the bindings are absent (tests, offline development) ──

/** Hashes words and word pairs into a fixed-size vector. Not a language model: it only sees shared wording. */
export function wordHashEmbedder(dimensions = 256): Embedder {
  const embed = async (text: string) => {
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const vector = new Array<number>(dimensions).fill(0);
    const add = (term: string, weight: number) => {
      let hash = 2166136261;
      for (let i = 0; i < term.length; i++) hash = Math.imul(hash ^ term.charCodeAt(i), 16777619);
      const slot = (hash >>> 0) % dimensions;
      vector[slot] = (vector[slot] ?? 0) + weight;
    };
    words.forEach((word, i) => {
      add(word, 1);
      const following = words[i + 1];
      if (following) add(`${word} ${following}`, 0.5);
    });
    const length = Math.hypot(...vector) || 1;
    return vector.map((value) => value / length);
  };
  return { id: "word-hash", embed, embedAll: (texts) => Promise.all(texts.map(embed)) };
}

const memory = new Map<string, { id: string; vector: number[] }[]>();

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function memoryIndex(): VectorIndex {
  return {
    id: "memory",
    async nearest(vector, scope) {
      let best: { id: string; score: number } | null = null;
      for (const entry of memory.get(scope) ?? []) {
        const score = cosine(vector, entry.vector);
        if (!best || score > best.score) best = { id: entry.id, score };
      }
      return best;
    },
    async insert(id, vector, scope) {
      memory.set(scope, [...(memory.get(scope) ?? []), { id, vector }]);
    },
    async remove(ids) {
      for (const [scope, entries] of memory) memory.set(scope, entries.filter((e) => !ids.includes(e.id)));
    },
  };
}

export function semanticBackends(env: AppEnv): SemanticBackends {
  if (env.AI && env.VECTORS) return { embedder: workersAiEmbedder(env.AI), index: vectorize(env.VECTORS), judge: modelJudge(env.AI) };
  return { embedder: wordHashEmbedder(), index: memoryIndex(), judge: null };
}

// ── The cache itself ────────────────────────────────────────────────────────

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function settings(params: ChatParams): unknown[] {
  return [params.temperature ?? null, params.top_p ?? null, params.max_tokens ?? null, params.stop ?? null];
}

export interface CacheRequest {
  mode: CacheMode;
  /** Whose cache this is. Answers are never shared between keys. */
  owner: string;
  route: string;
  params: ChatParams;
  threshold: number;
  ttlSeconds: number;
}

export interface ExactLookup {
  key: string | null;
  hit: CachedAnswer | null;
}

export interface SemanticLookup {
  hit: { answer: CachedAnswer; similarity: number } | null;
  /** Carried from lookup to store so the prompt is not embedded twice. */
  pending: { scope: string; vector: number[]; prompt: string } | null;
  /** The similarity of the nearest stored prompt, whether or not it was used. */
  nearest: number | null;
  /** What the judge said about that prompt; null if it was not asked. */
  judged: Verdict | null;
}

const exactUrl = (key: string) => `https://exact.tollgate.invalid/${key}`;

export async function lookupExact(request: CacheRequest): Promise<ExactLookup> {
  if (request.mode === "off") return { key: null, hit: null };
  const key = await sha256([request.owner, request.route, request.params.messages, settings(request.params)]);
  const stored = await caches.default.match(exactUrl(key));
  return { key, hit: stored ? ((await stored.json()) as CachedAnswer) : null };
}

function semanticText(messages: Message[]): string | null {
  const last = messages.at(-1);
  if (!last || last.role !== "user") return null;
  const text = last.content.trim();
  return text.length > 0 && text.length <= MAX_SEMANTIC_CHARS ? text : null;
}

const NO_SEMANTIC: SemanticLookup = { hit: null, pending: null, nearest: null, judged: null };

export async function lookupSemantic(env: AppEnv, request: CacheRequest, backends: SemanticBackends = semanticBackends(env)): Promise<SemanticLookup> {
  const text = request.mode === "semantic" ? semanticText(request.params.messages) : null;
  if (!text) return NO_SEMANTIC;
  // A failing embedder, index or judge must never fail the request: the cache just misses.
  try {
    const { embedder, index, judge } = backends;
    const { owner, route, params } = request;
    const scope = (await sha256([owner, route, params.messages.slice(0, -1), settings(params)])).slice(0, 48);
    const vector = await embedder.embed(text);
    const pending = { scope, vector, prompt: text };
    const nearest = await index.nearest(vector, scope);
    const miss: SemanticLookup = { hit: null, pending, nearest: nearest?.score ?? null, judged: null };
    if (!nearest || nearest.score < request.threshold) return miss;
    const answer = await env.CACHE.get<CachedAnswer>(`s:${nearest.id}`, "json");
    if (!answer) return miss;
    const verdict = judge ? await judge.same(answer.prompt ?? "", text) : null;
    if (verdict && verdict !== "accepted") return { ...miss, judged: verdict };
    return { hit: { answer, similarity: nearest.score }, pending: null, nearest: nearest.score, judged: verdict };
  } catch (error) {
    console.warn("semantic cache lookup failed:", error);
    return NO_SEMANTIC;
  }
}

/**
 * Keeps an answer. Always under the exact key; and, when a semantic lookup missed, as a new
 * vector too. (After a semantic hit there is nothing new to embed, but storing the answer
 * under the reworded request's exact key makes its next repeat a 3 ms hit.)
 */
export async function store(
  env: AppEnv,
  request: CacheRequest,
  exactKey: string | null,
  pending: SemanticLookup["pending"],
  answer: CachedAnswer,
): Promise<void> {
  if (!exactKey || !answer.text) return;
  const expirationTtl = request.ttlSeconds;
  const body = JSON.stringify(answer);
  const writes: Promise<unknown>[] = [
    caches.default.put(exactUrl(exactKey), new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${expirationTtl}` } })),
  ];
  if (pending) {
    const id = crypto.randomUUID();
    const { index } = semanticBackends(env);
    writes.push(
      env.CACHE.put(`s:${id}`, JSON.stringify({ ...answer, prompt: pending.prompt }), { expirationTtl }),
      index.insert(id, pending.vector, pending.scope),
      env.DB.prepare("INSERT INTO cache_vectors (id, expires_at) VALUES (?, ?)")
        .bind(id, Date.now() + expirationTtl * 1000)
        .run(),
    );
  }
  const results = await Promise.allSettled(writes);
  for (const result of results) if (result.status === "rejected") console.warn("cache write failed:", result.reason);
}

/** Deletes vectors whose stored answers have expired. Run from the daily cron. */
export async function sweep(env: AppEnv, now: number): Promise<number> {
  const { index } = semanticBackends(env);
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const { results } = await env.DB.prepare("SELECT id FROM cache_vectors WHERE expires_at < ? LIMIT 100").bind(now).all<{ id: string }>();
    if (results.length === 0) break;
    const ids = results.map((row) => row.id);
    await index.remove(ids);
    await env.DB.prepare(`DELETE FROM cache_vectors WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
    removed += ids.length;
  }
  return removed;
}
