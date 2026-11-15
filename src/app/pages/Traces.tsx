import { useEffect, useState } from "react";
import type { Trace } from "../../shared/api";
import { clock, dollars, get, ms } from "../lib/api";
import { Attempts, Empty, ErrorNote, OutcomeBadge } from "../ui";

const CACHE: Record<Trace["cache"], string> = { off: "–", miss: "miss", exact: "exact hit", semantic: "semantic hit" };

export function Traces() {
  const [traces, setTraces] = useState<Trace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      get<{ traces: Trace[] }>("/api/traces?limit=60")
        .then((body) => !stopped && (setTraces(body.traces), setError(null)))
        .catch((failure: Error) => !stopped && setError(failure.message));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-pretty text-muted">
        The last 60 requests on this key, newest first, refreshed every five seconds. A trace records what happened to a request and never what was said in it: no prompt or answer text is stored here.
      </p>
      <ErrorNote error={error} />
      {traces && traces.length === 0 && <Empty>No requests yet. Send one from the playground.</Empty>}
      {traces && traces.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[46rem] text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                {["Time", "Asked for", "Answered by", "Outcome", "Cache", "Tokens", "List price", "Latency"].map((heading, i) => (
                  <th key={heading} scope="col" className={`px-3 py-2.5 font-medium ${i >= 5 ? "text-right" : ""}`}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {traces.map((trace) => (
                <TraceRow key={trace.id} trace={trace} open={open === trace.id} onToggle={() => setOpen(open === trace.id ? null : trace.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TraceRow({ trace, open, onToggle }: { trace: Trace; open: boolean; onToggle: () => void }) {
  const fallbacks = trace.attempts.filter((a) => a.outcome !== "ok").length;
  return (
    <>
      <tr className="border-b border-line last:border-0 hover:bg-accent-soft">
        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
          <button type="button" className="underline decoration-line underline-offset-4 hover:decoration-ink" aria-expanded={open} onClick={onToggle}>
            {clock(trace.ts)}
          </button>
        </td>
        <td className="px-3 py-2 font-mono text-xs">{trace.modelRequested}</td>
        <td className="max-w-56 truncate px-3 py-2 font-mono text-xs" title={trace.modelUsed ?? undefined}>
          {trace.modelUsed ? `${trace.provider}: ${trace.modelUsed.split("/").at(-1)}` : "–"}
          {trace.outcome === "ok" && fallbacks > 0 && <span className="ml-2 font-sans text-muted">after {fallbacks} fallback{fallbacks > 1 ? "s" : ""}</span>}
        </td>
        <td className="px-3 py-2">
          <OutcomeBadge outcome={trace.outcome} />
        </td>
        <td className="px-3 py-2 text-xs whitespace-nowrap text-muted">{CACHE[trace.cache]}</td>
        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{trace.promptTokens + trace.completionTokens || "–"}</td>
        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{trace.outcome === "cached" ? `saved ${dollars(trace.savedMicros)}` : dollars(trace.costMicros)}</td>
        <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{ms(trace.latencyMs)}</td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-canvas last:border-0">
          <td colSpan={8} className="px-3 py-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-xs text-muted">Upstreams, in the order tried</p>
                <Attempts attempts={trace.attempts} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 self-start font-mono text-xs">
                <dt className="font-sans text-muted">Rate limit check</dt>
                <dd className="text-right">{ms(trace.admitMs)}</dd>
                <dt className="font-sans text-muted">Cache lookup</dt>
                <dd className="text-right">{ms(trace.cacheMs)}</dd>
                <dt className="font-sans text-muted">First token</dt>
                <dd className="text-right">{ms(trace.firstTokenMs)}</dd>
                {trace.similarity !== null && (
                  <>
                    <dt className="font-sans text-muted">Nearest earlier prompt</dt>
                    <dd className="text-right">
                      {(trace.similarity * 100).toFixed(1)}%{trace.judged ? `, judge: ${trace.judged}` : ""}
                    </dd>
                  </>
                )}
                <dt className="font-sans text-muted">Streamed</dt>
                <dd className="text-right">{trace.stream ? "yes" : "no"}</dd>
                <dt className="font-sans text-muted">Request</dt>
                <dd className="truncate text-right" title={trace.id}>
                  {trace.id.slice(9, 22)}…
                </dd>
              </dl>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
