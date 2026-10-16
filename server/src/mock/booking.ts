// Mock Booker: walks starting→opening→tickets→seats→checkout→handoff over ~20 s using
// fixtures/booking_states.json. Movie "sold" → ends sold_out after tickets; "login" → needs_user at
// checkout, and Continue resumes to handoff. Never touches the network.
import type { BookingJob, BookingRequest, BookingState, Showtime } from "../../../shared/types.js";
import { pushStep } from "../jobs.js";
import { bookingFixtures } from "./fixtures.js";

const MAIN: BookingState[] = ["starting", "opening", "tickets", "seats", "checkout", "handoff"];
const AT_MS: Record<string, number> = { starting: 0, opening: 2000, tickets: 6000, seats: 10000, checkout: 15000, handoff: 20000 };

type Ctx = { showtime: Showtime; seats: string[]; subtotal: number; timers: NodeJS.Timeout[] };
const ctxs = new Map<string, Ctx>();

/** Steps a state adds on top of the previous main-path state (or, for branch states, the whole main path). */
function ownSteps(state: BookingState): string[] {
  const texts = (s: BookingState) => bookingFixtures[s].steps.map((x) => x.text);
  const i = MAIN.indexOf(state);
  const before = new Set(i > 0 ? texts(MAIN[i - 1]) : i === 0 ? [] : MAIN.flatMap(texts));
  return texts(state).filter((t) => !before.has(t));
}

const clock = (iso: string) => {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/** Fixture text is written for 2 seats, Street Fighter 7:30 PM at AMC Empire 25; adapt it to this booking. */
const personalize = (text: string, c: Ctx) =>
  text
    .replace(/Street Fighter, 7:30 PM/g, `${c.showtime.movie_title}, ${clock(c.showtime.start)}`)
    .replace(/\b2 (Adult|adjacent)/g, `${c.seats.length} $1`)
    .replace(/F7, F8/g, c.seats.join(", "))
    .replace(/\$38\.50/g, `$${c.subtotal.toFixed(2)}`)
    .replace(/AMC Empire 25/g, c.showtime.theater_name);

function clearTimers(c: Ctx) {
  c.timers.forEach(clearTimeout);
  c.timers = [];
}

function enter(job: BookingJob, state: BookingState) {
  const c = ctxs.get(job.booking_id);
  if (!c || job.state === "cancelled") return;
  const f = bookingFixtures[state];
  job.state = state;
  job.interactive = f.interactive;
  job.message = f.message;
  if (f.live_view_url) job.live_view_url = f.live_view_url;
  if (f.seats) job.seats = c.seats;
  if (f.subtotal != null) job.subtotal = c.subtotal;
  if (f.hold_expires_at) job.hold_expires_at ??= new Date(Date.now() + 10 * 60_000).toISOString();
  if (f.guard_tripped) job.guard_tripped = true;
  if (f.fallback_url) job.fallback_url = c.showtime.booking_url ?? f.fallback_url;
  for (const text of ownSteps(state)) pushStep(job, personalize(text, c));
}

function schedule(job: BookingJob, plan: [number, BookingState][]) {
  const c = ctxs.get(job.booking_id)!;
  for (const [ms, state] of plan) c.timers.push(setTimeout(() => enter(job, state), ms));
}

const pathTo = (last: BookingState) =>
  MAIN.slice(0, MAIN.indexOf(last) + 1).map((s): [number, BookingState] => [AT_MS[s], s]);

export async function mockBooking(req: BookingRequest, showtime: Showtime, job: BookingJob): Promise<void> {
  const price = showtime.price ?? 19.25;
  ctxs.set(job.booking_id, {
    showtime,
    seats: Array.from({ length: req.party_size }, (_, i) => `F${7 + i}`),
    subtotal: Math.round(price * req.party_size * 100) / 100,
    timers: [],
  });
  const flavor = showtime.movie_title.trim().toLowerCase();
  if (flavor === "sold") schedule(job, [...pathTo("tickets"), [9000, "sold_out"]]);
  else if (flavor === "login") schedule(job, [...pathTo("checkout"), [18000, "needs_user"]]);
  else schedule(job, pathTo("handoff"));
}

export async function mockContinue(job: BookingJob): Promise<void> {
  if (!ctxs.has(job.booking_id)) throw new Error("mock booking context missing");
  pushStep(job, "You signed in — agent resuming");
  job.state = "checkout";
  job.interactive = false;
  job.message = undefined;
  schedule(job, [[4000, "handoff"]]);
}

export function mockCancel(job: BookingJob): void {
  const c = ctxs.get(job.booking_id);
  if (c) {
    clearTimers(c);
    enter(job, "cancelled");
    ctxs.delete(job.booking_id);
  } else {
    job.state = "cancelled";
    job.interactive = false;
    pushStep(job, "Cancelled by you — browser session ended");
  }
}
