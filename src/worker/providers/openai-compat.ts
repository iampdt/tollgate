import { type ChatParams, kindForStatus, type Part, type Provider, ProviderError, sseData } from "./base";

interface Chunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

/** Any upstream that speaks the OpenAI chat completions protocol: Groq, OpenRouter, Gemini's compatibility endpoint. */
export function openAiCompatible(id: string, baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch): Provider {
  return {
    id,
    async *stream(params: ChatParams, signal: AbortSignal): AsyncGenerator<Part> {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ ...params, stream: true, stream_options: { include_usage: true } }),
        });
      } catch (error) {
        if (signal.aborted) throw new ProviderError("aborted", "aborted");
        throw new ProviderError("network", error instanceof Error ? error.message : "network error");
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new ProviderError(kindForStatus(response.status), text.slice(0, 300) || response.statusText, response.status);
      }
      for await (const data of sseData(response.body, signal)) {
        if (data === "[DONE]") return;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError("server", chunk.error.message ?? "upstream error");
        const choice = chunk.choices?.[0];
        const part: Part = {};
        if (choice?.delta?.content) part.delta = choice.delta.content;
        if (choice?.finish_reason) part.finish = choice.finish_reason === "length" ? "length" : "stop";
        if (chunk.usage) {
          part.usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        if (part.delta || part.finish || part.usage) yield part;
      }
    },
  };
}
