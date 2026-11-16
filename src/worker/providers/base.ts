import type { FailureKind } from "../../shared/api";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A chat request with everything gateway-specific already stripped. */
export interface ChatParams {
  model: string;
  messages: Message[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  /** Provider-specific fields for this model, merged into the request as they are. */
  extra?: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** One piece of an upstream's answer. Every provider is read as a stream, even for a non-streaming caller. */
export interface Part {
  delta?: string;
  finish?: "stop" | "length";
  usage?: TokenUsage;
}

export interface Provider {
  id: string;
  /**
   * Starts a completion. Must throw ProviderError for anything that goes wrong, and must stop
   * when the signal aborts.
   */
  stream(params: ChatParams, signal: AbortSignal): AsyncGenerator<Part>;
}

export class ProviderError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function kindForStatus(status: number): FailureKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  // Not found or not allowed is about this upstream (a model name it no longer has), not
  // about the caller's request, so the route should carry on.
  if (status === 404 || status === 405) return "server";
  return "bad_request";
}

/** Splits a byte stream of server-sent events into the payloads of its `data:` lines. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith("data:")) yield rest.slice(5).trim();
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** A rough token count for upstreams that do not report one: about four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
