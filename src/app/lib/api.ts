import { type Attempt, type CacheMode, DEMO_KEY, type Trace } from "../../shared/api";

const STORED = "tollgate-key";

export function currentKey(): string {
  try {
    return sessionStorage.getItem(STORED) || DEMO_KEY;
  } catch {
    return DEMO_KEY;
  }
}

export function setKey(key: string): void {
  try {
    if (key && key !== DEMO_KEY) sessionStorage.setItem(STORED, key);
    else sessionStorage.removeItem(STORED);
  } catch {
    // Private windows may refuse storage; the key then lasts until reload.
  }
}

export async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${currentKey()}` } });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** What the gateway reports about one request, as sent in the response. */
export interface Summary {
  request_id: string;
  cache: Trace["cache"];
  similarity: number | null;
  judged: Trace["judged"];
  provider: string | null;
  model: string | null;
  attempts: Attempt[];
  cost_micros: number;
  saved_micros: number;
  latency_ms: number;
  first_token_ms: number | null;
  overhead_ms: number | null;
  admit_ms: number | null;
  cache_ms: number | null;
}

export interface ChatResult {
  status: number;
  text: string;
  summary: Summary | null;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  error: { code: string; message: string; attempts?: Attempt[] } | null;
  retryAfter: string | null;
  /** Wall-clock time in the browser, network included. */
  elapsedMs: number;
}

export interface ChatInput {
  model: string;
  prompt: string;
  cache: CacheMode;
  stream: boolean;
  maxTokens?: number;
  ttlSeconds?: number;
}

interface Chunk {
  choices?: { delta?: { content?: string }; message?: { content?: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  tollgate?: Summary;
  error?: { code: string; message: string; attempts?: Attempt[] };
}

export async function chat(input: ChatInput, onText?: (text: string) => void): Promise<ChatResult> {
  const started = performance.now();
  const response = await fetch("/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${currentKey()}`,
      "Content-Type": "application/json",
      "X-Tollgate-Cache": input.cache,
      ...(input.ttlSeconds && { "X-Tollgate-Cache-Ttl": String(input.ttlSeconds) }),
    },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: input.maxTokens ?? 200,
      stream: input.stream,
      ...(input.stream && { stream_options: { include_usage: true } }),
    }),
  });
  const result: ChatResult = { status: response.status, text: "", summary: null, usage: null, error: null, retryAfter: response.headers.get("Retry-After"), elapsedMs: 0 };
  const take = (chunk: Chunk) => {
    const piece = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content;
    if (piece) {
      result.text += piece;
      onText?.(result.text);
    }
    if (chunk.usage) result.usage = chunk.usage;
    if (chunk.tollgate) result.summary = chunk.tollgate;
    if (chunk.error) result.error = chunk.error;
  };

  if (response.headers.get("Content-Type")?.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const data = buffer.slice(0, end).replace(/^data:\s*/, "");
        buffer = buffer.slice(end + 2);
        if (data && data !== "[DONE]") take(JSON.parse(data) as Chunk);
      }
    }
  } else if (response.status !== 499) {
    take((await response.json()) as Chunk);
  }
  result.elapsedMs = Math.round(performance.now() - started);
  return result;
}

// ── Formatting ──

/** Millionths of a dollar, written so that fractions of a cent stay visible. */
export function dollars(micros: number): string {
  if (micros === 0) return "$0";
  const value = micros / 1_000_000;
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(6).replace(/0+$/, "")}`;
}

export function compact(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US");
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

export function percent(part: number, whole: number): string {
  return whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
