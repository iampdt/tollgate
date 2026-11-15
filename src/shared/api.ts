// Shapes shared by the Worker and the dashboard.

export type CacheMode = "off" | "exact" | "semantic";
/** What the cache did for one request. */
export type CacheResult = "off" | "miss" | "exact" | "semantic";

export type FailureKind = "timeout" | "rate_limited" | "server" | "network" | "auth" | "bad_request" | "aborted";

/** One upstream the router considered for a request. */
export interface Attempt {
  target: string;
  outcome: "ok" | "skipped_open" | FailureKind;
  ms: number;
  status?: number;
  message?: string;
}

export type Outcome =
  | "ok"
  | "cached"
  | "rate_limited"
  | "budget_exhausted"
  | "bad_request"
  | "upstream_failed"
  | "stream_broken"
  | "client_closed";

export interface Trace {
  id: string;
  ts: number;
  modelRequested: string;
  provider: string | null;
  modelUsed: string | null;
  status: number;
  outcome: Outcome;
  cache: CacheResult;
  /** Semantic cache: how similar the nearest stored prompt was, whether or not it was used. */
  similarity: number | null;
  /** Semantic cache: what the judge said about that prompt, if it was asked. */
  judged: "accepted" | "rejected" | "timeout" | null;
  stream: boolean;
  attempts: Attempt[];
  promptTokens: number;
  completionTokens: number;
  /** List price of what was generated, in millionths of a US dollar. */
  costMicros: number;
  /** List price of what a cache hit did not have to generate. */
  savedMicros: number;
  latencyMs: number;
  firstTokenMs: number | null;
  /** Time spent inside the gateway rather than waiting for an upstream. */
  overheadMs: number | null;
  /** Of that: waiting for the rate limit and budget check. */
  admitMs: number | null;
  /** Of that: looking in the cache (for the semantic cache, this includes embedding the prompt). */
  cacheMs: number | null;
}

export interface Stats {
  windowHours: number;
  requests: number;
  served: number;
  cacheExact: number;
  cacheSemantic: number;
  rateLimited: number;
  failed: number;
  fellBack: number;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  savedMicros: number;
  latency: { upstreamP50: number | null; upstreamP95: number | null; cachedP50: number | null; cachedP95: number | null; overheadP50: number | null; overheadP95: number | null };
  byProvider: { provider: string; requests: number; failures: number }[];
  hourly: { hour: number; upstream: number; cached: number; rejected: number; failed: number }[];
}

export type BreakerState = "closed" | "open" | "half_open";

export interface Health {
  routes: { name: string; description: string; targets: { target: string; configured: boolean; state: BreakerState }[] }[];
  providers: { id: string; configured: boolean; needs: string | null }[];
  semanticCache: { embedder: string; index: string; judge: string | null };
}

export interface Usage {
  keyName: string;
  requestsPerMinute: number;
  tokensPerDay: number;
  tokensUsedToday: number;
  requestsToday: number;
  cacheMode: CacheMode;
}

export interface ApiError {
  error: { message: string; type: string; code: string };
}

/** The key anyone may use. It is public on purpose: limited per visitor and capped in total. */
export const DEMO_KEY = "tg_demo_public";
