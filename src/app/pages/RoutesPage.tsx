import { useEffect, useState } from "react";
import type { BreakerState, Health } from "../../shared/api";
import { get } from "../lib/api";
import { ErrorNote, Status } from "../ui";

const STATE: Record<BreakerState, ["good" | "critical" | "warning", string]> = {
  closed: ["good", "in use"],
  open: ["critical", "skipped: circuit open"],
  half_open: ["warning", "next request tests it"],
};

export function RoutesPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      get<Health>("/api/health")
        .then((body) => !stopped && (setHealth(body), setError(null)))
        .catch((failure: Error) => !stopped && setError(failure.message));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm text-pretty text-muted">
        A route is a name callers use as the <code className="font-mono text-xs">model</code>, and an ordered list of upstreams behind it. The gateway tries them top to bottom. An upstream that fails
        five times in a row is skipped for 30 seconds, then tested with a single request. The public demo key can only spend providers whose free quota is the demo's alone; other upstreams are left out for it.
      </p>
      <ErrorNote error={error} />
      {health && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {health.routes.map((route) => (
              <section key={route.name} className="card p-4">
                <h2 className="font-mono text-sm font-semibold">{route.name}</h2>
                <p className="mt-1 text-sm text-muted">{route.description}</p>
                <ol className="mt-3 space-y-2">
                  {route.targets.map((target, index) => (
                    <li key={target.target} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-xs text-faint">{index + 1}</span>
                      <code className={`min-w-0 font-mono text-xs break-all ${target.configured ? "" : "text-faint line-through"}`}>{target.target}</code>
                      {target.configured ? <Status tone={STATE[target.state][0]}>{STATE[target.state][1]}</Status> : <span className="text-xs text-faint">no key set</span>}
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
          <section className="card p-4">
            <h2 className="font-medium">Providers on this deployment</h2>
            <ul className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {health.providers.map((provider) => (
                <li key={provider.id} className="flex items-center justify-between gap-3 text-sm">
                  <code className="font-mono text-xs">{provider.id}</code>
                  {provider.configured ? (
                    <Status tone="good">{provider.paid ? "configured · paid" : provider.demo ? "configured · open to the demo key" : "configured · own keys only"}</Status>
                  ) : (
                    <span className="text-xs text-faint">needs {provider.needs}</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-faint">
              Semantic cache: embeddings from <code className="font-mono">{health.semanticCache.embedder}</code>, stored in {health.semanticCache.index}
              {health.semanticCache.judge && (
                <>
                  , matches confirmed by <code className="font-mono">{health.semanticCache.judge}</code>
                </>
              )}
              .
            </p>
          </section>
        </>
      )}
    </div>
  );
}
