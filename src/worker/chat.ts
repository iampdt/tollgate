// POST /v1/chat/completions: one request through the gateway.
//
//   authenticate → validate → admit (rate limit, budget) → cache → route with fallback → answer
//
// and, after the answer has gone out: count the tokens, store the answer, tell the circuit
// breaker what happened, write the trace.

import { z } from "zod";
import type { Attempt, CacheMode, CacheResult, Outcome, Trace } from "../shared/api";
import { breakerReports, markBroken, open, type Opened, RequestRejected, type RouterDeps, toProviderError } from "./router";
import { type CachedAnswer, DEFAULT_THRESHOLD, DEFAULT_TTL_SECONDS, lookupExact, lookupSemantic, type SemanticLookup, store } from "./cache";
import { configuredProviders, costMicros, resolve } from "./catalog";
import { type AppEnv, numberSetting } from "./env";
import type { Admission } from "./gate";
import { CORS, fail, json } from "./http";
import { authenticate, DEMO_MAX_PROMPT_CHARS, DEMO_MAX_TOKENS, gatesFor, type Key } from "./keys";
import { type ChatParams, estimateTokens, type Message, type Part, type TokenUsage } from "./providers/base";
import { record } from "./traces";

const MAX_BODY_BYTES = 256 * 1024;

const content = z.union([
  z.string(),
  // The multi-part form, text parts only. Images and audio are not routed.
  z.array(z.object({ type: z.literal("text"), text: z.string() })).transform((parts) => parts.map((p) => p.text).join("")),
]);

const requestSchema = z.object({
  model: z.string().min(1).max(200),
  messages: z
    .array(z.object({ role: z.enum(["system", "developer", "user", "assistant"]), content }))
    .min(1)
    .max(200),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(1).max(8192).optional(),
  max_completion_tokens: z.number().int().min(1).max(8192).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
});

interface Answer {
  text: string;
  finish: "stop" | "length";
  usage: TokenUsage;
}

/** Everything known about a request by the time it is over. */
interface Finished {
  status: number;
  outcome: Outcome;
  cache: CacheResult;
  similarity?: number | null;
  judged?: Trace["judged"];
  target?: string | null;
  answer?: Answer;
  firstTokenMs?: number | null;
  overheadMs?: number | null;
  admitMs?: number | null;
  cacheMs?: number | null;
  /** The answer to put in the cache, when this was a miss worth keeping. */
  keep?: CachedAnswer;
}

function headerNumber(request: Request, name: string, fallback: number, min: number, max: number): number {
  const value = Number(request.headers.get(name));
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
}

function cacheModeFor(request: Request, key: Key): CacheMode {
  const asked = request.headers.get("X-Tollgate-Cache");
  return asked === "off" || asked === "exact" || asked === "semantic" ? asked : key.cacheMode;
}

export async function chat(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const arrivedAt = Date.now();
  const id = `chatcmpl-${crypto.randomUUID()}`;

  const key = await authenticate(env, request);
  if (!key) return fail(401, "invalid_api_key", "Missing or unknown API key. Send it as: Authorization: Bearer <key>");

  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return fail(413, "request_too_large", "The request body is larger than 256 KB.");
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, "request_too_large", "The request body is larger than 256 KB.");
  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(JSON.parse(raw));
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") : "The body is not valid JSON.";
    return fail(400, "invalid_request", message);
  }

  const providers = configuredProviders(env);
  const route = resolve(parsed.model, providers, key.demo);
  if (!route) return fail(404, "model_not_found", `Unknown model "${parsed.model}". GET /v1/models lists the routes and models.`);
  if (route.targets.length === 0) {
    // Known to the full catalog but empty for this key: the demo key was refused a provider.
    return (resolve(parsed.model, providers)?.targets.length ?? 0) > 0
      ? fail(403, "not_available_on_demo_key", `"${parsed.model}" uses a provider the public demo key may not spend. Use a key of your own.`)
      : fail(503, "no_upstream_configured", `No provider behind "${parsed.model}" has credentials on this deployment.`);
  }

  const messages: Message[] = parsed.messages.map((m) => ({ role: m.role === "developer" ? "system" : m.role, content: m.content }));
  const params: Omit<ChatParams, "model"> = {
    messages,
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    max_tokens: parsed.max_completion_tokens ?? parsed.max_tokens,
    stop: parsed.stop === undefined ? undefined : typeof parsed.stop === "string" ? [parsed.stop] : parsed.stop,
  };
  const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (key.demo) {
    if (promptChars > DEMO_MAX_PROMPT_CHARS) return fail(400, "demo_prompt_too_long", `The public demo key accepts up to ${DEMO_MAX_PROMPT_CHARS} characters of prompt.`);
    params.max_tokens = Math.min(params.max_tokens ?? DEMO_MAX_TOKENS, DEMO_MAX_TOKENS);
  }
  const estimatedPrompt = estimateTokens(messages.map((m) => m.content).join("\n"));
  const streaming = parsed.stream === true;
  const wantsSummary = parsed.stream_options?.include_usage === true;

  const gates = (await gatesFor(key, request)).map((gate) => ({ stub: env.GATES.get(env.GATES.idFromName(gate.name)), limits: gate.limits }));
  const breaker = env.BREAKERS.get(env.BREAKERS.idFromName("global"));
  const attempts: Attempt[] = [];

  /** Runs after the response: nothing here may delay or fail the answer. */
  const finish = (done: Finished): Trace => {
    const usage = done.answer?.usage ?? { promptTokens: 0, completionTokens: 0 };
    const generated = done.outcome === "ok" || done.outcome === "stream_broken" || done.outcome === "client_closed";
    const listPrice = done.target ? costMicros(done.target, usage.promptTokens, usage.completionTokens) : 0;
    const slash = done.target?.indexOf("/") ?? -1;
    const trace: Trace = {
      id,
      ts: arrivedAt,
      modelRequested: parsed.model,
      provider: done.target ? done.target.slice(0, slash) : null,
      modelUsed: done.target ? done.target.slice(slash + 1) : null,
      status: done.status,
      outcome: done.outcome,
      cache: done.cache,
      similarity: done.similarity ?? nearest,
      judged: done.judged ?? judged,
      stream: streaming,
      attempts,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costMicros: generated ? listPrice : 0,
      savedMicros: done.outcome === "cached" ? listPrice : 0,
      latencyMs: Date.now() - arrivedAt,
      firstTokenMs: done.firstTokenMs ?? null,
      overheadMs: done.overheadMs ?? null,
      admitMs: done.admitMs ?? null,
      cacheMs: done.cacheMs ?? null,
    };
    const spent = generated ? usage.promptTokens + usage.completionTokens : 0;
    ctx.waitUntil(
      Promise.allSettled([
        record(env, key.id, trace),
        ...(spent > 0 ? gates.map((gate) => gate.stub.settle(spent)) : []),
        breaker.report(breakerReports(attempts)),
        done.keep ? store(env, cacheRequest, exactKey, pending, done.keep) : Promise.resolve(),
      ]).then((results) => {
        for (const result of results) if (result.status === "rejected") console.warn("after-response work failed:", result.reason);
      }),
    );
    return trace;
  };

  const cacheRequest = {
    mode: cacheModeFor(request, key),
    owner: key.id,
    route: route.name,
    params: { ...params, model: route.name },
    threshold: headerNumber(request, "X-Tollgate-Similarity-Threshold", DEFAULT_THRESHOLD, 0.5, 1),
    ttlSeconds: Math.round(headerNumber(request, "X-Tollgate-Cache-Ttl", DEFAULT_TTL_SECONDS, 60, 86_400)),
  };
  let exactKey: string | null = null;
  let pending: SemanticLookup["pending"] = null;
  // What the semantic lookup saw, kept for the trace even when it did not produce a hit.
  let nearest: number | null = null;
  let judged: Trace["judged"] = null;

  // ── Admission, the exact cache and the state of the upstreams, all asked at once ──
  // Each is a round trip (about 45 ms to a Durable Object, 3 ms to the local cache); taken one
  // after another they were most of the gateway's own latency.
  const targetIds = route.targets.map((t) => t.id);
  const timed = <T>(work: Promise<T>) => work.then((value) => ({ value, ms: Date.now() - arrivedAt }));
  const [admitted, exact, circuits] = await Promise.all([
    timed(Promise.all(gates.map((gate) => gate.stub.admit(gate.limits)))),
    timed(lookupExact(cacheRequest)),
    // A request refused below may have been handed the one test of a half-open upstream;
    // the lease on that test runs out after 20 s and the next request takes it.
    breaker.check(targetIds),
  ]);
  const admitMs = admitted.ms;
  let cacheMs = exact.ms;
  exactKey = exact.value.key;
  let remaining = Infinity;
  for (const [index, admission] of (admitted.value as Admission[]).entries()) {
    const limits = gates[index]?.limits;
    if (!admission.ok && limits) {
      finish({ status: 429, outcome: admission.reason, cache: "off", admitMs });
      const message =
        admission.reason === "rate_limited"
          ? `Rate limit reached: ${limits.requestsPerMinute} requests per minute. Try again in ${admission.retryAfterSeconds} s.`
          : `Daily token budget used up: ${limits.tokensPerDay} tokens per day. It resets at 00:00 UTC.`;
      return fail(429, admission.reason, message, { "Retry-After": String(admission.retryAfterSeconds), "X-Tollgate-Request-Id": id });
    }
    if (admission.ok) remaining = Math.min(remaining, admission.remaining);
  }

  const baseHeaders = (cache: CacheResult, target: string | null, similarity?: number | null): Record<string, string> => {
    const slash = target?.indexOf("/") ?? -1;
    return {
      "X-Tollgate-Request-Id": id,
      "X-Tollgate-Cache": cache,
      ...(similarity != null && { "X-Tollgate-Similarity": similarity.toFixed(4) }),
      ...(target && { "X-Tollgate-Provider": target.slice(0, slash), "X-Tollgate-Model": target.slice(slash + 1) }),
      "X-Tollgate-Fallbacks": String(attempts.filter((a) => a.outcome !== "ok").length),
      "X-RateLimit-Remaining-Requests": String(remaining),
    };
  };

  // ── Cache ──
  let hit: { answer: CachedAnswer; kind: "exact" | "semantic"; similarity: number | null } | null = exact.value.hit
    ? { answer: exact.value.hit, kind: "exact", similarity: null }
    : null;
  if (!hit) {
    // Only now, for an admitted request the exact cache could not answer: embedding the
    // prompt and searching the index is by far the slowest lookup (about 300 ms).
    const semanticStartedAt = Date.now();
    const semantic = await lookupSemantic(env, cacheRequest);
    if (cacheRequest.mode === "semantic") cacheMs += Date.now() - semanticStartedAt;
    pending = semantic.pending;
    nearest = semantic.nearest;
    judged = semantic.judged;
    if (semantic.hit) hit = { answer: semantic.hit.answer, kind: "semantic", similarity: semantic.hit.similarity };
  }
  if (hit) {
    const { answer: cached, kind, similarity } = hit;
    const answer: Answer = { text: cached.text, finish: cached.finish, usage: { promptTokens: cached.promptTokens, completionTokens: cached.completionTokens } };
    const trace = finish({
      status: 200,
      outcome: "cached",
      cache: kind,
      similarity,
      target: cached.target,
      answer,
      overheadMs: Date.now() - arrivedAt,
      admitMs,
      cacheMs,
      keep: kind === "semantic" ? cached : undefined,
    });
    const headers = baseHeaders(kind, cached.target, similarity);
    if (!streaming) return json(completionBody(id, parsed.model, answer, trace), 200, headers);
    return sse(headers, async (send) => {
      send(chunk(id, parsed.model, { role: "assistant", content: "" }));
      for (let i = 0; i < answer.text.length; i += 48) send(chunk(id, parsed.model, { content: answer.text.slice(i, i + 48) }));
      send(chunk(id, parsed.model, {}, answer.finish));
      if (wantsSummary) send(summaryChunk(id, parsed.model, answer.usage, trace));
    });
  }
  const cacheResult: CacheResult = cacheRequest.mode === "off" ? "off" : "miss";

  // ── Upstreams ──
  const overall = new AbortController();
  let clientGone = false;
  request.signal.addEventListener("abort", () => ((clientGone = true), overall.abort()), { once: true });
  const deadline = setTimeout(() => overall.abort(), numberSetting(env.TOTAL_TIMEOUT_MS, 60_000));
  const deps: RouterDeps = {
    providers,
    breaker: circuits,
    firstTokenTimeoutMs: numberSetting(env.FIRST_TOKEN_TIMEOUT_MS, 6_000),
    signal: overall.signal,
    now: Date.now,
  };
  const upstreamStartedAt = Date.now();
  const overheadMs = upstreamStartedAt - arrivedAt;

  const noUpstream = (): Response => {
    clearTimeout(deadline);
    const tried = attempts.filter((a) => a.outcome !== "skipped_open");
    if (clientGone) {
      finish({ status: 499, outcome: "client_closed", cache: cacheResult, overheadMs, admitMs, cacheMs });
      return new Response(null, { status: 499 });
    }
    const [status, code, message] =
      tried.length === 0
        ? ([503, "circuit_open", "Every upstream for this model is being skipped after repeated failures. Try again shortly."] as const)
        : tried.every((a) => a.outcome === "timeout")
          ? ([504, "upstream_timeout", "No upstream answered in time."] as const)
          : ([502, "all_upstreams_failed", "Every upstream for this model failed."] as const);
    finish({ status, outcome: "upstream_failed", cache: cacheResult, overheadMs, admitMs, cacheMs });
    return fail(status, code, message, { ...baseHeaders(cacheResult, null), ...(status === 503 && { "Retry-After": "30" }) }, { attempts });
  };

  const rejected = (error: RequestRejected): Response => {
    clearTimeout(deadline);
    finish({ status: 400, outcome: "bad_request", cache: cacheResult, overheadMs, admitMs, cacheMs });
    return fail(400, "upstream_rejected_request", error.message, baseHeaders(cacheResult, null), { attempts });
  };

  const usageOf = (reported: TokenUsage | undefined, text: string): TokenUsage =>
    reported && reported.promptTokens + reported.completionTokens > 0 ? reported : { promptTokens: estimatedPrompt, completionTokens: estimateTokens(text) };

  const keepable = (target: string, answer: Answer): CachedAnswer | undefined =>
    cacheRequest.mode !== "off" && answer.text && target !== "mock/canned"
      ? { text: answer.text, finish: answer.finish, promptTokens: answer.usage.promptTokens, completionTokens: answer.usage.completionTokens, target, createdAt: Date.now() }
      : undefined;

  if (!streaming) {
    // Nothing has been sent to the caller yet, so an upstream that breaks half-way through its
    // answer can still be replaced by the next one.
    for (let from = 0; ; ) {
      let opened: Opened | null;
      try {
        opened = await open(deps, route.targets, from, params, attempts);
      } catch (error) {
        if (error instanceof RequestRejected) return rejected(error);
        throw error;
      }
      if (!opened) return noUpstream();
      try {
        let text = "";
        let finishReason: "stop" | "length" = "stop";
        let reported: TokenUsage | undefined;
        const take = (part: Part) => {
          if (part.delta) text += part.delta;
          if (part.finish) finishReason = part.finish;
          if (part.usage) reported = part.usage;
        };
        take(opened.first);
        for await (const part of opened.rest) take(part);
        clearTimeout(deadline);
        const answer: Answer = { text, finish: finishReason, usage: usageOf(reported, text) };
        const trace = finish({
          status: 200,
          outcome: "ok",
          cache: cacheResult,
          target: opened.target.id,
          answer,
          firstTokenMs: opened.firstTokenAt - arrivedAt,
          overheadMs,
          admitMs,
          cacheMs,
          keep: keepable(opened.target.id, answer),
        });
        return json(completionBody(id, parsed.model, answer, trace), 200, baseHeaders(cacheResult, opened.target.id));
      } catch (error) {
        opened.cancel();
        markBroken(attempts, opened, toProviderError(error), Date.now());
        if (overall.signal.aborted) return noUpstream();
        from = opened.index + 1;
      }
    }
  }

  // Streaming: fall back only until the first token. After that the caller has seen part of
  // one upstream's answer, and splicing in another's would be worse than stopping.
  let opened: Opened | null;
  try {
    opened = await open(deps, route.targets, 0, params, attempts);
  } catch (error) {
    if (error instanceof RequestRejected) return rejected(error);
    throw error;
  }
  if (!opened) return noUpstream();
  const upstream = opened;

  return sse(baseHeaders(cacheResult, upstream.target.id), async (send) => {
    let text = "";
    let finishReason: "stop" | "length" = "stop";
    let reported: TokenUsage | undefined;
    const take = (part: Part) => {
      if (part.finish) finishReason = part.finish;
      if (part.usage) reported = part.usage;
      if (part.delta) {
        text += part.delta;
        send(chunk(id, parsed.model, { content: part.delta }));
      }
    };
    const done = (outcome: Outcome, complete: boolean): Trace => {
      clearTimeout(deadline);
      const answer: Answer = { text, finish: finishReason, usage: usageOf(reported, text) };
      return finish({
        status: 200,
        outcome,
        cache: cacheResult,
        target: upstream.target.id,
        answer,
        firstTokenMs: upstream.firstTokenAt - arrivedAt,
        overheadMs,
        admitMs,
        cacheMs,
        keep: complete ? keepable(upstream.target.id, answer) : undefined,
      });
    };
    try {
      send(chunk(id, parsed.model, { role: "assistant", content: "" }));
      take(upstream.first);
      for await (const part of upstream.rest) take(part);
      send(chunk(id, parsed.model, {}, finishReason));
      const trace = done("ok", true);
      if (wantsSummary) send(summaryChunk(id, parsed.model, usageOf(reported, text), trace));
    } catch (error) {
      upstream.cancel();
      markBroken(attempts, upstream, toProviderError(error), Date.now());
      done(clientGone ? "client_closed" : "stream_broken", false);
      if (!clientGone) {
        send({ error: { message: "The upstream stopped before finishing its answer.", type: "upstream_error", code: "stream_broken" } });
        // No [DONE]: the caller must be able to tell a cut-off answer from a finished one.
        throw error;
      }
    }
  }, () => ((clientGone = true), overall.abort()));
}

// ── Response shapes ─────────────────────────────────────────────────────────

function summary(trace: Trace) {
  return {
    request_id: trace.id,
    cache: trace.cache,
    similarity: trace.similarity,
    judged: trace.judged,
    provider: trace.provider,
    model: trace.modelUsed,
    attempts: trace.attempts,
    cost_micros: trace.costMicros,
    saved_micros: trace.savedMicros,
    latency_ms: trace.latencyMs,
    first_token_ms: trace.firstTokenMs,
    overhead_ms: trace.overheadMs,
    admit_ms: trace.admitMs,
    cache_ms: trace.cacheMs,
  };
}

const usageBody = (usage: TokenUsage) => ({
  prompt_tokens: usage.promptTokens,
  completion_tokens: usage.completionTokens,
  total_tokens: usage.promptTokens + usage.completionTokens,
});

function completionBody(id: string, model: string, answer: Answer, trace: Trace) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(trace.ts / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: answer.text }, finish_reason: answer.finish }],
    usage: usageBody(answer.usage),
    tollgate: summary(trace),
  };
}

function chunk(id: string, model: string, delta: { role?: "assistant"; content?: string }, finishReason: "stop" | "length" | null = null) {
  return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

/** The last chunk of a stream when the caller asked for usage: token counts, and what the gateway did. */
function summaryChunk(id: string, model: string, usage: TokenUsage, trace: Trace) {
  return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: usageBody(usage), tollgate: summary(trace) };
}

/**
 * A server-sent event response. `write` produces the events; when it returns, the stream is
 * closed with [DONE]; when it throws, the stream ends without it.
 */
function sse(headers: Record<string, string>, write: (send: (event: unknown) => void) => Promise<void>, onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        await write(send);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        // Either `write` has already told the caller what went wrong, or the caller has gone.
        try {
          controller.close();
        } catch {
          // Already closed by the caller.
        }
      }
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...CORS, ...headers },
  });
}
