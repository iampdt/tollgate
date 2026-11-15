import { type ChatParams, type Part, type Provider, ProviderError, sseData } from "./base";

// Workers AI streams one of two shapes depending on the model: its own
// {"response":"…"} or OpenAI's {"choices":[{"delta":{"content":"…"}}]}. Both are read.
interface Chunk {
  response?: string | null;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export function workersAi(ai: Ai): Provider {
  return {
    id: "workers-ai",
    async *stream(params: ChatParams, signal: AbortSignal): AsyncGenerator<Part> {
      let body: ReadableStream<Uint8Array>;
      try {
        const run = ai.run as unknown as (model: string, input: unknown, options?: unknown) => Promise<unknown>;
        const result = await run.call(
          ai,
          params.model,
          {
            messages: params.messages,
            stream: true,
            max_tokens: params.max_tokens ?? 512,
            ...(params.temperature !== undefined && { temperature: params.temperature }),
            ...(params.top_p !== undefined && { top_p: params.top_p }),
          },
          { signal },
        );
        if (!(result instanceof ReadableStream)) throw new ProviderError("server", "Workers AI did not return a stream");
        body = result as ReadableStream<Uint8Array>;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (signal.aborted) throw new ProviderError("aborted", "aborted");
        throw classify(error);
      }

      let finish: "stop" | "length" | undefined;
      for await (const data of sseData(body, signal)) {
        if (data === "[DONE]") break;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        const delta = chunk.response ?? choice?.delta?.content ?? "";
        if (choice?.finish_reason) finish = choice.finish_reason === "length" ? "length" : "stop";
        const part: Part = {};
        if (delta) part.delta = delta;
        if (chunk.usage) {
          part.usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        if (part.delta || part.usage) yield part;
      }
      yield { finish: finish ?? "stop" };
    },
  };
}

function classify(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error);
  // Workers AI reports its own numeric codes in the message.
  if (/\b(3036|4006)\b|daily free allocation|quota|rate limit/i.test(message)) return new ProviderError("rate_limited", message, 429);
  if (/\b(5007|5004)\b|no such model|invalid (input|prompt)/i.test(message)) return new ProviderError("bad_request", message, 400);
  if (/\b3040\b|capacity|timed? ?out/i.test(message)) return new ProviderError("server", message, 503);
  return new ProviderError("server", message, 502);
}
