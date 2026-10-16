// In-memory job state. The route layer owns these maps; finder/booker/mock mutate the job objects.
import { createHash, randomUUID } from "node:crypto";
import type { BookingJob, SearchJob, Showtime } from "../../shared/types.js";

export const searches = new Map<string, SearchJob>();
export const bookings = new Map<string, BookingJob>();
const showtimesById = new Map<string, Showtime>();

export const newId = (prefix: "s" | "b") => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Stable showtime id: hash of the given parts (contract: theater_name + start). */
export const showtimeId = (...parts: string[]) =>
  createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);

export function createSearchJob(sources: string[]): SearchJob {
  const job: SearchJob = {
    search_id: newId("s"),
    state: "running",
    showtimes: [],
    sources: sources.map((name) => ({ name, state: "running" })),
  };
  searches.set(job.search_id, job);
  return job;
}

export function createBookingJob(): BookingJob {
  const job: BookingJob = { booking_id: newId("b"), state: "starting", interactive: false, steps: [] };
  bookings.set(job.booking_id, job);
  return job;
}

/** Look up a showtime by id. Search jobs grow as sources finish, so fall back to scanning them. */
export function findShowtime(id: string): Showtime | undefined {
  const hit = showtimesById.get(id);
  if (hit) return hit;
  for (const job of searches.values()) {
    for (const s of job.showtimes) showtimesById.set(s.id, s);
  }
  return showtimesById.get(id);
}

export const pushStep = (job: BookingJob, text: string) =>
  job.steps.push({ at: new Date().toISOString(), text });
