// Screen state machine (search → results → booking), API calls and polling. Components stay pure.
import { useEffect, useState } from "react";
import type { BookingJob, BookingRequest, SearchJob, SearchRequest, Showtime } from "../../shared/types";
import { api, ApiError } from "./api";
import { usePoll } from "./usePoll";
import { BookingView } from "./components/BookingView";
import { ResultsGrid } from "./components/ResultsGrid";
import { SearchForm, type SeatPref } from "./components/SearchForm";

type Results = { searchId: string; req: SearchRequest; seatPref: SeatPref; startedAt: number };
type Screen =
  | { name: "search" }
  | ({ name: "results" } & Results)
  | { name: "booking"; bookingId: string; showtime: Showtime; results: Results };

type Banner = { message: string; retry?: () => void };

const searchDone = (j: SearchJob) => j.state !== "running";
// handoff / needs_user keep polling: seats + subtotal can land after the guard trips, and Continue resumes.
const bookingDone = (j: BookingJob) => j.state === "sold_out" || j.state === "failed" || j.state === "cancelled";

const DEMO = new URLSearchParams(window.location.search).get("demo") === "1"
  ? { movie: "Street Fighter", zip: "10018", seat_pref: "pick" as const } : undefined;

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "search" });
  const [lastSearch, setLastSearch] = useState<{ req: SearchRequest; seatPref: SeatPref }>();
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const search = usePoll<SearchJob>(screen.name === "results" ? `/api/search/${screen.searchId}` : null, searchDone);
  const booking = usePoll<BookingJob>(screen.name === "booking" ? `/api/book/${screen.bookingId}` : null, bookingDone);

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
    if (res) setScreen({ name: "booking", bookingId: res.booking_id, showtime, results });
  }

  async function bookingAction(bookingId: string, action: "cancel" | "continue") {
    const ok = await call(() => api(`/api/book/${bookingId}/${action}`, {}), () => bookingAction(bookingId, action));
    if (ok) booking.restart();
  }

  // Results-screen clock; stops once the search settles.
  const searching = screen.name === "results" && search.data?.state !== "done" && search.data?.state !== "failed";
  useEffect(() => {
    if (!searching) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [searching]);

  // Polling failures (server down or restarted) also get the retry banner.
  const pollError = screen.name === "results" ? search.error : screen.name === "booking" ? booking.error : null;
  const shown: Banner | null = banner ?? (pollError ? {
    message: pollError.status === 404 ? "The server lost this job (restarted?)." : pollError.message,
    retry: screen.name === "results" ? search.restart : booking.restart,
  } : null);

  return (
    <div className="app">
      <header className="app__header">
        <h1 onClick={() => setScreen({ name: "search" })}>Showtime</h1>
        {screen.name === "booking" && <span className="app__crumb">Booking</span>}
      </header>

      {shown && (
        <div className="banner banner--error" role="alert">
          <span>{shown.message}</span>
          {shown.retry && <button className="btn" onClick={() => { setBanner(null); shown.retry!(); }}>Retry</button>}
          {!shown.retry && <button className="btn" onClick={() => setBanner(null)}>Dismiss</button>}
        </div>
      )}

      <main>
        {screen.name === "search" && (
          <SearchForm
            initial={lastSearch ? { ...lastSearch.req, seat_pref: lastSearch.seatPref } : DEMO}
            busy={busy}
            onSubmit={startSearch}
          />
        )}

        {screen.name === "results" && (search.data ? (
          <ResultsGrid
            job={search.data}
            elapsedSec={Math.max(0, Math.round((now - screen.startedAt) / 1000))}
            onBook={(s) => book(s, screen)}
            onOpenExternal={(s) => s.booking_url && window.open(s.booking_url, "_blank", "noopener,noreferrer")}
            onPickTitle={(title) => startSearch({ ...screen.req, movie: title }, screen.seatPref)}
            onNewSearch={() => setScreen({ name: "search" })}
          />
        ) : <p className="loading">Starting search…</p>)}

        {screen.name === "booking" && (booking.data ? (
          <BookingView
            job={booking.data}
            showtime={screen.showtime}
            onCancel={() => bookingAction(screen.bookingId, "cancel")}
            onContinue={() => bookingAction(screen.bookingId, "continue")}
            onBack={() => setScreen({ name: "results", ...screen.results })}
          />
        ) : <p className="loading">Starting booking…</p>)}
      </main>
    </div>
  );
}
