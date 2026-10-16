import { Router, type Response } from "express";
import { z } from "zod";
import type { BookingJob, BookingRequest, SearchJob, SearchRequest } from "../../shared/types.js";
import { env } from "./env.js";
import { tracingEnabled } from "./trace/index.js";
import { bookings, createBookingJob, createSearchJob, findShowtime, pushStep, searches } from "./jobs.js";
import { runSearch } from "./finder/index.js";
import { runBooking, cancelBooking, continueBooking } from "./booker/index.js";
import { mockSearch } from "./mock/search.js";
import { mockBooking, mockCancel, mockContinue } from "./mock/booking.js";

const NYC_ZIP = /^(10[0-4]|11[0-4]|116)\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDateWindow = (date: string) => {
  const today = new Date();
  const max = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14);
  return date >= localDate(today) && date <= localDate(max);
};

const SearchBody = z.object({
  movie: z.string().trim().min(1, "movie is required").max(120),
  zip: z.string().regex(/^\d{5}$/, "zip must be 5 digits")
    .regex(NYC_ZIP, "zip must be an NYC zip (100xx–104xx, 110xx–114xx, 116xx)"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .refine(inDateWindow, "date must be between today and 14 days from now"),
  party_size: z.number().int().min(1).max(6),
  time_from: z.string().regex(HHMM, "time_from must be HH:MM").optional(),
  time_to: z.string().regex(HHMM, "time_to must be HH:MM").optional(),
  format: z.enum(["any", "imax", "dolby", "standard"]).optional(),
});

const BookingBody = z.object({
  showtime_id: z.string().min(1).max(64),
  party_size: z.number().int().min(1).max(6),
  seat_pref: z.enum(["center", "aisle", "any", "pick"]),
});

const bad = (res: Response, error: string, status = 400) => void res.status(status).json({ error });
const firstIssue = (e: z.ZodError) => {
  const i = e.issues[0];
  return i ? `${i.path.join(".") || "body"}: ${i.message}` : "invalid body";
};
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Starts work without awaiting it; any throw marks the job failed instead of crashing. */
const start = (work: () => Promise<void>, onError: (err: unknown) => void) => {
  Promise.resolve().then(work).catch(onError);
};

function failSearch(job: SearchJob, err: unknown) {
  console.error(`[search ${job.search_id}] failed:`, errText(err));
  job.state = "failed";
  job.message = `Search failed: ${errText(err)}`;
  for (const s of job.sources) if (s.state === "running") s.state = "error";
}

function failBooking(job: BookingJob, fallbackUrl: string | undefined, err: unknown) {
  console.error(`[booking ${job.booking_id}] failed:`, errText(err));
  job.state = "failed";
  job.interactive = false;
  job.fallback_url ??= fallbackUrl;
  job.message = `Booking failed: ${errText(err)}`;
  pushStep(job, "Agent stopped with an error");
}

export const api = Router();

api.get("/api/health", (_req, res) => {
  res.json({
    ok: true, mock: env.MOCK, sources: env.SEARCH_SOURCES, book_chain: env.BOOK_CHAIN,
    tracing: tracingEnabled, arize_project: tracingEnabled ? env.ARIZE_PROJECT : undefined,
  });
});

api.post("/api/search", (req, res) => {
  const parsed = SearchBody.safeParse(req.body);
  if (!parsed.success) return bad(res, firstIssue(parsed.error));
  const body: SearchRequest = parsed.data;
  const job = createSearchJob(env.SEARCH_SOURCES);
  start(() => (env.MOCK ? mockSearch(body, job) : runSearch(body, job)), (err) => failSearch(job, err));
  res.json({ search_id: job.search_id });
});

api.get("/api/search/:id", (req, res) => {
  const job = searches.get(req.params.id);
  if (!job) return bad(res, "unknown search_id", 404);
  res.json(job);
});

api.post("/api/book", (req, res) => {
  const parsed = BookingBody.safeParse(req.body);
  if (!parsed.success) return bad(res, firstIssue(parsed.error));
  const body: BookingRequest = parsed.data;
  const showtime = findShowtime(body.showtime_id);
  if (!showtime) return bad(res, "unknown showtime_id (run a search first)");
  if (showtime.status === "sold_out") return bad(res, "that showtime is sold out");
  if (!showtime.bookable) return bad(res, "that showtime is not bookable here; open its booking_url instead");
  const job = createBookingJob();
  start(
    () => (env.MOCK ? mockBooking(body, showtime, job) : runBooking(body, showtime, job)),
    (err) => failBooking(job, showtime.booking_url, err),
  );
  res.json({ booking_id: job.booking_id });
});

api.get("/api/book/:id", (req, res) => {
  const job = bookings.get(req.params.id);
  if (!job) return bad(res, "unknown booking_id", 404);
  res.json(job);
});

api.post("/api/book/:id/cancel", async (req, res) => {
  const job = bookings.get(req.params.id);
  if (!job) return bad(res, "unknown booking_id", 404);
  if (job.state === "cancelled") return void res.json({ ok: true });
  try {
    if (env.MOCK) mockCancel(job);
    else await cancelBooking(job);
  } catch (err) {
    console.error(`[booking ${job.booking_id}] cancel failed:`, errText(err));
    return bad(res, "cancel failed", 500);
  }
  res.json({ ok: true });
});

api.post("/api/book/:id/continue", (req, res) => {
  const job = bookings.get(req.params.id);
  if (!job) return bad(res, "unknown booking_id", 404);
  if (job.state !== "needs_user") return bad(res, `can only continue from needs_user (state is ${job.state})`);
  const fallback = job.fallback_url;
  start(() => (env.MOCK ? mockContinue(job) : continueBooking(job)), (err) => failBooking(job, fallback, err));
  res.json({ ok: true });
});
