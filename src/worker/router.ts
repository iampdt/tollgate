// Tries a route's upstreams in order until one starts answering.

import type { Attempt, BreakerState, FailureKind } from "../shared/api";
import type { Target } from "./catalog";
import { type ChatParams, type Part, type Provider, ProviderError } from "./providers/base";

export interface RouterDeps {
  providers: Map<string, Provider>;
  breaker: Record<string, BreakerState>;
  firstTokenTimeoutMs: number;
  /** Aborts when the caller goes away or the whole request has run too long. */
  signal: AbortSignal;
  now: () => number;
}

/** An upstream that has produced its first piece. */
export interface Opened {
  index: number;
  target: Target;
  first: Part;
  rest: AsyncGenerator<Part>;
  startedAt: number;
  firstTokenAt: number;
  cancel: () => void;
}

/** Failures that say something about the upstream's health. A rejected request or a caller hanging up does not. */
export function countsAgainstUpstream(kind: FailureKind): boolean {
  return kind !== "bad_request" && kind !== "aborted";
}

export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError("server", error instanceof Error ? error.message : String(error));
}

export class RequestRejected extends Error {
  constructor(readonly upstream: ProviderError) {
    super(upstream.message);
  }
}

/**
 * Starting at `from`, opens the first target that answers. Skips targets whose circuit is
 * open, and moves on after a failure or a first-token timeout. Returns null when none is left.
 * Throws RequestRejected when an upstream says the request itself is invalid: sending the
 * same request elsewhere would only spend more quota.
 */
export async function open(
  deps: RouterDeps,
  targets: Target[],
  from: number,
  params: Omit<ChatParams, "model">,
  attempts: Attempt[],
): Promise<Opened | null> {
  for (let index = from; index < targets.length; index++) {
    const target = targets[index];
    if (!target) continue;
    if (deps.signal.aborted) return null;
    if (deps.breaker[target.id] === "open") {
      attempts.push({ target: target.id, outcome: "skipped_open", ms: 0 });
      continue;
    }
    const provider = deps.providers.get(target.provider);
    if (!provider) continue;

    const controller = new AbortController();
    const cancel = () => controller.abort();
    deps.signal.addEventListener("abort", cancel, { once: true });
    const startedAt = deps.now();
    const stream = provider.stream({ ...params, model: target.model }, controller.signal);

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const next = stream.next();
      // If the timeout wins, this promise rejects later with "aborted"; that must not go unhandled.
      next.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ProviderError("timeout", `no first token within ${deps.firstTokenTimeoutMs} ms`));
          cancel();
        }, deps.firstTokenTimeoutMs);
      });
      const result = await Promise.race([next, timeout]);
      clearTimeout(timer);
      attempts.push({ target: target.id, outcome: "ok", ms: deps.now() - startedAt });
      return {
        index,
        target,
        first: result.done ? { finish: "stop" } : result.value,
        rest: result.done ? (async function* () {})() : stream,
        startedAt,
        firstTokenAt: deps.now(),
        cancel: () => {
          deps.signal.removeEventListener("abort", cancel);
          cancel();
        },
      };
    } catch (raw) {
      clearTimeout(timer);
      deps.signal.removeEventListener("abort", cancel);
      const error = toProviderError(raw);
      const kind: FailureKind = deps.signal.aborted ? "aborted" : error.kind;
      attempts.push({ target: target.id, outcome: kind, ms: deps.now() - startedAt, status: error.status, message: error.message.slice(0, 200) });
      if (kind === "aborted") return null;
      if (kind === "bad_request") throw new RequestRejected(error);
    }
  }
  return null;
}

/** Marks the attempt on a target that opened fine but then broke. */
export function markBroken(attempts: Attempt[], opened: Opened, error: ProviderError, now: number): void {
  const attempt = attempts.findLast((a) => a.target === opened.target.id && a.outcome === "ok");
  if (!attempt) return;
  attempt.outcome = error.kind;
  attempt.ms = now - opened.startedAt;
  attempt.status = error.status;
  attempt.message = error.message.slice(0, 200);
}

/** What each attempt tells the circuit breaker. */
export function breakerReports(attempts: Attempt[]): { target: string; ok: boolean }[] {
  const reports: { target: string; ok: boolean }[] = [];
  for (const attempt of attempts) {
    if (attempt.outcome === "ok") reports.push({ target: attempt.target, ok: true });
    else if (attempt.outcome !== "skipped_open" && countsAgainstUpstream(attempt.outcome)) reports.push({ target: attempt.target, ok: false });
  }
  return reports;
}
