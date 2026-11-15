// A circuit breaker per upstream, shared by every instance of the Worker. After enough
// failures in a row an upstream is skipped without being called; after a cool-off one request
// is let through to test it, and its result closes the circuit or opens it for longer.

import { DurableObject } from "cloudflare:workers";
import type { BreakerState } from "../shared/api";
import type { AppEnv } from "./env";

export const FAILURES_TO_OPEN = 5;
export const BASE_OPEN_MS = 30_000;
export const MAX_OPEN_MS = 5 * 60_000;
/** How long one request holds the right to test a half-open upstream. */
export const PROBE_LEASE_MS = 20_000;

export interface Circuit {
  failures: number;
  /** 0 while closed; otherwise the time until which the upstream is skipped. */
  openUntil: number;
  /** How long the circuit opened for last time; doubles on each failed test. */
  openMs: number;
  probeUntil: number;
}

export type Circuits = Record<string, Circuit>;

const closed = (): Circuit => ({ failures: 0, openUntil: 0, openMs: 0, probeUntil: 0 });

export function stateOf(circuit: Circuit | undefined, now: number): BreakerState {
  if (!circuit || circuit.openUntil === 0) return "closed";
  return now < circuit.openUntil ? "open" : "half_open";
}

/**
 * What a request should do with each target. A half-open target is handed to exactly one
 * request (which gets "half_open" and must report back); everyone else sees it as open until
 * that test reports or its lease runs out.
 */
export function check(circuits: Circuits, targets: string[], now: number): { circuits: Circuits; states: Record<string, BreakerState> } {
  const next = { ...circuits };
  const states: Record<string, BreakerState> = {};
  for (const target of targets) {
    const circuit = next[target];
    const state = stateOf(circuit, now);
    if (state === "half_open" && circuit) {
      if (now < circuit.probeUntil) {
        states[target] = "open";
      } else {
        next[target] = { ...circuit, probeUntil: now + PROBE_LEASE_MS };
        states[target] = "half_open";
      }
    } else {
      states[target] = state;
    }
  }
  return { circuits: next, states };
}

export function report(circuits: Circuits, results: { target: string; ok: boolean }[], now: number): Circuits {
  const next = { ...circuits };
  for (const { target, ok } of results) {
    const circuit = next[target] ?? closed();
    if (ok) {
      next[target] = closed();
    } else if (circuit.openUntil !== 0) {
      // A failed test, or a straggler that started before the circuit opened: stay open, longer.
      const openMs = now >= circuit.openUntil ? Math.min(MAX_OPEN_MS, circuit.openMs * 2) : circuit.openMs;
      next[target] = { failures: circuit.failures + 1, openUntil: now + openMs, openMs, probeUntil: 0 };
    } else if (circuit.failures + 1 >= FAILURES_TO_OPEN) {
      next[target] = { failures: circuit.failures + 1, openUntil: now + BASE_OPEN_MS, openMs: BASE_OPEN_MS, probeUntil: 0 };
    } else {
      next[target] = { ...circuit, failures: circuit.failures + 1 };
    }
  }
  return next;
}

export class Breaker extends DurableObject<AppEnv> {
  private circuits: Circuits | null = null;

  private async load(): Promise<Circuits> {
    this.circuits ??= (await this.ctx.storage.get<Circuits>("circuits")) ?? {};
    return this.circuits;
  }

  async check(targets: string[]): Promise<Record<string, BreakerState>> {
    const before = await this.load();
    const result = check(before, targets, Date.now());
    if (result.circuits !== before && Object.values(result.states).includes("half_open")) {
      this.circuits = result.circuits;
      await this.ctx.storage.put("circuits", result.circuits);
    }
    return result.states;
  }

  async report(results: { target: string; ok: boolean }[]): Promise<void> {
    if (results.length === 0) return;
    const before = await this.load();
    // The common case, a success on a circuit that is already closed, changes nothing.
    if (results.every((r) => r.ok && !before[r.target])) return;
    this.circuits = report(before, results, Date.now());
    for (const [target, circuit] of Object.entries(this.circuits)) {
      if (circuit.failures === 0 && circuit.openUntil === 0) delete this.circuits[target];
    }
    await this.ctx.storage.put("circuits", this.circuits);
  }

  /** For the dashboard: the state of each target, without handing out a test. */
  async states(targets: string[]): Promise<Record<string, BreakerState>> {
    const circuits = await this.load();
    const now = Date.now();
    return Object.fromEntries(targets.map((target) => [target, stateOf(circuits[target], now)]));
  }

  async reset(): Promise<void> {
    this.circuits = {};
    await this.ctx.storage.deleteAll();
  }
}
