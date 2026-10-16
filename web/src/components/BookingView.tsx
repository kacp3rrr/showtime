// Skeleton: pure booking screen, no fetching. Lane B restyles from the mockups.
import { useEffect, useState } from "react";
import type { BookingJob, BookingState, Showtime } from "../../../shared/types";
import { clock, money } from "../format";

export type BookingViewProps = {
  job: BookingJob;
  showtime: Showtime;
  onCancel: () => void;
  onContinue: () => void;
  onBack: () => void;
};

const STEPS: { label: string; states: BookingState[] }[] = [
  { label: "Opening", states: ["starting", "opening"] },
  { label: "Tickets", states: ["tickets"] },
  { label: "Seats", states: ["seats"] },
  { label: "Checkout", states: ["checkout"] },
  { label: "Your turn", states: ["handoff", "needs_user"] },
];
const ENDED: BookingState[] = ["sold_out", "failed", "cancelled"];

function useCountdown(iso?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  const left = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

export function BookingView({ job, showtime, onCancel, onContinue, onBack }: BookingViewProps) {
  const ended = ENDED.includes(job.state);
  const current = STEPS.findIndex((s) => s.states.includes(job.state));
  const hold = useCountdown(ended ? undefined : job.hold_expires_at);

  return (
    <section className="booking">
      <div className="booking__live">
        {job.live_view_url ? (
          <div className={`live${job.interactive ? " live--interactive" : ""}`}>
            <iframe
              src={job.live_view_url}
              title="Live browser"
              sandbox="allow-same-origin allow-scripts"
              allow="clipboard-read; clipboard-write"
              style={{ pointerEvents: job.interactive ? "auto" : "none" }}
            />
            {!job.interactive && !ended && <div className="live__overlay">Agent is driving</div>}
          </div>
        ) : (
          <div className="live live--empty">{ended ? "Browser closed" : "Starting the browser…"}</div>
        )}
      </div>

      <aside className="booking__panel">
        <h2>{showtime.movie_title}</h2>
        <p className="booking__showtime">{showtime.theater_name} · {clock(showtime.start)} · {showtime.format}</p>

        {job.state === "handoff" && <div className="banner banner--go">Your turn — finish payment in the window</div>}
        {job.state === "needs_user" && (
          <div className="banner banner--go">
            {job.message ?? "Sign in here, then press Continue"}
            <button className="btn btn--primary" onClick={onContinue}>Continue</button>
          </div>
        )}
        {(job.state === "failed" || job.state === "sold_out") && (
          <div className="banner banner--bad">
            <p>{job.message ?? (job.state === "sold_out" ? "This showing is sold out." : "The agent couldn't finish.")}</p>
            {job.fallback_url && <a href={job.fallback_url} target="_blank" rel="noopener noreferrer">Finish on the theater site ↗</a>}
            <button className="btn" onClick={onBack}>Try next showtime</button>
          </div>
        )}
        {job.state === "cancelled" && <div className="banner">{job.message ?? "Booking cancelled."}</div>}

        {!ended && (
          <ol className="stepper">
            {STEPS.map((s, i) => (
              <li key={s.label} className={i < current ? "done" : i === current ? "current" : ""}>{s.label}</li>
            ))}
          </ol>
        )}

        {(job.seats?.length || job.subtotal != null || hold) && (
          <dl className="booking__facts">
            {job.seats?.length ? <><dt>Seats</dt><dd>{job.seats.join(", ")}</dd></> : null}
            {job.subtotal != null && <><dt>Subtotal</dt><dd>{money(job.subtotal)}</dd></>}
            {hold && <><dt>Hold</dt><dd>{hold}</dd></>}
          </dl>
        )}

        <ol className="steps-log">
          {job.steps.map((s, i) => (
            <li key={i}><time>{new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time> {s.text}</li>
          ))}
        </ol>

        <div className="booking__actions">
          {!ended ? <button className="btn btn--danger" onClick={onCancel}>Cancel</button>
            : <button className="btn" onClick={onBack}>Back to results</button>}
        </div>
      </aside>
    </section>
  );
}
