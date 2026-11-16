import { useRef, useState } from "react";
import type { CacheMode } from "../../shared/api";
import { chat, type ChatInput, type ChatResult, dollars, ms } from "../lib/api";
import { Attempts, ErrorNote, Fact, Status } from "../ui";

const ROUTES = [
  { id: "fast", label: "fast — Groq first, then Cloudflare's small models" },
  { id: "demo-outage", label: "demo-outage — first upstream is always down" },
  { id: "smart", label: "smart — Gemini, Groq, Cloudflare (your own key)" },
  { id: "premium", label: "premium — OpenAI first (your own key)" },
  { id: "mock/echo", label: "mock/echo — repeats your prompt, costs nothing" },
];

const QUESTION = "How do I undo the last commit in git?";
// A reworded question that has been asked before is an exact hit, which would hide the
// semantic cache. So the sample builds one of 180 rewordings each time.
const pick = <T,>(options: T[]): T => options[Math.floor(Math.random() * options.length)] as T;
const reworded = () =>
  `${pick(["What's", "What is", "Tell me", "Show me", "Give me"])} ${pick(["the git command", "the command in git", "the right git command"])} ${pick([
    "to undo my most recent commit",
    "to undo my latest commit",
    "for undoing the last commit I made",
    "that undoes my last commit",
  ])}${pick(["?", " please?", ", please."])}`;
const DIFFERENT = "How do I undo the last push in git?";
/** Sample questions are kept for a day, so most visitors find them already answered. */
const SAMPLE_TTL = 86_400;

interface Scenario {
  title: string;
  about: string;
  input: () => ChatInput;
}

const SCENARIOS: Scenario[] = [
  {
    title: "1. Ask a question",
    about: "A real model answers, usually on Groq, with Cloudflare's behind it. If someone asked this today it is already cached; either way, ask it twice and the second answer comes back in tens of milliseconds.",
    input: () => ({ model: "fast", prompt: QUESTION, cache: "semantic", stream: true, ttlSeconds: SAMPLE_TTL }),
  },
  {
    title: "2. Reword it",
    about: "Different words, same question (a new rewording each time you press it). The semantic cache finds the earlier answer by meaning, then a second model confirms the two questions really are the same before it is served. A new answer becomes findable about a minute after it is first stored, so if the first sample was a miss just now, give it a minute.",
    input: () => ({ model: "fast", prompt: reworded(), cache: "semantic", stream: true, ttlSeconds: SAMPLE_TTL }),
  },
  {
    title: "3. Ask something that only looks the same",
    about: "\"Commit\" became \"push\": nearly identical by embedding, and a different answer. The judge turns the cached answer down, so a model is asked.",
    input: () => ({ model: "fast", prompt: DIFFERENT, cache: "semantic", stream: true, ttlSeconds: SAMPLE_TTL }),
  },
  {
    title: "4. Break the first provider",
    about: "This route's first upstream always fails. The gateway moves to the next one, at a different company; press it six times and it stops calling the broken one at all for 30 seconds.",
    input: () => ({ model: "demo-outage", prompt: "Say hello in exactly five words.", cache: "off", stream: true }),
  },
];

const CACHE_LABEL: Record<string, string> = { off: "Not used", miss: "Miss", exact: "Exact hit", semantic: "Semantic hit" };

export function Playground() {
  const [input, setInput] = useState<ChatInput>({ model: "fast", prompt: QUESTION, cache: "semantic", stream: true });
  const [about, setAbout] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<ChatResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [burst, setBurst] = useState<{ admitted: number; refused: number; ms: number } | null>(null);
  const run = useRef(0);

  async function send(next: ChatInput = input) {
    const mine = ++run.current;
    setBusy(true);
    setError(null);
    setBurst(null);
    setText("");
    setResult(null);
    try {
      const done = await chat(next, (soFar) => mine === run.current && setText(soFar));
      if (mine !== run.current) return;
      setResult(done);
      setText(done.text);
    } catch (failure) {
      if (mine === run.current) setError(failure instanceof Error ? failure.message : "The request failed.");
    } finally {
      if (mine === run.current) setBusy(false);
    }
  }

  async function sendBurst() {
    ++run.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setText("");
    setAbout("Thirty requests at the same moment. The demo key allows each visitor 20 per minute, and the limit is exact: it is kept by one small stateful object per key, which handles requests one at a time.");
    const started = performance.now();
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => chat({ model: "mock/echo", prompt: `burst ${i} ${started}`, cache: "off", stream: false })),
      );
      setBurst({
        admitted: results.filter((r) => r.status === 200).length,
        refused: results.filter((r) => r.status === 429).length,
        ms: Math.round(performance.now() - started),
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The burst failed.");
    } finally {
      setBusy(false);
    }
  }

  const summary = result?.summary;
  const cache = summary?.cache;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="min-w-0 space-y-6">
        <section aria-labelledby="try-title">
          <h2 id="try-title" className="kicker">
            Try these in order
          </h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {SCENARIOS.map((scenario) => (
              <button
                key={scenario.title}
                type="button"
                disabled={busy}
                className="btn-secondary justify-start text-left"
                onClick={() => {
                  const next = scenario.input();
                  setInput(next);
                  setAbout(scenario.about);
                  void send(next);
                }}
              >
                {scenario.title}
              </button>
            ))}
            <button type="button" disabled={busy} className="btn-secondary justify-start text-left sm:col-span-2" onClick={() => void sendBurst()}>
              5. Send 30 requests at once
            </button>
          </div>
          {about && <p className="mt-3 text-sm text-pretty text-muted">{about}</p>}
        </section>

        <form
          className="card space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            setAbout(null);
            void send();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1.5 block text-muted">Model or route</span>
              <select className="input" value={input.model} onChange={(event) => setInput({ ...input, model: event.target.value })}>
                {ROUTES.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.label}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="text-sm">
              <legend className="mb-1.5 text-muted">Cache</legend>
              <div className="flex gap-1 rounded-lg border border-line p-1">
                {(["off", "exact", "semantic"] as CacheMode[]).map((mode) => (
                  <label key={mode} className="flex-1 cursor-pointer rounded-md px-2 py-1 text-center has-checked:bg-ink has-checked:text-canvas">
                    <input type="radio" name="cache" className="sr-only" checked={input.cache === mode} onChange={() => setInput({ ...input, cache: mode })} />
                    {mode}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <label className="block text-sm">
            <span className="mb-1.5 block text-muted">Prompt</span>
            <textarea className="input min-h-24 resize-y" maxLength={4000} value={input.prompt} onChange={(event) => setInput({ ...input, prompt: event.target.value })} />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={input.stream} onChange={(event) => setInput({ ...input, stream: event.target.checked })} />
              Stream the answer
            </label>
            <button type="submit" className="btn-primary" disabled={busy || !input.prompt.trim()}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </form>

        <ErrorNote error={error} />

        {burst && (
          <section className="card p-4" aria-live="polite">
            <h2 className="kicker">Result</h2>
            <p className="mt-2 text-lg">
              <span className="font-semibold tabular-nums">{burst.admitted}</span> answered, <span className="font-semibold tabular-nums">{burst.refused}</span> refused with
              "429 Too Many Requests", in {ms(burst.ms)}.
            </p>
            <p className="mt-1 text-sm text-muted">Run it again within a minute and fewer get through: the allowance refills at 20 per minute.</p>
          </section>
        )}

        {(text || result) && !burst && (
          <section className="card p-4" aria-live="polite">
            <h2 className="kicker">Answer</h2>
            {result?.error ? (
              <p className="mt-2 text-sm">
                <span className="font-mono text-xs">{result.status}</span> {result.error.message}
                {result.retryAfter && <span className="text-muted"> Retry after {result.retryAfter} s.</span>}
              </p>
            ) : (
              <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
            )}
          </section>
        )}
      </div>

      <aside className="min-w-0 space-y-4" aria-label="What the gateway did">
        <h2 className="kicker">What the gateway did</h2>
        {!summary && !result?.error && <p className="card p-4 text-sm text-muted">Send a request and its path through the gateway appears here: which upstreams were tried, what the cache did, what it cost.</p>}
        {result?.error?.attempts && (
          <div className="card p-4">
            <Attempts attempts={result.error.attempts} />
          </div>
        )}
        {summary && (
          <>
            <div className="card p-4">
              <p className="mb-3 text-sm text-muted">Upstreams, in the order tried</p>
              {cache === "exact" || cache === "semantic" ? (
                <p className="text-sm">
                  None. Answered from the cache; the stored answer came from <code className="font-mono text-xs break-all">{summary.model}</code>.
                </p>
              ) : (
                <Attempts attempts={summary.attempts} />
              )}
            </div>
            <dl className="card px-4 py-2">
              <Fact label="Cache">
                <Status tone={cache === "exact" || cache === "semantic" ? "accent" : "neutral"}>{CACHE_LABEL[cache ?? "off"]}</Status>
              </Fact>
              {summary.similarity !== null && (
                <Fact label="Nearest earlier prompt">
                  {(summary.similarity * 100).toFixed(1)}% similar
                  {summary.judged && `, judge ${{ accepted: "accepted it", rejected: "turned it down", timeout: "gave no verdict in time" }[summary.judged]}`}
                </Fact>
              )}
              <Fact label="Tokens (prompt + answer)">{result.usage ? `${result.usage.prompt_tokens} + ${result.usage.completion_tokens}` : "–"}</Fact>
              <Fact label={cache === "exact" || cache === "semantic" ? "List price saved" : "List price"}>
                {dollars(cache === "exact" || cache === "semantic" ? summary.saved_micros : summary.cost_micros)}
              </Fact>
            </dl>
            <dl className="card px-4 py-2">
              <Fact label="Rate limit and budget check">{ms(summary.admit_ms)}</Fact>
              <Fact label="Cache lookup">{ms(summary.cache_ms)}</Fact>
              {summary.first_token_ms !== null && <Fact label="First token, from arrival">{ms(summary.first_token_ms)}</Fact>}
              <Fact label="Total inside the gateway">{ms(summary.latency_ms)}</Fact>
              <Fact label="Total seen by this browser">{ms(result.elapsedMs)}</Fact>
            </dl>
            <p className="text-xs text-faint">The first two run at the same time. Prices are the provider's list price for the paid plan; this demo runs on the free allocation.</p>
          </>
        )}
      </aside>
    </div>
  );
}
