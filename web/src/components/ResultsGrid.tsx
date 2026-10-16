// Results panel, pure (no fetching): progress view while searching, then theater rows with time chips.
import type { SearchJob, Showtime } from "../../../shared/types";
import { clock } from "../format";

export type ResultsGridProps = {
  job: SearchJob;
  elapsedSec: number;
  /** A booking is in progress: no new booking, search or title pick until it ends. */
  locked?: boolean;
  onBook: (showtime: Showtime) => void;
  onOpenExternal: (showtime: Showtime) => void;
  onPickTitle: (title: string) => void;
  onNewSearch: () => void;
};

const PROGRESS_CAP_SEC = 90;
const LOCKED_NOTE = "Finish or cancel the booking first";

/** "fandango" → "Fandango", "amc" → "AMC". */
const sourceName = (s: string) => (s.length <= 3 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1));

/** Poster spot: the chain's name (short) or initials (long); the theater's initial if there's no chain. */
function badgeText(chain: string, theater: string): string {
  const c = chain.trim();
  if (!c) return theater.trim()[0]?.toUpperCase() ?? "?";
  if (c.length <= 8) return c.toUpperCase();
  return c.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}

export function ResultsGrid({ job, elapsedSec, locked = false, onBook, onOpenExternal, onPickTitle, onNewSearch }: ResultsGridProps) {
  const running = job.state === "running";
  // Showtimes arrive sorted by distance then time; group by theater keeping that order.
  const theaters = new Map<string, Showtime[]>();
  for (const s of job.showtimes) theaters.set(s.theater_name, [...(theaters.get(s.theater_name) ?? []), s]);
  const pct = Math.min(100, (elapsedSec / PROGRESS_CAP_SEC) * 100);

  return (
    <section className="results">
      <header className="results__header">
        <div>
          {job.matched_title && <h2>Showing results for <strong>{job.matched_title}</strong></h2>}
          {job.did_you_mean?.length ? (
            <p className="did-you-mean">Did you mean{" "}
              {job.did_you_mean.map((t) => (
                <button key={t} className="chip" disabled={locked} title={locked ? LOCKED_NOTE : undefined}
                  onClick={() => onPickTitle(t)}>{t}</button>
              ))}
            </p>
          ) : null}
          {job.message && <p className={`results__message results__message--${job.state}`}>{job.message}</p>}
        </div>
        <div className="results__meta">
          {!running && <span className="results__elapsed">Done in {elapsedSec}s</span>}
          <button className="btn" onClick={onNewSearch} disabled={locked} title={locked ? LOCKED_NOTE : undefined}>New search</button>
        </div>
      </header>

      {running && (
        <div className="search-progress" role="status">
          <div className="search-progress__track"><div className="search-progress__bar" style={{ width: `${pct}%` }} /></div>
          <p className="search-progress__text">
            Searching {job.sources.map((s) => sourceName(s.name)).join(", ") || "theaters"}… <span>{elapsedSec}s</span>
          </p>
        </div>
      )}

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

      {theaters.size > 0 && (
        <div className="listing">
          <div className="listing__head" aria-hidden>
            <span>Movie Theater Spot</span>
            <span>Showtimes</span>
          </div>
          {[...theaters.entries()].map(([name, times]) => {
            const { chain, distance_mi } = times[0];
            const badge = badgeText(chain, name);
            return (
              <article key={name} className="theater">
                <div className={`theater__badge theater__badge--${badge.length <= 3 ? "lg" : badge.length <= 5 ? "md" : "sm"}`} aria-hidden>
                  {badge}
                </div>
                <div className="theater__info">
                  <h3>{name}</h3>
                  <p>{chain}{distance_mi != null ? ` · ${distance_mi} miles away` : ""}</p>
                </div>
                <div className="theater__times">
                  {times.map((s) => {
                    const sold = s.status === "sold_out";
                    const blocked = s.bookable && locked;
                    return (
                      <button
                        key={s.id}
                        className={`time-chip${s.bookable ? " time-chip--bookable" : " time-chip--external"}${sold ? " time-chip--sold" : ""}`}
                        disabled={sold || blocked}
                        title={sold ? "Sold out" : blocked ? LOCKED_NOTE : s.bookable ? "Book with the agent" : "Opens the theater site in a new tab"}
                        onClick={() => (s.bookable ? onBook(s) : onOpenExternal(s))}
                      >
                        <span className="time-chip__time">{clock(s.start)}</span>
                        <span className="time-chip__format">{sold ? "Sold out" : s.format || "Standard"}</span>
                        {!s.bookable && !sold && <span className="time-chip__ext" aria-label="opens theater site">↗</span>}
                      </button>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
