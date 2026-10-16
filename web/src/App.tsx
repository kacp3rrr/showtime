// Screen state machine (search → results → booking), API calls and polling. Components stay pure.
// Layout: top search bar · left panel (placeholder / results / live view) · right panel (booking card).
import { useEffect, useState } from "react";
import type { BookingJob, BookingRequest, SearchJob, SearchRequest, Showtime } from "../../shared/types";
import { api, ApiError } from "./api";
import { usePoll } from "./usePoll";
import { BookingPanel, LiveView } from "./components/BookingView";
import { ResultsGrid } from "./components/ResultsGrid";
import { SearchForm, type SeatPref } from "./components/SearchForm";

type Results = { searchId: string; req: SearchRequest; seatPref: SeatPref; startedAt: number };
type Screen =
  | { name: "search" }
  | ({ name: "results" } & Results)
  // view: the left panel shows the live browser, or the listings while the booking card keeps polling.
  | { name: "booking"; bookingId: string; showtime: Showtime; results: Results; view: "live" | "results" };

type Banner = { message: string; retry?: () => void };

const searchDone = (j: SearchJob) => j.state !== "running";
// handoff / needs_user keep polling: seats + subtotal can land after the guard trips, and Continue resumes.
const bookingDone = (j: BookingJob) => j.state === "sold_out" || j.state === "failed" || j.state === "cancelled";

const DEMO = new URLSearchParams(window.location.search).get("demo") === "1"
  ? { movie: "Street Fighter", zip: "10018", seat_pref: "pick" as const } : undefined;

function Logo() {
  // Film reel: outer ring, hub, five sprocket holes.
  const holes = [0, 72, 144, 216, 288].map((deg) => {
    const r = (deg - 90) * (Math.PI / 180);
    return { cx: 24 + 10.5 * Math.cos(r), cy: 24 + 10.5 * Math.sin(r) };
  });
  return (
    <svg className="logo__icon" viewBox="0 0 48 48" aria-hidden>
      <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="3.5" />
      <circle cx="24" cy="24" r="3.5" fill="currentColor" />
      {holes.map((h, i) => <circle key={i} cx={h.cx} cy={h.cy} r="4.6" fill="none" stroke="currentColor" strokeWidth="3" />)}
    </svg>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "search" });
  const [lastSearch, setLastSearch] = useState<{ req: SearchRequest; seatPref: SeatPref }>();
  const [formKey, setFormKey] = useState(0); // bump to re-seed the search bar (e.g. after a did-you-mean pick)
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The results shown in the left panel: the results screen, or the listings behind a booking.
  const shownResults = screen.name === "results" ? screen
    : screen.name === "booking" && screen.view === "results" ? screen.results : null;
  const search = usePoll<SearchJob>(shownResults ? `/api/search/${shownResults.searchId}` : null, searchDone);
  const booking = usePoll<BookingJob>(screen.name === "booking" ? `/api/book/${screen.bookingId}` : null, bookingDone);

  // A booking that hasn't ended locks searching and new bookings (Cancel stays available).
  const locked = screen.name === "booking" && !(booking.data && bookingDone(booking.data));

  // Plain function declarations (not useCallback): each passes itself as its own Retry.
  /** Run a POST; network/5xx failures get a Retry banner, 400s just show their message. */
  async function call<T>(fn: () => Promise<T>, retry: () => void): Promise<T | undefined> {
    setBanner(null);
    try {
      return await fn();
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, String(err));
      setBanner({ message: e.message, retry: e.retryable ? retry : undefined });
      return undefined;
    }
  }

  async function startSearch(req: SearchRequest, seatPref: SeatPref) {
    setBusy(true);
    setLastSearch({ req, seatPref });
    const res = await call(() => api<{ search_id: string }>("/api/search", req), () => startSearch(req, seatPref));
    setBusy(false);
    if (res) setScreen({ name: "results", searchId: res.search_id, req, seatPref, startedAt: Date.now() });
  }

  async function book(showtime: Showtime, results: Results) {
    const body: BookingRequest = { showtime_id: showtime.id, party_size: results.req.party_size, seat_pref: results.seatPref };
    const res = await call(() => api<{ booking_id: string }>("/api/book", body), () => book(showtime, results));
    if (res) setScreen({ name: "booking", bookingId: res.booking_id, showtime, results, view: "live" });
  }

  async function bookingAction(bookingId: string, action: "cancel" | "continue") {
    const ok = await call(() => api(`/api/book/${bookingId}/${action}`, {}), () => bookingAction(bookingId, action));
    if (ok) booking.restart();
  }

  // Results clock; stops once the search settles.
  const searching = shownResults != null && search.data?.state !== "done" && search.data?.state !== "failed";
  useEffect(() => {
    if (!searching) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [searching]);

  // Polling failures (server down or restarted) also get the retry banner.
  const pollError = screen.name === "booking" ? booking.error ?? (shownResults ? search.error : null)
    : shownResults ? search.error : null;
  const shown: Banner | null = banner ?? (pollError ? {
    message: pollError.status === 404 ? "The server lost this job (restarted?)." : pollError.message,
    retry: pollError === booking.error ? booking.restart : search.restart,
  } : null);

  const toSearch = () => { if (!locked) setScreen({ name: "search" }); };

  const results = shownResults && (search.data ? (
    <ResultsGrid
      job={search.data}
      elapsedSec={Math.max(0, Math.round((now - shownResults.startedAt) / 1000))}
      locked={locked}
      onBook={(s) => book(s, shownResults)}
      onOpenExternal={(s) => s.booking_url && window.open(s.booking_url, "_blank", "noopener,noreferrer")}
      onPickTitle={(title) => { setFormKey((k) => k + 1); startSearch({ ...shownResults.req, movie: title }, shownResults.seatPref); }}
      onNewSearch={toSearch}
    />
  ) : <p className="loading">Starting search…</p>);

  return (
    <div className="app">
      <header className="topbar">
        <button className="logo" onClick={toSearch} aria-label="Showtime: new search" title={locked ? "Finish or cancel the booking first" : "New search"}>
          <Logo />
        </button>
        <h1 className="sr-only">Showtime</h1>
        <SearchForm
          key={formKey}
          initial={lastSearch ? { ...lastSearch.req, seat_pref: lastSearch.seatPref } : DEMO}
          busy={busy}
          locked={locked}
          onSubmit={startSearch}
        />
      </header>

      {shown && (
        <div className="banner banner--error" role="alert">
          <span>{shown.message}</span>
          {shown.retry && <button className="btn" onClick={() => { setBanner(null); shown.retry!(); }}>Retry</button>}
          {!shown.retry && <button className="btn" onClick={() => setBanner(null)}>Dismiss</button>}
        </div>
      )}

      <main className="layout">
        <section className={`panel panel--left${screen.name === "booking" && screen.view === "live" ? " panel--live" : ""}`}>
          {screen.name === "search" && (
            <div className="placeholder">Enter a movie and zip to see showtimes</div>
          )}

          {screen.name === "results" && results}

          {screen.name === "booking" && (
            <>
              <nav className="panel__nav">
                {screen.view === "live"
                  ? <button className="link" onClick={() => setScreen({ ...screen, view: "results" })}>← Back to results</button>
                  : <button className="link" onClick={() => setScreen({ ...screen, view: "live" })}>Show live view →</button>}
              </nav>
              {screen.view === "live"
                ? (booking.data ? <LiveView job={booking.data} /> : <div className="live live--empty">Starting the browser…</div>)
                : results}
            </>
          )}
        </section>

        <section className="panel panel--right">
          {screen.name === "booking" ? (booking.data ? (
            <BookingPanel
              job={booking.data}
              showtime={screen.showtime}
              onCancel={() => bookingAction(screen.bookingId, "cancel")}
              onContinue={() => bookingAction(screen.bookingId, "continue")}
              onBack={() => setScreen({ name: "results", ...screen.results })}
            />
          ) : <div className="idle-card">Starting booking…</div>) : (
            <div className="idle-card">Pick a showtime and the agent will book it.</div>
          )}
        </section>
      </main>
    </div>
  );
}
