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

interface Model {
  /** List price in US dollars per million tokens; null where no price is configured. */
  price: { input: number; output: number } | null;
  /** Extra request fields this model needs, sent as they are. */
  extra?: Record<string, unknown>;
  /**
   * Tokens added to the caller's limit for a model that thinks before it answers. Its
   * thinking counts against the limit, so without this a small limit buys no answer at all.
   */
  thinkingAllowance?: number;
}

const FREE = { input: 0, output: 0 };
// Models that think before answering spend output tokens on it. For a gateway's default
// routes the thinking is turned down so a small max_tokens still produces an answer.
const LOW_EFFORT = { reasoning_effort: "low" };

// List prices as published by each provider in November 2026: Cloudflare (Workers AI
// pricing page), Groq (console.groq.com/docs/models), Google (Gemini API pricing) and OpenAI
// (API pricing). On a free tier nothing is billed; the figure is what the same tokens cost
// on the paid plan, so the dashboard can say what a cache hit or a cheaper route is worth.
export const MODELS: Record<TargetId, Model> = {
  "workers-ai/@cf/meta/llama-3.2-3b-instruct": { price: { input: 0.051, output: 0.335 } },
  "workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8": { price: { input: 0.152, output: 0.287 } },
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": { price: { input: 0.293, output: 2.253 } },
  "groq/openai/gpt-oss-20b": { price: { input: 0.075, output: 0.3 }, extra: LOW_EFFORT, thinkingAllowance: 160 },
  "groq/openai/gpt-oss-120b": { price: { input: 0.15, output: 0.6 }, extra: LOW_EFFORT, thinkingAllowance: 160 },
  "gemini/gemini-3.5-flash-lite": { price: { input: 0.3, output: 2.5 }, extra: LOW_EFFORT },
  "openai/gpt-4.1-mini": { price: { input: 0.4, output: 1.6 } },
  "openrouter/meta-llama/llama-3.3-70b-instruct:free": { price: FREE },
  "mock/echo": { price: FREE },
  "mock/empty": { price: FREE },
  "mock/canned": { price: FREE },
  "mock/slow": { price: FREE },
  "mock/timeout": { price: FREE },
  "mock/midstream": { price: FREE },
  "mock/fail-503": { price: FREE },
  "mock/fail-429": { price: FREE },
  "mock/fail-400": { price: FREE },
  "mock/fail-401": { price: FREE },
};

/** Cost in millionths of a dollar. Dollars per million tokens times tokens is exactly that unit. */
export function costMicros(target: TargetId, promptTokens: number, completionTokens: number): number {
  const price = MODELS[target]?.price;
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

const GROQ_SMALL = "groq/openai/gpt-oss-20b";
const GROQ_LARGE = "groq/openai/gpt-oss-120b";
const GEMINI = "gemini/gemini-3.5-flash-lite";

export const ROUTES: Record<string, Route> = {
  fast: {
    description: "Small models, quickest first, across two providers.",
    targets: [GROQ_SMALL, SMALL, MEDIUM],
  },
  smart: {
    description: "Larger free models from three providers.",
    targets: [GEMINI, GROQ_LARGE, LARGE, MEDIUM],
  },
  premium: {
    description: "A paid model first, free ones behind it. Not available to the demo key.",
    targets: ["openai/gpt-4.1-mini", GEMINI, GROQ_LARGE, LARGE],
  },
  "demo-outage": {
    description: "The first upstream is always down, to show fallback and the circuit breaker.",
    targets: ["mock/fail-503", GROQ_SMALL, SMALL, "mock/canned"],
  },
  "mock-fallback": { description: "A failing mock, then an echo. Free to call.", targets: ["mock/fail-503", "mock/echo"] },
  "mock-timeout": { description: "A mock that never answers, then an echo.", targets: ["mock/timeout", "mock/echo"] },
  "mock-busy": { description: "A rate-limited mock, then an echo.", targets: ["mock/fail-429", "mock/echo"] },
  "mock-broken": { description: "A mock that breaks mid-answer, then an echo.", targets: ["mock/midstream", "mock/echo"] },
  "mock-empty": { description: "A mock that answers with nothing, then an echo.", targets: ["mock/empty", "mock/echo"] },
  "mock-down": { description: "Every upstream fails.", targets: ["mock/fail-503", "mock/fail-401"] },
};

export interface ProviderInfo {
  id: string;
  needs: string | null;
  /** Billed per token, with no free tier. */
  paid: boolean;
  /** Whether the public demo key may use it: only providers whose quota is this demo's alone to spend. */
  demo: boolean;
  baseUrl?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "workers-ai", needs: null, paid: false, demo: true },
  { id: "groq", needs: "GROQ_API_KEY", paid: false, demo: true, baseUrl: "https://api.groq.com/openai/v1" },
  { id: "gemini", needs: "GEMINI_API_KEY", paid: false, demo: false, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "openrouter", needs: "OPENROUTER_API_KEY", paid: false, demo: false, baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", needs: "OPENAI_API_KEY", paid: true, demo: false, baseUrl: "https://api.openai.com/v1" },
  { id: "xai", needs: "XAI_API_KEY", paid: true, demo: false, baseUrl: "https://api.x.ai/v1" },
  { id: "mock", needs: null, paid: false, demo: true },
];

export const DEMO_PROVIDERS = new Set(PROVIDERS.filter((p) => p.demo).map((p) => p.id));

/** The API key this deployment holds for each provider that needs one. */
export function providerKeys(env: AppEnv): Record<string, string | undefined> {
  // "Grok" (xAI's model) and "Groq" (the inference company) are one letter apart, and a key
  // for either may have been stored as GROK_API_KEY. Their keys have different prefixes.
  const grok = env.GROK_API_KEY;
  return {
    groq: env.GROQ_API_KEY ?? (grok?.startsWith("gsk_") ? grok : undefined),
    xai: env.XAI_API_KEY ?? (grok?.startsWith("xai-") ? grok : undefined),
    gemini: env.GEMINI_API_KEY,
    openai: env.OPENAI_API_KEY,
    openrouter: env.OPENROUTER_API_KEY,
  };
}

/** The providers this deployment has credentials for. */
export function configuredProviders(env: AppEnv): Map<string, Provider> {
  const providers = new Map<string, Provider>([["mock", mock()]]);
  if (env.AI) providers.set("workers-ai", workersAi(env.AI));
  const keys = providerKeys(env);
  for (const info of PROVIDERS) {
    const key = keys[info.id];
    if (info.baseUrl && key) providers.set(info.id, openAiCompatible(info.id, info.baseUrl, key, { maxTokensField: info.id === "openai" ? "max_completion_tokens" : "max_tokens" }));
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
 * name is unknown; an empty list means it is known but nothing behind it can be used: no
 * credentials, or (with `demoOnly`) a provider the public demo key may not spend.
 */
export function resolve(model: string, providers: Map<string, Provider>, demoOnly = false): Resolved | null {
  const route = ROUTES[model];
  const ids = route ? route.targets : model in MODELS ? [model] : null;
  if (!ids) return null;
  const usable = (target: Target) => providers.has(target.provider) && (!demoOnly || DEMO_PROVIDERS.has(target.provider));
  return { name: model, targets: ids.map(parseTarget).filter(usable) };
}

/** The request as this target's model needs it: its extra fields, and room to think. */
export function forTarget<P extends { max_tokens?: number }>(target: Target, params: P): P & { model: string; extra?: Record<string, unknown> } {
  const model = MODELS[target.id];
  const allowance = model?.thinkingAllowance ?? 0;
  return {
    ...params,
    model: target.model,
    extra: model?.extra,
    ...(params.max_tokens !== undefined && allowance > 0 && { max_tokens: params.max_tokens + allowance }),
  };
}
