import { useEffect, useState } from "react";
import type { Stats } from "../../shared/api";
import { compact, dollars, get, ms, percent } from "../lib/api";
import { Empty, ErrorNote, Tile } from "../ui";

const WINDOWS = [
  { hours: 1, label: "Last hour" },
  { hours: 24, label: "Last 24 hours" },
  { hours: 168, label: "Last 7 days" },
];

// Fixed order, fixed colours: a series keeps its colour whatever else is on screen.
const SERIES = [
  { key: "upstream", label: "Answered by a model", color: "var(--series-1)" },
  { key: "cached", label: "Answered from cache", color: "var(--series-2)" },
  { key: "rejected", label: "Refused: limit or budget", color: "var(--series-3)" },
  { key: "failed", label: "Failed", color: "var(--series-4)" },
] as const;

type Hour = Stats["hourly"][number];
const HOUR = 3_600_000;

function hourLabel(ts: number, withDay: boolean): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString([], { hour: "numeric" });
  return withDay ? `${date.toLocaleDateString([], { weekday: "short" })} ${time}` : time;
}

/** Every hour of the window, including the ones with no requests. */
function fill(hourly: Hour[], windowHours: number): Hour[] {
  const byHour = new Map(hourly.map((h) => [h.hour, h]));
  const last = Math.floor(Date.now() / HOUR) * HOUR;
  return Array.from({ length: windowHours }, (_, i) => {
    const hour = last - (windowHours - 1 - i) * HOUR;
    return byHour.get(hour) ?? { hour, upstream: 0, cached: 0, rejected: 0, failed: 0 };
  });
}

function niceCeiling(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 8, 10]) if (step * magnitude >= value) return step * magnitude;
  return 10 * magnitude;
}

function HourlyChart({ stats }: { stats: Stats }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const hours = fill(stats.hourly, stats.windowHours);
  const total = (h: Hour) => h.upstream + h.cached + h.rejected + h.failed;
  const top = niceCeiling(Math.max(...hours.map(total)));
  const ticks = [top, top / 2, 0];
  const withDay = stats.windowHours > 24;
  const labelEvery = Math.ceil(hours.length / 6);
  const shown = active === null ? null : hours[active];

  return (
    <section className="card p-4" aria-labelledby="hourly-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="hourly-title" className="font-medium">
          Requests per hour, by what happened to them
        </h2>
        <button type="button" className="text-sm text-accent underline underline-offset-4" onClick={() => setAsTable(!asTable)}>
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        {SERIES.map((series) => (
          <li key={series.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-xs" style={{ background: series.color }} />
            {series.label}
          </li>
        ))}
      </ul>

      {asTable ? (
        <div className="mt-4 max-h-80 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr>
                <th scope="col" className="py-2 font-medium">
                  Hour starting
                </th>
                {SERIES.map((series) => (
                  <th key={series.key} scope="col" className="py-2 text-right font-medium">
                    {series.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-xs tabular-nums">
              {hours
                .filter((h) => total(h) > 0)
                .reverse()
                .map((h) => (
                  <tr key={h.hour} className="border-t border-line">
                    <th scope="row" className="py-1.5 font-normal">
                      {hourLabel(h.hour, true)}
                    </th>
                    {SERIES.map((series) => (
                      <td key={series.key} className="py-1.5 text-right">
                        {h[series.key]}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative mt-4" onPointerLeave={() => setActive(null)}>
          <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2">
            <div className="relative h-44 text-right font-mono text-[11px] text-faint" aria-hidden>
              {ticks.map((tick) => (
                <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - tick / top) * 100}%` }}>
                  {compact(tick)}
                </span>
              ))}
            </div>
            <div className="relative h-44">
              {ticks.map((tick) => (
                <div key={tick} aria-hidden className="absolute inset-x-0 border-t border-line" style={{ top: `${(1 - tick / top) * 100}%` }} />
              ))}
              <div className="absolute inset-0 flex items-end" role="list" aria-label="Requests per hour">
                {hours.map((h, index) => (
                  <div
                    key={h.hour}
                    role="listitem"
                    tabIndex={0}
                    aria-label={`${hourLabel(h.hour, true)}: ${SERIES.map((s) => `${h[s.key]} ${s.label.toLowerCase()}`).join(", ")}`}
                    className={`flex h-full min-w-0 flex-1 flex-col-reverse items-center gap-0.5 px-px outline-none ${active === index ? "bg-accent-soft" : ""}`}
                    onPointerEnter={() => setActive(index)}
                    onFocus={() => setActive(index)}
                    onBlur={() => setActive(null)}
                  >
                    {SERIES.filter((series) => h[series.key] > 0).map((series, position, present) => (
                      <div
                        key={series.key}
                        className={`w-full max-w-6 shrink-0 ${position === present.length - 1 ? "rounded-t-sm" : ""}`}
                        style={{ height: `max(2px, calc(${(h[series.key] / top) * 100}% - 2px))`, background: series.color }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div />
            <div className="mt-1.5 flex font-mono text-[11px] text-faint" aria-hidden>
              {hours.map((h, index) => (
                <span key={h.hour} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
                  {index % labelEvery === 0 ? hourLabel(h.hour, withDay) : ""}
                </span>
              ))}
            </div>
          </div>
          {shown && active !== null && (
            <div
              className="card pointer-events-none absolute top-0 z-10 w-56 p-3 text-xs shadow-lg"
              style={active < hours.length / 2 ? { left: `calc(3rem + ${((active + 1) / hours.length) * 100}% * 0.9)` } : { right: `calc(${((hours.length - active) / hours.length) * 100}% * 0.9)` }}
            >
              <p className="font-medium">{hourLabel(shown.hour, true)}</p>
              <dl className="mt-2 space-y-1">
                {SERIES.map((series) => (
                  <div key={series.key} className="flex items-center justify-between gap-3">
                    <dt className="inline-flex items-center gap-1.5 text-muted">
                      <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: series.color }} />
                      {series.label}
                    </dt>
                    <dd className="font-mono font-semibold tabular-nums">{shown[series.key]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function StatsPage() {
  const [hours, setHours] = useState(24);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      get<Stats>(`/api/stats?hours=${hours}`)
        .then((body) => !stopped && (setStats(body), setError(null)))
        .catch((failure: Error) => !stopped && setError(failure.message));
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [hours]);

  const hits = stats ? stats.cacheExact + stats.cacheSemantic : 0;
  return (
    <div className="space-y-6">
      <div className="flex gap-1 self-start rounded-lg border border-line p-1 text-sm sm:w-fit" role="group" aria-label="Time range">
        {WINDOWS.map((window) => (
          <button
            key={window.hours}
            type="button"
            aria-pressed={hours === window.hours}
            className="flex-1 rounded-md px-3 py-1 whitespace-nowrap aria-pressed:bg-ink aria-pressed:text-canvas"
            onClick={() => setHours(window.hours)}
          >
            {window.label}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {stats && stats.requests === 0 && <Empty>No requests on this key in this period.</Empty>}
      {stats && stats.requests > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Requests" value={compact(stats.requests)} note={`${percent(stats.served, stats.requests)} answered`} />
            <Tile label="Answered from cache" value={percent(hits, stats.served)} note={`${stats.cacheExact} exact, ${stats.cacheSemantic} semantic`} />
            <Tile label="Answered after a fallback" value={compact(stats.fellBack)} note={`${compact(stats.failed)} failed outright`} />
            <Tile label="Refused by limits" value={compact(stats.rateLimited)} note="Rate limit or daily budget" />
            <Tile label="Tokens generated" value={compact(stats.promptTokens + stats.completionTokens)} note="Cache hits not counted" />
            <Tile label="List price of those tokens" value={dollars(stats.costMicros)} note="What the paid plan would charge" />
            <Tile label="Saved by the cache" value={dollars(stats.savedMicros)} note="List price of answers not regenerated" />
            <Tile label="Gateway's own latency" value={ms(stats.latency.overheadP50)} note={`Before calling a model; 95th percentile ${ms(stats.latency.overheadP95)}`} />
          </div>

          <HourlyChart stats={stats} />

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card p-4" aria-labelledby="latency-title">
              <h2 id="latency-title" className="font-medium">
                Time to a complete answer
              </h2>
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-1.5 font-medium">
                      Answered by
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Median
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      95th percentile
                    </th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs tabular-nums">
                  <tr className="border-t border-line">
                    <th scope="row" className="py-2 font-sans text-sm font-normal">
                      A model
                    </th>
                    <td className="py-2 text-right">{ms(stats.latency.upstreamP50)}</td>
                    <td className="py-2 text-right">{ms(stats.latency.upstreamP95)}</td>
                  </tr>
                  <tr className="border-t border-line">
                    <th scope="row" className="py-2 font-sans text-sm font-normal">
                      The cache
                    </th>
                    <td className="py-2 text-right">{ms(stats.latency.cachedP50)}</td>
                    <td className="py-2 text-right">{ms(stats.latency.cachedP95)}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="card p-4" aria-labelledby="upstreams-title">
              <h2 id="upstreams-title" className="font-medium">
                Calls to each upstream
              </h2>
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="py-1.5 font-medium">
                      Upstream
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Calls
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Failed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byProvider.map((row) => (
                    <tr key={row.provider} className="border-t border-line">
                      <th scope="row" className="max-w-0 truncate py-2 font-mono text-xs font-normal" title={row.provider}>
                        {row.provider}
                      </th>
                      <td className="py-2 pl-3 text-right font-mono text-xs tabular-nums">{row.requests}</td>
                      <td className="py-2 pl-3 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                        {row.failures} ({percent(row.failures, row.requests)})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
