import type { Breaker } from "./breaker";
import type { KeyGate } from "./gate";

/** Bindings and settings. Everything optional is something the gateway runs without. */
export interface AppEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  GATES: DurableObjectNamespace<KeyGate>;
  BREAKERS: DurableObjectNamespace<Breaker>;
  AI?: Ai;
  VECTORS?: VectorizeIndex;
  FIRST_TOKEN_TIMEOUT_MS?: string;
  TOTAL_TIMEOUT_MS?: string;
  /** Guards /api/admin. Without it the admin API is switched off. */
  ADMIN_TOKEN?: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

export function numberSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
