import { env as rawEnv, exports } from "cloudflare:workers";
import { DEMO_KEY, type Trace } from "../src/shared/api";
import type { AppEnv } from "../src/worker/env";

export const env = rawEnv as unknown as AppEnv;
// Whatever admin token the Worker under test was started with (a local .dev.vars overrides the test config).
export const ADMIN = env.ADMIN_TOKEN ?? "";
const BASE = "https://tollgate.test";

type Fetcher = { fetch(request: Request): Promise<Response> };

let address = 0;
/** A fresh client address per call, so the demo key's per-visitor limit doesn't couple tests. */
export function newAddress(): string {
  address += 1;
  return `10.1.${Math.floor(address / 250)}.${address % 250}`;
}

export function call(path: string, init: RequestInit & { key?: string | null; address?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", init.address ?? newAddress());
  if (init.key !== null) headers.set("Authorization", `Bearer ${init.key ?? DEMO_KEY}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(BASE + path, { ...init, headers }));
}

export interface ChatOptions {
  key?: string | null;
  address?: string;
  headers?: Record<string, string>;
  stream?: boolean;
  extra?: Record<string, unknown>;
}

export function chat(model: string, prompt: string | { role: string; content: string }[], options: ChatOptions = {}): Promise<Response> {
  const messages = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
  return call("/v1/chat/completions", {
    method: "POST",
    key: options.key,
    address: options.address,
    headers: options.headers,
    body: JSON.stringify({ model, messages, stream: options.stream, ...options.extra }),
  });
}

export interface Completion {
  id: string;
  choices: { message: { content: string }; finish_reason: string }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  tollgate: { cache: string; provider: string; model: string; attempts: { target: string; outcome: string }[]; similarity: number | null };
  error?: { code: string; message: string; attempts?: { target: string; outcome: string }[] };
}

export async function completion(response: Response): Promise<Completion> {
  return (await response.json()) as Completion;
}

/** Reads a streamed response into its events, noting whether it ended with [DONE]. */
export async function events(response: Response): Promise<{ text: string; done: boolean; events: Record<string, unknown>[] }> {
  const raw = await response.text();
  const payloads = raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data:"))
    .map((block) => block.slice(5).trim());
  const parsed = payloads.filter((p) => p !== "[DONE]").map((p) => JSON.parse(p) as Record<string, unknown>);
  const text = parsed
    .map((event) => (event.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content ?? "")
    .join("");
  return { text, done: payloads.at(-1) === "[DONE]", events: parsed };
}

export async function adminCall(path: string, method = "POST", body?: unknown): Promise<Response> {
  return call(path, { method, key: ADMIN, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function newKey(overrides: Record<string, unknown> = {}): Promise<{ id: string; key: string }> {
  const response = await adminCall("/api/admin/keys", "POST", { name: "test", requestsPerMinute: 600, tokensPerDay: 1_000_000, cacheMode: "off", ...overrides });
  if (response.status !== 201) throw new Error(`key creation failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { id: string; key: string };
}

/** The trace is written after the response; wait for it to land. */
export async function traceOf(id: string, key: string): Promise<Trace> {
  for (let i = 0; i < 50; i++) {
    const response = await call(`/api/traces/${id}`, { key });
    if (response.ok) return (await response.json()) as Trace;
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no trace for ${id}`);
}

export const resetBreakers = () => adminCall("/api/admin/breakers/reset").then((r) => r.text());
