// Two measurements against a deployed gateway, using the mock upstream so that no model
// quota is spent and the numbers are the gateway's own.
//
//   1. Latency: N requests at a fixed concurrency on one key. Reports what the client saw and
//      what the gateway measured for itself before calling the upstream.
//   2. Rate limit: a key limited to L requests per minute receives B requests at once. Exactly
//      L must be answered.
//
//   TOLLGATE_URL=https://… ADMIN_TOKEN=… npm run loadtest

const base = process.env.TOLLGATE_URL ?? "http://localhost:5173";
const admin = process.env.ADMIN_TOKEN;
if (!admin) throw new Error("Set ADMIN_TOKEN.");

const REQUESTS = Number(process.env.REQUESTS ?? 400);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const LIMIT = 50;
const BURST = 200;

async function adminCall<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

interface Result {
  status: number;
  clientMs: number;
  overheadMs: number | null;
  admitMs: number | null;
}

async function ask(key: string, prompt: string, cache: string): Promise<Result> {
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Tollgate-Cache": cache },
    body: JSON.stringify({ model: "mock/echo", messages: [{ role: "user", content: prompt }] }),
  });
  const body = (await response.json()) as { tollgate?: { overhead_ms: number | null; admit_ms: number | null } };
  return { status: response.status, clientMs: performance.now() - started, overheadMs: body.tollgate?.overhead_ms ?? null, admitMs: body.tollgate?.admit_ms ?? null };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0);
}

const line = (label: string, values: number[]) =>
  console.log(`  ${label.padEnd(34)} p50 ${String(percentile(values, 0.5)).padStart(4)} ms   p95 ${String(percentile(values, 0.95)).padStart(4)} ms   p99 ${String(percentile(values, 0.99)).padStart(4)} ms`);

async function latency(cache: "off" | "exact", label: string, repeatPrompt: boolean): Promise<void> {
  const { id, key } = await adminCall<{ id: string; key: string }>("/api/admin/keys", "POST", {
    name: `loadtest-${cache}`,
    requestsPerMinute: 6000,
    tokensPerDay: 100_000_000,
    cacheMode: cache,
  });
  try {
    const run = crypto.randomUUID();
    if (repeatPrompt) {
      await ask(key, `warm ${run}`, cache);
      await new Promise((resolve) => setTimeout(resolve, 1500)); // the answer is stored after the response
    }
    const results: Result[] = [];
    let next = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < REQUESTS) {
          const n = next++;
          results.push(await ask(key, repeatPrompt ? `warm ${run}` : `request ${n} of ${run}`, cache));
        }
      }),
    );
    const seconds = (performance.now() - started) / 1000;
    const ok = results.filter((r) => r.status === 200);
    console.log(`\n${label}: ${REQUESTS} requests, ${CONCURRENCY} at a time, ${ok.length} answered, ${(REQUESTS / seconds).toFixed(0)} requests/s`);
    line("seen by the client", ok.map((r) => r.clientMs));
    line("inside the gateway", ok.flatMap((r) => (r.overheadMs === null ? [] : [r.overheadMs])));
    line("of which: rate limit and budget", ok.flatMap((r) => (r.admitMs === null ? [] : [r.admitMs])));
  } finally {
    await adminCall(`/api/admin/keys/${id}`, "DELETE");
  }
}

async function rateLimit(): Promise<void> {
  const { id, key } = await adminCall<{ id: string; key: string }>("/api/admin/keys", "POST", {
    name: "loadtest-limit",
    requestsPerMinute: LIMIT,
    tokensPerDay: 100_000_000,
    cacheMode: "off",
  });
  try {
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: BURST }, (_, i) => ask(key, `burst ${i}`, "off")));
    const seconds = (performance.now() - started) / 1000;
    const answered = results.filter((r) => r.status === 200).length;
    const refused = results.filter((r) => r.status === 429).length;
    // The allowance refills while the burst is in flight: LIMIT per minute.
    const refilled = Math.floor((seconds * LIMIT) / 60);
    console.log(`\nRate limit: ${BURST} requests at once on a key limited to ${LIMIT} per minute (burst took ${seconds.toFixed(1)} s)`);
    console.log(`  answered ${answered}, refused with 429 ${refused}, other ${BURST - answered - refused}`);
    console.log(`  allowed: ${LIMIT} plus at most ${refilled} refilled during the burst → ${answered >= LIMIT && answered <= LIMIT + refilled ? "within the limit" : "LIMIT BROKEN"}`);
  } finally {
    await adminCall(`/api/admin/keys/${id}`, "DELETE");
  }
}

console.log(`target: ${base}`);
await latency("off", "No cache", false);
await latency("exact", "Exact cache, every request a miss", false);
await latency("exact", "Exact cache, every request a hit", true);
await rateLimit();
export {};
