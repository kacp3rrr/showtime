// Run from repo root: MOCK=0 npx tsx --env-file=.env scripts/run-booking.ts "<booking url>"
// Drives the real Booker (server/src/booker) on one URL, outside the server: prints each state change
// and step as it happens, then the final job JSON. After handoff/needs_user the session stays open
// for 3 min (pay or inspect in the live view), then is cancelled. Ctrl-C ends the session too.
import type { BookingJob, BookingRequest, Showtime } from "../shared/types.js";
import { cancelBooking, runBooking } from "../server/src/booker/index.js";
import { createBookingJob } from "../server/src/jobs.js";

const url = process.argv[2];
if (!url || !/^https?:\/\//i.test(url)) {
  console.error('usage: MOCK=0 npx tsx --env-file=.env scripts/run-booking.ts "<booking url>"');
  process.exit(1);
}

const showtime: Showtime = {
  id: "spike0000000",
  theater_name: "Test Theater",
  chain: "amc",
  movie_title: "Test Movie",
  start: new Date().toISOString().slice(0, 19),
  format: "Standard",
  booking_url: url,
  status: "available",
  bookable: true,
};
const req: BookingRequest = { showtime_id: showtime.id, party_size: 2, seat_pref: "center" };
const job: BookingJob = createBookingJob();

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
let lastState = "";
let stepsShown = 0;
const show = () => {
  if (job.state !== lastState) {
    console.log(`${secs()}s  STATE ${lastState || "-"} → ${job.state}  interactive=${job.interactive}`);
    if (job.live_view_url && !lastState) console.log(`         live view: ${job.live_view_url}`);
    lastState = job.state;
  }
  for (; stepsShown < job.steps.length; stepsShown++) console.log(`${secs()}s  step  ${job.steps[stepsShown].text}`);
};
const poll = setInterval(show, 250);

await runBooking(req, showtime, job);
show();
clearInterval(poll);
console.log(`\nfinal job after ${secs().trim()}s:\n${JSON.stringify(job, null, 2)}`);

if (job.state === "handoff" || job.state === "needs_user") {
  console.log(`\nsession open for 3 min: ${job.live_view_url}  (Ctrl-C ends it now)`);
  await new Promise((r) => setTimeout(r, 3 * 60_000));
  await cancelBooking(job);
}
process.exit(0);
