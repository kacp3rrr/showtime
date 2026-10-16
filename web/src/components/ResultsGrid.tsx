// Skeleton: pure results grid, no fetching. Lane B restyles from the mockups.
import type { SearchJob, Showtime } from "../../../shared/types";
import { clock } from "../format";

export type ResultsGridProps = {
  job: SearchJob;
  elapsedSec: number;
  onBook: (showtime: Showtime) => void;
  onOpenExternal: (showtime: Showtime) => void;
  onPickTitle: (title: string) => void;
  onNewSearch: () => void;
};

export function ResultsGrid({ job, elapsedSec, onBook, onOpenExternal, onPickTitle, onNewSearch }: ResultsGridProps) {
  const running = job.state === "running";
  // Showtimes arrive sorted by distance then time; group by theater keeping that order.
  const theaters = new Map<string, Showtime[]>();
  for (const s of job.showtimes) theaters.set(s.theater_name, [...(theaters.get(s.theater_name) ?? []), s]);

  return (
    <section className="results">
      <header className="results__header">
        <div>
          {job.matched_title && <h2>Showing results for <strong>{job.matched_title}</strong></h2>}
          {!job.matched_title && running && <h2>Searching…</h2>}
          {job.did_you_mean?.length ? (
            <p className="did-you-mean">Did you mean{" "}
              {job.did_you_mean.map((t) => (
                <button key={t} className="chip" onClick={() => onPickTitle(t)}>{t}</button>
              ))}
            </p>
          ) : null}
          {job.message && <p className={`results__message results__message--${job.state}`}>{job.message}</p>}
        </div>
        <div className="results__meta">
          <span className="results__elapsed">{running ? `Searching · ${elapsedSec}s` : `Done in ${elapsedSec}s`}</span>
          <button className="btn" onClick={onNewSearch}>New search</button>
        </div>
      </header>

      <ul className="sources">
        {job.sources.map((s) => (
          <li key={s.name} className={`pill pill--${s.state}`} title={s.note}>
            {s.state === "running" && <span className="spinner" aria-hidden />}
            {s.name} · {s.state}{s.ms != null && s.state !== "running" ? ` (${(s.ms / 1000).toFixed(0)}s)` : ""}
          </li>
        ))}
      </ul>

      {theaters.size === 0 && running && <p className="results__empty">Looking for showtimes near you…</p>}
      {theaters.size === 0 && !running && !job.message && <p className="results__empty">No showtimes found.</p>}

      <div className="grid">
        {[...theaters.entries()].map(([name, times]) => (
          <article key={name} className="grid__row">
            <div className="grid__theater">
              <h3>{name}</h3>
              <p>{times[0].chain}{times[0].distance_mi != null ? ` · ${times[0].distance_mi} mi` : ""}</p>
            </div>
            <div className="grid__times">
              {times.map((s) => {
                const sold = s.status === "sold_out";
                return (
                  <button
                    key={s.id}
                    className={`time-chip${s.bookable ? " time-chip--bookable" : ""}${sold ? " time-chip--sold" : ""}`}
                    disabled={sold}
                    title={sold ? "Sold out" : s.bookable ? "Book with the agent" : "Opens the theater site in a new tab"}
                    onClick={() => (s.bookable ? onBook(s) : onOpenExternal(s))}
                  >
                    <span className="time-chip__time">{clock(s.start)}</span>
                    {s.format && s.format !== "Standard" && <span className="badge">{s.format}</span>}
                    <span className="time-chip__action">{sold ? "Sold out" : s.bookable ? "Book" : "↗"}</span>
                  </button>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
