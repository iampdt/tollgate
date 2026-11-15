import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEMO_KEY, type Usage } from "../shared/api";
import { compact, currentKey, get, setKey } from "./lib/api";
import { Playground } from "./pages/Playground";
import { Quickstart } from "./pages/Quickstart";
import { RoutesPage } from "./pages/RoutesPage";
import { StatsPage } from "./pages/StatsPage";
import { Traces } from "./pages/Traces";
import "./styles.css";

const TABS = [
  { id: "playground", label: "Playground", page: Playground },
  { id: "traces", label: "Traces", page: Traces },
  { id: "stats", label: "Stats", page: StatsPage },
  { id: "routes", label: "Routes", page: RoutesPage },
  { id: "quickstart", label: "Quickstart", page: Quickstart },
] as const;

type TabId = (typeof TABS)[number]["id"];
const tabFromHash = (): TabId => TABS.find((tab) => `#${tab.id}` === window.location.hash)?.id ?? "playground";

function KeyBar({ onChange }: { onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = currentKey();

  useEffect(() => {
    let stopped = false;
    const load = () =>
      get<Usage>("/api/usage")
        .then((body) => !stopped && (setUsage(body), setError(null)))
        .catch((failure: Error) => !stopped && (setUsage(null), setError(failure.message)));
    void load();
    const timer = setInterval(load, 8000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key]);

  const use = (next: string) => {
    setKey(next);
    setEditing(false);
    setDraft("");
    onChange();
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span className="text-muted">
        Key: <span className="font-medium text-ink">{key === DEMO_KEY ? "public demo" : (usage?.keyName ?? "your key")}</span>
      </span>
      {usage && (
        <span className="font-mono text-xs text-muted tabular-nums">
          {compact(usage.tokensUsedToday)} / {compact(usage.tokensPerDay)} tokens today · {usage.requestsPerMinute} requests/min
        </span>
      )}
      {error && <span className="text-xs text-critical">{error}</span>}
      {editing ? (
        <form
          className="flex min-w-0 flex-1 gap-2 sm:max-w-md"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) use(draft.trim());
          }}
        >
          <input className="input py-1" type="password" autoComplete="off" placeholder="tg_live_…" aria-label="API key" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="btn-secondary py-1">
            Use
          </button>
        </form>
      ) : (
        <button type="button" className="text-accent underline underline-offset-4" onClick={() => (key === DEMO_KEY ? setEditing(true) : use(DEMO_KEY))}>
          {key === DEMO_KEY ? "Use your own key" : "Back to the demo key"}
        </button>
      )}
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [keyVersion, setKeyVersion] = useState(0);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const Page = TABS.find((candidate) => candidate.id === tab)?.page ?? Playground;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
      <header className="pt-8 pb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">
            Tollgate <span className="font-normal text-muted">· an LLM gateway on free tiers</span>
          </h1>
          <a className="text-sm text-accent underline underline-offset-4" href="https://github.com/iampdt/tollgate">
            Source and docs
          </a>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-pretty text-muted">
          One OpenAI-compatible API in front of several model providers. It falls back when a provider fails, answers repeated and reworded questions from a cache, holds every key to a rate limit
          and a daily budget, and records what happened to each request. This page is the live system: every request you send goes through it.
        </p>
        <div className="mt-4">
          <KeyBar onChange={() => setKeyVersion((v) => v + 1)} />
        </div>
      </header>

      <nav aria-label="Sections" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((candidate) => (
          <a
            key={candidate.id}
            href={`#${candidate.id}`}
            aria-current={tab === candidate.id ? "page" : undefined}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted hover:text-ink aria-[current=page]:border-ink aria-[current=page]:font-medium aria-[current=page]:text-ink"
          >
            {candidate.label}
          </a>
        ))}
      </nav>

      <main key={`${tab}-${keyVersion}`}>
        <Page />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
