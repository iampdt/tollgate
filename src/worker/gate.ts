// Admission for one API key: a token bucket for requests per minute and a counter for tokens
// per day. One Durable Object per key, so two requests on the same key can never both take
// the last slot: the object handles them one after the other.

import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";

export interface Limits {
  requestsPerMinute: number;
  tokensPerDay: number;
}

export type Admission =
  | { ok: true; remaining: number }
  | { ok: false; reason: "rate_limited" | "budget_exhausted"; retryAfterSeconds: number };

export interface GateState {
  /** Requests the bucket can still admit right now. May be fractional. */
  bucket: number;
  refilledAt: number;
  /** The UTC day the counters below belong to. */
  day: string;
  tokensUsed: number;
  requests: number;
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export function freshState(limits: Limits, now: number): GateState {
  return { bucket: limits.requestsPerMinute, refilledAt: now, day: utcDay(now), tokensUsed: 0, requests: 0 };
}

/** The whole policy, as a function of state and time, so it can be tested without a clock. */
export function admit(state: GateState, limits: Limits, now: number): { state: GateState; admission: Admission } {
  const next = { ...state };
  if (next.day !== utcDay(now)) {
    next.day = utcDay(now);
    next.tokensUsed = 0;
    next.requests = 0;
  }
  const perSecond = limits.requestsPerMinute / 60;
  const elapsed = Math.max(0, now - next.refilledAt) / 1000;
  next.bucket = Math.min(limits.requestsPerMinute, next.bucket + elapsed * perSecond);
  next.refilledAt = now;

  if (next.tokensUsed >= limits.tokensPerDay) {
    const midnight = Date.parse(`${next.day}T00:00:00Z`) + 86_400_000;
    return {
      state: next,
      admission: { ok: false, reason: "budget_exhausted", retryAfterSeconds: Math.ceil((midnight - now) / 1000) },
    };
  }
  if (next.bucket < 1) {
    return {
      state: next,
      admission: { ok: false, reason: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil((1 - next.bucket) / perSecond)) },
    };
  }
  next.bucket -= 1;
  next.requests += 1;
  return { state: next, admission: { ok: true, remaining: Math.floor(next.bucket) } };
}

export class KeyGate extends DurableObject<AppEnv> {
  private state: GateState | null = null;

  private async load(limits: Limits, now: number): Promise<GateState> {
    this.state ??= (await this.ctx.storage.get<GateState>("state")) ?? freshState(limits, now);
    return this.state;
  }

  async admit(limits: Limits): Promise<Admission> {
    const now = Date.now();
    const result = admit(await this.load(limits, now), limits, now);
    this.state = result.state;
    await this.ctx.storage.put("state", result.state);
    return result.admission;
  }

  /** Counts the tokens a finished request used against today's budget. */
  async settle(tokens: number): Promise<void> {
    if (!this.state) this.state = (await this.ctx.storage.get<GateState>("state")) ?? null;
    if (!this.state || tokens <= 0) return;
    const now = Date.now();
    if (this.state.day !== utcDay(now)) this.state = { ...this.state, day: utcDay(now), tokensUsed: 0, requests: 0 };
    this.state = { ...this.state, tokensUsed: this.state.tokensUsed + tokens };
    await this.ctx.storage.put("state", this.state);
  }

  async usage(): Promise<{ tokensUsedToday: number; requestsToday: number }> {
    const state = this.state ?? (await this.ctx.storage.get<GateState>("state"));
    if (!state || state.day !== utcDay(Date.now())) return { tokensUsedToday: 0, requestsToday: 0 };
    return { tokensUsedToday: state.tokensUsed, requestsToday: state.requests };
  }
}
