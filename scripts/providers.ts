// Sends real requests through every configured provider on a deployed gateway and reports
// what each did: latency per model, what each route's attempts looked like, and what happens
// to a route when a burst runs into a provider's own rate limit.
//
// This spends real quota (a few thousand tokens per provider). Caching is off throughout.
//
//   TOLLGATE_URL=https://… ADMIN_TOKEN=… npx tsx scripts/providers.ts

const base = process.env.TOLLGATE_URL ?? "http://localhost:5173";
const admin = process.env.ADMIN_TOKEN;
if (!admin) throw new Error("Set ADMIN_TOKEN.");

const PROMPT = "In one sentence, what is a circuit breaker in software?";
const SAMPLES = Number(process.env.SAMPLES ?? 8);
const BURST = Number(process.env.BURST ?? 24);

interface Attempt {
  target: string;
  outcome: string;
  ms: number;
  status?: number;
}
interface Reply {
  status: number;
  target: string | null;
  attempts: Attempt[];
  firstTokenMs: number | null;
  totalMs: number;
  out: number;
  text: string;
}

async function adminCall<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function ask(key: string, model: string, stream = false): Promise<Reply> {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Tollgate-Cache": "off" },
    body: JSON.stringify({ model, max_tokens: 80, stream, ...(stream && { stream_options: { include_usage: true } }), messages: [{ role: "user", content: PROMPT }] }),
  });
  type Summary = { provider: string; model: string; attempts: Attempt[]; first_token_ms: number | null; latency_ms: number };
  type Body = { tollgate?: Summary; usage?: { completion_tokens: number }; choices?: { message?: { content: string }; delta?: { content?: string } }[]; error?: { attempts?: Attempt[] } };
  let summary: Summary | undefined;
  let attempts: Attempt[] = [];
  let out = 0;
  let text = "";
  const take = (body: Body) => {
    if (body.tollgate) summary = body.tollgate;
    if (body.usage) out = body.usage.completion_tokens;
    if (body.error?.attempts) attempts = body.error.attempts;
    text += body.choices?.[0]?.message?.content ?? body.choices?.[0]?.delta?.content ?? "";
  };
  if (response.headers.get("Content-Type")?.includes("event-stream")) {
    for (const block of (await response.text()).split("\n\n")) {
      const data = block.replace(/^data:\s*/, "").trim();
      if (data && data !== "[DONE]") take(JSON.parse(data) as Body);
    }
  } else {
    take((await response.json()) as Body);
  }
  return {
    status: response.status,
    target: summary ? `${summary.provider}/${summary.model}` : null,
    attempts: summary?.attempts ?? attempts,
    firstTokenMs: summary?.first_token_ms ?? null,
    totalMs: summary?.latency_ms ?? 0,
    out,
    text,
  };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const path = (attempts: Attempt[]) => attempts.map((a) => `${a.target.replace(/^workers-ai\/@cf\/meta\//, "workers-ai/")} ${a.outcome}${a.status ? ` (${a.status})` : ""}`).join(" → ");
const short = (target: string) => target.replace("workers-ai/@cf/meta/", "workers-ai/");

const { id, key } = await adminCall<{ id: string; key: string }>("/api/admin/keys", "POST", { name: "providers-run", requestsPerMinute: 600, tokensPerDay: 2_000_000, cacheMode: "off" });
try {
  await adminCall("/api/admin/breakers/reset", "POST");
  const health = await (await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${key}` } })).json() as { providers: { id: string; configured: boolean }[] };
  console.log(`target: ${base}`);
  console.log(`providers with credentials: ${health.providers.filter((p) => p.configured && p.id !== "mock").map((p) => p.id).join(", ")}\n`);

  const models = (await (await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })).json() as { data: { id: string; kind: string }[] }).data
    .filter((m) => m.kind === "model" && !m.id.startsWith("mock/"))
    .map((m) => m.id);

  console.log(`1. Each model, ${SAMPLES} requests one after another, same prompt, 80 tokens at most`);
  console.log("   model                                              answered   first token (median)   whole answer (median)   tokens out (median)   streams");
  for (const model of models) {
    const replies: Reply[] = [];
    for (let i = 0; i < SAMPLES; i++) replies.push(await ask(key, model));
    const ok = replies.filter((r) => r.status === 200);
    const streamed = await ask(key, model, true);
    const failed = replies.find((r) => r.status !== 200);
    console.log(
      `   ${short(model).padEnd(50)} ${`${ok.length} / ${SAMPLES}`.padEnd(10)} ${ok.length ? `${median(ok.map((r) => r.firstTokenMs ?? 0))} ms`.padEnd(22) : "–".padEnd(22)} ${ok.length ? `${median(ok.map((r) => r.totalMs))} ms`.padEnd(23) : "–".padEnd(23)} ${ok.length ? String(median(ok.map((r) => r.out))).padEnd(21) : "–".padEnd(21)} ${streamed.status === 200 && streamed.text ? "yes" : "no"}${failed ? `   first failure: ${path(failed.attempts)}` : ""}`,
    );
  }

  await adminCall("/api/admin/breakers/reset", "POST");
  console.log("\n2. Each route once: the upstreams it tried, in order");
  for (const route of ["fast", "smart", "gemini", "premium"]) {
    const reply = await ask(key, route);
    console.log(`   ${route.padEnd(8)} ${reply.status}  ${path(reply.attempts)}`);
  }

  await adminCall("/api/admin/breakers/reset", "POST");
  console.log(`\n3. ${BURST} requests at once on the "gemini" route (its first upstream is a free tier with its own rate limit)`);
  const burst = await Promise.all(Array.from({ length: BURST }, () => ask(key, "gemini")));
  const answered = burst.filter((r) => r.status === 200);
  const by = new Map<string, number>();
  for (const reply of answered) by.set(reply.target ?? "?", (by.get(reply.target ?? "?") ?? 0) + 1);
  console.log(`   answered ${answered.length} / ${BURST}`);
  for (const [target, count] of [...by].sort((a, b) => b[1] - a[1])) console.log(`     ${String(count).padStart(2)} by ${short(target)}`);
  const refusals = new Map<string, number>();
  for (const reply of burst) for (const attempt of reply.attempts) if (attempt.outcome !== "ok") refusals.set(`${short(attempt.target)} ${attempt.outcome}`, (refusals.get(`${short(attempt.target)} ${attempt.outcome}`) ?? 0) + 1);
  for (const [what, count] of refusals) console.log(`     ${String(count).padStart(2)} × ${what}`);
  console.log(`   median time to a whole answer: ${median(answered.map((r) => r.totalMs))} ms`);
} finally {
  await adminCall(`/api/admin/keys/${id}`, "DELETE");
  await adminCall("/api/admin/breakers/reset", "POST");
}
export {};
