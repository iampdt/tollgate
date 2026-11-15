// The record of every request, and the numbers the dashboard draws from it.

import type { Attempt, Stats, Trace } from "../shared/api";
import type { AppEnv } from "./env";

interface Row {
  id: string;
  ts: number;
  model_requested: string;
  provider: string | null;
  model_used: string | null;
  status: number;
  outcome: Trace["outcome"];
  cache: Trace["cache"];
  similarity: number | null;
  judged: Trace["judged"];
  stream: number;
  attempts: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_micros: number;
  saved_micros: number;
  latency_ms: number;
  first_token_ms: number | null;
  overhead_ms: number | null;
  admit_ms: number | null;
  cache_ms: number | null;
}

const COLUMNS =
  "id, ts, model_requested, provider, model_used, status, outcome, cache, similarity, judged, stream, attempts, prompt_tokens, completion_tokens, cost_micros, saved_micros, latency_ms, first_token_ms, overhead_ms, admit_ms, cache_ms";

function toTrace(row: Row): Trace {
  return {
    id: row.id,
    ts: row.ts,
    modelRequested: row.model_requested,
    provider: row.provider,
    modelUsed: row.model_used,
    status: row.status,
    outcome: row.outcome,
    cache: row.cache,
    similarity: row.similarity,
    judged: row.judged,
    stream: row.stream === 1,
    attempts: JSON.parse(row.attempts) as Attempt[],
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    costMicros: row.cost_micros,
    savedMicros: row.saved_micros,
    latencyMs: row.latency_ms,
    firstTokenMs: row.first_token_ms,
    overheadMs: row.overhead_ms,
    admitMs: row.admit_ms,
    cacheMs: row.cache_ms,
  };
}

export async function record(env: AppEnv, keyId: string, trace: Trace): Promise<void> {
  const fallbacks = trace.attempts.filter((a) => a.outcome !== "ok").length;
  await env.DB.prepare(
    `INSERT INTO traces (${COLUMNS}, key_id, fallbacks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      trace.id,
      trace.ts,
      trace.modelRequested,
      trace.provider,
      trace.modelUsed,
      trace.status,
      trace.outcome,
      trace.cache,
      trace.similarity,
      trace.judged,
      trace.stream ? 1 : 0,
      JSON.stringify(trace.attempts),
      trace.promptTokens,
      trace.completionTokens,
      trace.costMicros,
      trace.savedMicros,
      trace.latencyMs,
      trace.firstTokenMs,
      trace.overheadMs,
      trace.admitMs,
      trace.cacheMs,
      keyId,
      trace.outcome === "ok" ? fallbacks : 0,
    )
    .run();
}

export async function recent(env: AppEnv, keyId: string, limit: number): Promise<Trace[]> {
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM traces WHERE key_id = ? ORDER BY ts DESC LIMIT ?`).bind(keyId, limit).all<Row>();
  return results.map(toTrace);
}

export async function one(env: AppEnv, keyId: string, id: string): Promise<Trace | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM traces WHERE key_id = ? AND id = ?`).bind(keyId, id).first<Row>();
  return row ? toTrace(row) : null;
}

const HOUR = 3_600_000;

// Everything is aggregated in SQL: a Worker on the free plan has 10 ms of CPU per request,
// which is not enough to sort thousands of rows in JavaScript.
export async function stats(env: AppEnv, keyId: string, windowHours: number, now: number): Promise<Stats> {
  const since = now - windowHours * HOUR;
  const where = "key_id = ?1 AND ts >= ?2";
  const percentile = (column: string, filter: string, p: number) =>
    env.DB.prepare(
      `SELECT ${column} AS v FROM traces WHERE ${where} AND ${filter} AND ${column} IS NOT NULL ORDER BY ${column}
       LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * ${p} AS INTEGER) - (COUNT(*) * ${p} = CAST(COUNT(*) * ${p} AS INTEGER)))
                       FROM traces WHERE ${where} AND ${filter} AND ${column} IS NOT NULL)`,
    ).bind(keyId, since);
  const upstream = "outcome = 'ok'";
  const cached = "outcome = 'cached'";

  const [totals, providers, hourly, ...percentiles] = await env.DB.batch<Record<string, number | string | null>>([
    env.DB.prepare(
      `SELECT COUNT(*) AS requests,
              SUM(outcome IN ('ok', 'cached')) AS served,
              SUM(cache = 'exact') AS cache_exact,
              SUM(cache = 'semantic') AS cache_semantic,
              SUM(outcome IN ('rate_limited', 'budget_exhausted')) AS rate_limited,
              SUM(outcome IN ('upstream_failed', 'stream_broken')) AS failed,
              SUM(fallbacks > 0) AS fell_back,
              SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens,
              SUM(cost_micros) AS cost_micros,
              SUM(saved_micros) AS saved_micros
       FROM traces WHERE ${where}`,
    ).bind(keyId, since),
    env.DB.prepare(
      `SELECT value ->> 'target' AS target, COUNT(*) AS requests, SUM(value ->> 'outcome' NOT IN ('ok', 'skipped_open')) AS failures
       FROM traces, json_each(traces.attempts) WHERE ${where} AND value ->> 'outcome' != 'skipped_open'
       GROUP BY target ORDER BY requests DESC LIMIT 12`,
    ).bind(keyId, since),
    env.DB.prepare(
      `SELECT ts / ${HOUR} AS hour,
              SUM(outcome = 'ok') AS upstream,
              SUM(outcome = 'cached') AS cached,
              SUM(outcome IN ('rate_limited', 'budget_exhausted')) AS rejected,
              SUM(outcome IN ('upstream_failed', 'stream_broken', 'bad_request', 'client_closed')) AS failed
       FROM traces WHERE ${where} GROUP BY hour ORDER BY hour`,
    ).bind(keyId, since),
    percentile("latency_ms", upstream, 0.5),
    percentile("latency_ms", upstream, 0.95),
    percentile("latency_ms", cached, 0.5),
    percentile("latency_ms", cached, 0.95),
    percentile("overhead_ms", upstream, 0.5),
    percentile("overhead_ms", upstream, 0.95),
  ]);

  const total = totals?.results[0] ?? {};
  const number = (value: unknown) => Number(value ?? 0);
  const p = (index: number) => {
    const value = percentiles[index]?.results[0]?.v;
    return value === undefined || value === null ? null : Number(value);
  };
  return {
    windowHours,
    requests: number(total.requests),
    served: number(total.served),
    cacheExact: number(total.cache_exact),
    cacheSemantic: number(total.cache_semantic),
    rateLimited: number(total.rate_limited),
    failed: number(total.failed),
    fellBack: number(total.fell_back),
    promptTokens: number(total.prompt_tokens),
    completionTokens: number(total.completion_tokens),
    costMicros: number(total.cost_micros),
    savedMicros: number(total.saved_micros),
    latency: { upstreamP50: p(0), upstreamP95: p(1), cachedP50: p(2), cachedP95: p(3), overheadP50: p(4), overheadP95: p(5) },
    byProvider: (providers?.results ?? []).map((row) => ({ provider: String(row.target), requests: number(row.requests), failures: number(row.failures) })),
    hourly: (hourly?.results ?? []).map((row) => ({
      hour: number(row.hour) * HOUR,
      upstream: number(row.upstream),
      cached: number(row.cached),
      rejected: number(row.rejected),
      failed: number(row.failed),
    })),
  };
}

export const TRACE_RETENTION_DAYS = 7;

export async function prune(env: AppEnv, now: number): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM traces WHERE ts < ?").bind(now - TRACE_RETENTION_DAYS * 24 * HOUR).run();
  return result.meta.changes;
}
