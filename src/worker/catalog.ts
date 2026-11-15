// What the gateway can route to: the providers, the models it knows, and the named routes.

import type { AppEnv } from "./env";
import type { Provider } from "./providers/base";
import { mock } from "./providers/mock";
import { openAiCompatible } from "./providers/openai-compat";
import { workersAi } from "./providers/workers-ai";

/** A model on a provider, written "provider/model". */
export type TargetId = string;

export interface Target {
  id: TargetId;
  provider: string;
  model: string;
}

export function parseTarget(id: TargetId): Target {
  const slash = id.indexOf("/");
  return { id, provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

/** List price in US dollars per million tokens; null where no price is configured. */
interface Price {
  input: number;
  output: number;
}

// Workers AI prices are from developers.cloudflare.com/workers-ai/platform/pricing (November 2026).
// The free tier is not billed; these are what the same tokens cost on the paid plan, so the
// dashboard can say what a cache hit or a cheaper route is worth.
export const MODELS: Record<TargetId, Price | null> = {
  "workers-ai/@cf/meta/llama-3.2-3b-instruct": { input: 0.051, output: 0.335 },
  "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8": { input: 0.152, output: 0.287 },
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 0.293, output: 2.253 },
  "groq/llama-3.1-8b-instant": null,
  "groq/llama-3.3-70b-versatile": null,
  "gemini/gemini-3.5-flash": null,
  "gemini/gemini-3.5-flash-lite": null,
  "openrouter/meta-llama/llama-3.3-70b-instruct:free": { input: 0, output: 0 },
  "mock/echo": { input: 0, output: 0 },
  "mock/canned": { input: 0, output: 0 },
  "mock/slow": { input: 0, output: 0 },
  "mock/timeout": { input: 0, output: 0 },
  "mock/midstream": { input: 0, output: 0 },
  "mock/fail-503": { input: 0, output: 0 },
  "mock/fail-429": { input: 0, output: 0 },
  "mock/fail-400": { input: 0, output: 0 },
  "mock/fail-401": { input: 0, output: 0 },
};

/** Cost in millionths of a dollar. Dollars per million tokens times tokens is exactly that unit. */
export function costMicros(target: TargetId, promptTokens: number, completionTokens: number): number {
  const price = MODELS[target];
  if (!price) return 0;
  return Math.round(price.input * promptTokens + price.output * completionTokens);
}

export interface Route {
  description: string;
  /** Tried in order. A target whose provider has no credentials is left out. */
  targets: TargetId[];
}

const SMALL = "workers-ai/@cf/meta/llama-3.2-3b-instruct";
const MEDIUM = "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8";
const LARGE = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const ROUTES: Record<string, Route> = {
  fast: {
    description: "Small models, quickest first.",
    targets: ["groq/llama-3.1-8b-instant", SMALL, MEDIUM],
  },
  smart: {
    description: "The largest free models, with smaller ones behind them.",
    targets: ["gemini/gemini-3.5-flash", "groq/llama-3.3-70b-versatile", LARGE, MEDIUM],
  },
  "demo-outage": {
    description: "The first upstream is always down, to show fallback and the circuit breaker.",
    targets: ["mock/fail-503", SMALL, "mock/canned"],
  },
  "mock-fallback": { description: "A failing mock, then an echo. Free to call.", targets: ["mock/fail-503", "mock/echo"] },
  "mock-timeout": { description: "A mock that never answers, then an echo.", targets: ["mock/timeout", "mock/echo"] },
  "mock-busy": { description: "A rate-limited mock, then an echo.", targets: ["mock/fail-429", "mock/echo"] },
  "mock-broken": { description: "A mock that breaks mid-answer, then an echo.", targets: ["mock/midstream", "mock/echo"] },
  "mock-down": { description: "Every upstream fails.", targets: ["mock/fail-503", "mock/fail-401"] },
};

export const PROVIDERS: { id: string; needs: string | null }[] = [
  { id: "workers-ai", needs: null },
  { id: "groq", needs: "GROQ_API_KEY" },
  { id: "gemini", needs: "GEMINI_API_KEY" },
  { id: "openrouter", needs: "OPENROUTER_API_KEY" },
  { id: "mock", needs: null },
];

/** The providers this deployment has credentials for. */
export function configuredProviders(env: AppEnv): Map<string, Provider> {
  const providers = new Map<string, Provider>([["mock", mock()]]);
  if (env.AI) providers.set("workers-ai", workersAi(env.AI));
  if (env.GROQ_API_KEY) providers.set("groq", openAiCompatible("groq", "https://api.groq.com/openai/v1", env.GROQ_API_KEY));
  if (env.GEMINI_API_KEY) {
    providers.set(
      "gemini",
      openAiCompatible("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", env.GEMINI_API_KEY),
    );
  }
  if (env.OPENROUTER_API_KEY) {
    providers.set("openrouter", openAiCompatible("openrouter", "https://openrouter.ai/api/v1", env.OPENROUTER_API_KEY));
  }
  return providers;
}

export interface Resolved {
  /** The route name, or the target id when a model was addressed directly. */
  name: string;
  targets: Target[];
}

/**
 * Turns the caller's `model` into the upstreams to try. A route name gives its configured
 * targets in order; "provider/model" gives that one model and no fallback. Null means the
 * name is unknown; an empty list means it is known but nothing behind it is configured.
 */
export function resolve(model: string, providers: Map<string, Provider>): Resolved | null {
  const route = ROUTES[model];
  const ids = route ? route.targets : model in MODELS ? [model] : null;
  if (!ids) return null;
  return { name: model, targets: ids.map(parseTarget).filter((target) => providers.has(target.provider)) };
}
