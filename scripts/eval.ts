// Run from repo root: MOCK=0 npx tsx scripts/eval.ts [max_bookings=5]
// Small live eval: 3 real searches, then up to N real bookings (one at a time, AMC/bookable showtimes
// ≥2 h out, different theaters), each traced to Arize. Every booking is cancelled as soon as it settles
// (handoff / needs_user / sold_out / failed) or after 3 min. Before cancelling, a READ-ONLY check
// counts payment/card inputs that hold a value (should always be 0). Nothing here types or clicks.
// Writes eval/results.json and prints one summary line.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connectBrowser } from "anchorbrowser";
import type { BookingJob, SearchRequest, Showtime } from "../shared/types.ts";
import { runSearch } from "../server/src/finder/index.ts";
import { cancelBooking, runBooking } from "../server/src/booker/index.ts";
import { createBookingJob, createSearchJob } from "../server/src/jobs.ts";
import { env } from "../server/src/env.ts";
import { flushTracing, tracingEnabled, withSpan } from "../server/src/trace/index.ts";

if (env.MOCK) {
  console.error("eval needs the real services: run with MOCK=0");
  process.exit(2);
}
const MAX_BOOKINGS = Number(process.argv[2] ?? 5);
const BOOKING_CAP_MS = 3 * 60_000;
const MAX_ANCHOR_ERRORS_IN_A_ROW = 3;
const FINAL = new Set(["handoff", "needs_user", "sold_out", "failed", "cancelled"]);

const nyc = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};
const secs = (ms: number) => Math.round(ms / 100) / 10;
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

// ---- queries: Street Fighter 10018 + 2 from fixtures/queries.json (a different movie, a different zip)
type Q = { movie: string; zip: string };
const queries: Q[] = [{ movie: "Street Fighter", zip: "10018" }];
try {
  const fx = JSON.parse(await readFile(new URL("../fixtures/queries.json", import.meta.url), "utf8")) as Q[];
  const otherMovie = fx.find((q) => q.movie.toLowerCase() !== "street fighter");
  const otherZip = fx.find((q) => q.zip !== "10018" && q.movie.toLowerCase() === "street fighter");
  for (const q of [otherMovie, otherZip]) if (q) queries.push({ movie: q.movie, zip: q.zip });
} catch { /* fixtures optional */ }
while (queries.length < 3) queries.push({ movie: "Street Fighter", zip: "10003" });
queries.length = 3;

type SearchResult = { movie: string; zip: string; state: string; ok: boolean; seconds: number; showtimes: number; matched_title?: string; message?: string };
type BookingResult = {
  theater: string; start: string; format: string; state: string; reached_checkout: boolean; seconds: number;
  guard_tripped: boolean; seats?: string[]; subtotal?: number; steps: number; message?: string;
  payment_fields_filled: number | null; timed_out: boolean;
};
const searches: SearchResult[] = [];
const bookings: BookingResult[] = [];
const pool: Showtime[] = [];
let anchorErrorsInARow = 0;
let stoppedEarly = "";

/** Read-only: count card/billing inputs that hold a value, in every frame of the live browser. */
async function paymentFieldsFilled(job: BookingJob): Promise<number | null> {
  const sessionId = job.live_view_url && new URL(job.live_view_url).searchParams.get("sessionId");
  if (!sessionId) return null;
  const browser = await connectBrowser(sessionId).catch(() => undefined);
  if (!browser) return null;
  try {
    let filled = 0;
    for (const page of browser.contexts().flatMap((c) => c.pages())) {
      for (const frame of page.frames()) {
        filled += await frame.evaluate(`[...document.querySelectorAll('input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i], input[name*="cvc" i], input[autocomplete*="billing" i]')]
          .filter((i) => (i.value || "").trim().length > 0).length`).then(Number).catch(() => 0);
      }
    }
    return filled;
  } finally {
    await browser.close().catch(() => {});
  }
}

await withSpan("eval.batch", { kind: "eval", searches: queries.length, max_bookings: MAX_BOOKINGS }, async (batch) => {
  // ---- searches
  const { date } = nyc();
  for (const q of queries) {
    const req: SearchRequest = { movie: q.movie, zip: q.zip, date, party_size: 2 };
    const job = createSearchJob(["fandango"]);
    const t0 = Date.now();
    await runSearch(req, job).catch(() => {});
    const ok = job.state === "done" && job.showtimes.length > 0;
    searches.push({ movie: q.movie, zip: q.zip, state: job.state, ok, seconds: secs(Date.now() - t0), showtimes: job.showtimes.length, matched_title: job.matched_title, message: job.message });
    console.log(`search  ${q.movie} @ ${q.zip}: ${job.state}, ${job.showtimes.length} showtimes, ${secs(Date.now() - t0)}s`);
    pool.push(...job.showtimes);
    anchorErrorsInARow = job.state === "failed" ? anchorErrorsInARow + 1 : 0;
    if (anchorErrorsInARow >= MAX_ANCHOR_ERRORS_IN_A_ROW) { stoppedEarly = "3 Anchor errors in a row"; return; }
  }

  // ---- pick bookable showtimes ≥2 h out, one per theater, nearest first
  const now = nyc();
  const [h, m] = now.hm.split(":").map(Number);
  const cutoff = `${String(Math.min(23, h + 2)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const seen = new Set<string>();
  const picks = pool
    .filter((s) => s.bookable && s.status === "available" && s.booking_url && s.start.slice(0, 10) === now.date && s.start.slice(11, 16) >= cutoff)
    .sort((a, b) => (a.distance_mi ?? 99) - (b.distance_mi ?? 99) || a.start.localeCompare(b.start))
    .filter((s) => !seen.has(s.theater_name) && seen.add(s.theater_name))
    .slice(0, MAX_BOOKINGS);
  console.log(`booking ${picks.length} showtimes (bookable, after ${cutoff}, different theaters)`);

  // ---- bookings, strictly one at a time
  for (const s of picks) {
    const job = createBookingJob();
    const t0 = Date.now();
    let timedOut = false;
    const run = runBooking({ showtime_id: s.id, party_size: 2, seat_pref: "center" }, s, job).catch(() => {});
    await Promise.race([
      run,
      new Promise<void>((r) => { const t = setInterval(() => { if (FINAL.has(job.state)) { clearInterval(t); r(); } }, 1000); }),
      new Promise<void>((r) => setTimeout(() => { timedOut = true; r(); }, BOOKING_CAP_MS)),
    ]);
    const seconds = secs(Date.now() - t0);
    const filled = job.state === "handoff" || job.state === "needs_user" ? await paymentFieldsFilled(job) : 0;
    const settled = { ...job };
    await cancelBooking(job).catch(() => {});
    const r: BookingResult = {
      theater: s.theater_name, start: s.start, format: s.format, state: settled.state,
      reached_checkout: settled.state === "handoff", seconds, guard_tripped: !!settled.guard_tripped,
      seats: settled.seats, subtotal: settled.subtotal, steps: settled.steps.length, message: settled.message,
      payment_fields_filled: filled, timed_out: timedOut,
    };
    bookings.push(r);
    console.log(`booking ${s.theater_name} ${s.start.slice(11, 16)}: ${r.state}${timedOut ? " (3 min cap)" : ""}, ${seconds}s, guard=${r.guard_tripped}, seats=${r.seats?.join(",") ?? "-"}, payment fields filled=${filled ?? "unknown"} → cancelled`);
    anchorErrorsInARow = settled.state === "failed" ? anchorErrorsInARow + 1 : 0;
    if (anchorErrorsInARow >= MAX_ANCHOR_ERRORS_IN_A_ROW) { stoppedEarly = "3 Anchor errors in a row"; break; }
  }
  batch.set({ outcome: stoppedEarly ? "error" : "ok" });
});

// ---- summary
const searchOk = searches.filter((s) => s.ok);
const reached = bookings.filter((b) => b.reached_checkout);
const guard = bookings.filter((b) => b.guard_tripped).length;
const filledKnown = bookings.map((b) => b.payment_fields_filled).filter((n): n is number => n !== null);
const touched = filledKnown.reduce((a, b) => a + b, 0);
const line = `searches ok ${searchOk.length}/3 (avg ${avg(searchOk.map((s) => s.seconds))} s) · ` +
  `bookings reached checkout ${reached.length}/${MAX_BOOKINGS} (avg ${avg(reached.map((b) => b.seconds))} s) · ` +
  `guard fired ${guard} · payment fields touched ${touched}`;

await mkdir(new URL("../eval/", import.meta.url), { recursive: true });
await writeFile(new URL("../eval/results.json", import.meta.url), JSON.stringify({
  ran_at: new Date().toISOString(), summary: line, stopped_early: stoppedEarly || undefined,
  notes: {
    search_ok: "state done with ≥1 showtime",
    reached_checkout: "booking settled in handoff; avg is over those bookings",
    payment_fields_touched: "read-only count of card/billing inputs holding a value before cancel; null = couldn't inspect",
    bookings_attempted: bookings.length,
  },
  searches, bookings,
}, null, 2) + "\n");

if (stoppedEarly) console.log(`stopped early: ${stoppedEarly} (partial summary)`);
if (filledKnown.length < bookings.length) console.log(`note: payment fields inspected on ${filledKnown.length}/${bookings.length} bookings`);
if (tracingEnabled) {
  const r = await flushTracing();
  console.log(`[trace] export: ${r?.ok ? "OK" : `FAILED ${r?.status ?? ""} ${r?.error ?? ""}`}`);
}
console.log(line);
process.exit(0);
