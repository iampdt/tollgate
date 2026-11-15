import { type ChatParams, estimateTokens, type Part, type Provider, ProviderError } from "./base";

// An upstream that costs nothing and misbehaves on request. The model name picks the behaviour.
// It is how the tests exercise fallback, timeouts and broken streams, how the load test runs
// without spending anyone's quota, and how the public demo shows a provider failing.
//
//   echo          repeats the last user message, a few words at a time
//   canned        a fixed sentence
//   fail-503      refuses with a server error       fail-429   refuses with "too many requests"
//   fail-400      refuses the request as invalid    fail-401   refuses the credentials
//   timeout       never answers                     slow       answers after 400 ms
//   midstream     sends three pieces, then breaks

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError("aborted", "aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(new ProviderError("aborted", "aborted"))), { once: true });
  });

export const CANNED = "This reply came from the gateway's built-in mock provider, which answers when every real upstream is unavailable.";

export function mock(): Provider {
  return {
    id: "mock",
    async *stream(params: ChatParams, signal: AbortSignal): AsyncGenerator<Part> {
      const lastUser = [...params.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const promptTokens = estimateTokens(params.messages.map((m) => m.content).join("\n"));
      const say = async function* (text: string, pause: number): AsyncGenerator<Part> {
        const words = text.split(/(?<=\s)/);
        for (let i = 0; i < words.length; i += 4) {
          if (pause) await sleep(pause, signal);
          yield { delta: words.slice(i, i + 4).join("") };
        }
        yield { finish: "stop", usage: { promptTokens, completionTokens: estimateTokens(text) } };
      };

      switch (params.model) {
        case "echo":
          return yield* say(lastUser || "(nothing to echo)", 0);
        case "canned":
          return yield* say(CANNED, 0);
        case "slow":
          await sleep(400, signal);
          return yield* say(lastUser || "slow", 0);
        case "timeout":
          await sleep(3_600_000, signal);
          return;
        case "midstream":
          yield { delta: "one " };
          yield { delta: "two " };
          yield { delta: "three " };
          throw new ProviderError("server", "the upstream closed the stream early", 502);
        case "fail-503":
          throw new ProviderError("server", "mock upstream is down", 503);
        case "fail-429":
          throw new ProviderError("rate_limited", "mock upstream is rate limiting", 429);
        case "fail-400":
          throw new ProviderError("bad_request", "mock upstream rejected the request", 400);
        case "fail-401":
          throw new ProviderError("auth", "mock upstream rejected the credentials", 401);
        default:
          throw new ProviderError("bad_request", `mock has no model "${params.model}"`, 400);
      }
    },
  };
}
