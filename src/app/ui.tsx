import type { ReactNode } from "react";
import type { Attempt, Trace } from "../shared/api";
import { ms } from "./lib/api";

type Tone = "good" | "warning" | "critical" | "neutral" | "accent";

const DOT: Record<Tone, string> = {
  good: "bg-good",
  warning: "bg-warning",
  critical: "bg-critical",
  neutral: "bg-faint",
  accent: "bg-accent",
};

/** A state, said in words with a coloured dot beside it: never colour alone. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs text-ink">
      <span aria-hidden className={`size-1.5 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

const OUTCOME: Record<Trace["outcome"], [Tone, string]> = {
  ok: ["good", "Answered"],
  cached: ["accent", "From cache"],
  rate_limited: ["warning", "Rate limited"],
  budget_exhausted: ["warning", "Budget used up"],
  bad_request: ["neutral", "Rejected"],
  upstream_failed: ["critical", "All upstreams failed"],
  stream_broken: ["critical", "Stream broke"],
  client_closed: ["neutral", "Caller left"],
};

export function OutcomeBadge({ outcome }: { outcome: Trace["outcome"] }) {
  const [tone, label] = OUTCOME[outcome];
  return <Status tone={tone}>{label}</Status>;
}

const ATTEMPT: Record<Attempt["outcome"], [Tone, string]> = {
  ok: ["good", "answered"],
  skipped_open: ["neutral", "skipped: circuit open"],
  timeout: ["critical", "timed out"],
  rate_limited: ["warning", "rate limited"],
  server: ["critical", "server error"],
  network: ["critical", "network error"],
  auth: ["critical", "credentials refused"],
  bad_request: ["neutral", "rejected the request"],
  aborted: ["neutral", "aborted"],
};

/** The upstreams tried for one request, in order. */
export function Attempts({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) return <p className="text-sm text-muted">No upstream was called.</p>;
  return (
    <ol className="space-y-2">
      {attempts.map((attempt, index) => {
        const [tone, label] = ATTEMPT[attempt.outcome];
        return (
          <li key={index} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-mono text-xs text-faint">{index + 1}</span>
            <code className="min-w-0 break-all font-mono text-xs">{attempt.target}</code>
            <Status tone={tone}>{label}</Status>
            {attempt.outcome !== "skipped_open" && <span className="font-mono text-xs text-muted">{ms(attempt.ms)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-faint">{note}</p>}
    </div>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-sm last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-mono text-xs tabular-nums">{children}</dd>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="card border-critical/40 p-3 text-sm">
      {error}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="card p-8 text-center text-sm text-muted">{children}</p>;
}
