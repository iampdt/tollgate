import { DEMO_KEY } from "../../shared/api";

function Code({ children }: { children: string }) {
  return (
    <pre className="card overflow-x-auto p-4 font-mono text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

export function Quickstart() {
  const origin = window.location.origin;
  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Call it like the OpenAI API</h2>
        <p className="text-sm text-pretty text-muted">
          The gateway speaks the chat completions protocol, so existing clients work by changing the base URL. The key below is public: each visitor gets 20 requests a minute and 20,000 tokens a
          day on it, on the routes that use Groq and Cloudflare's models.
        </p>
        <Code>{`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${DEMO_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "fast", "messages": [{"role": "user", "content": "Hello"}]}'`}</Code>
        <Code>{`from openai import OpenAI

client = OpenAI(base_url="${origin}/v1", api_key="${DEMO_KEY}")
reply = client.chat.completions.create(
    model="fast",  # a route: the gateway picks the upstream and falls back
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)`}</Code>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Per-request controls</h2>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Request header
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  What it does
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                ["X-Tollgate-Cache", "off, exact or semantic. Overrides the key's default."],
                ["X-Tollgate-Cache-Ttl", "Seconds to keep this answer: 60 to 86,400. Default 3,600."],
                ["X-Tollgate-Similarity-Threshold", "How similar an earlier prompt must be before the judge is asked: 0.5 to 1. Default 0.85."],
              ].map(([header, meaning]) => (
                <tr key={header} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap">{header}</td>
                  <td className="px-4 py-2.5 text-muted">{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-pretty text-muted">
          Every response says what happened in its headers (<code className="font-mono text-xs">X-Tollgate-Cache</code>, <code className="font-mono text-xs">X-Tollgate-Provider</code>,{" "}
          <code className="font-mono text-xs">X-Tollgate-Fallbacks</code>) and in a <code className="font-mono text-xs">tollgate</code> object beside the usual fields.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Your own keys</h2>
        <p className="text-sm text-pretty text-muted">Keys with their own limits are created with the admin token of a deployment. The key is shown once; only its hash is stored.</p>
        <Code>{`curl ${origin}/api/admin/keys \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "billing-service", "requestsPerMinute": 120, "tokensPerDay": 500000, "cacheMode": "exact"}'`}</Code>
      </section>
    </div>
  );
}
