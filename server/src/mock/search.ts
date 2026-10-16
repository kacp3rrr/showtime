// Mock Finder: replays fixtures/search_10018.json in 3 batches over ~6 s.
// Special movies: "zzz" → not playing, "fail" → search failed. Everything else returns the fixture
// grid retitled to the query, so "sold" / "login" searches yield showtimes the mock Booker recognizes.
import type { SearchJob, SearchRequest, Showtime } from "../../../shared/types.js";
import { env } from "../env.js";
import { showtimeId } from "../jobs.js";
import { searchFixture, sleep } from "./fixtures.js";

const BATCHES = 3;
const BATCH_MS = 2000;

const hhmm = (start: string) => start.slice(11, 16);

function matchesFilters(s: Showtime, req: SearchRequest): boolean {
  const t = hhmm(s.start);
  if (req.time_from && t < req.time_from) return false;
  if (req.time_to && t > req.time_to) return false;
  switch (req.format ?? "any") {
    case "imax": return /imax/i.test(s.format);
    case "dolby": return /dolby/i.test(s.format);
    case "standard": return !/imax|dolby|4dx|screenx|rpx|70mm|3d/i.test(s.format);
    default: return true;
  }
}

export async function mockSearch(req: SearchRequest, job: SearchJob): Promise<void> {
  const t0 = Date.now();
  const q = req.movie.trim().toLowerCase();
  const fixtureTitle = searchFixture.matched_title ?? "";
  await sleep(1000);

  if (q === "fail") {
    job.sources = job.sources.map((s) => ({ ...s, state: "error", ms: Date.now() - t0, note: "mock: source failed" }));
    job.state = "failed";
    job.message = "Search failed: every source errored (mock).";
    return;
  }

  if (q === "zzz") {
    await sleep(1500);
    job.sources = job.sources.map((s) => ({ ...s, state: "ok", ms: Date.now() - t0 }));
    job.state = "done";
    job.message = `"${req.movie.trim()}" isn't playing near ${req.zip} on ${req.date}.`;
    return;
  }

  const fx = fixtureTitle.toLowerCase();
  const title = fx && (fx.includes(q) || q.includes(fx)) ? fixtureTitle : req.movie.trim();
  job.matched_title = title;

  const all = searchFixture.showtimes
    .map((s): Showtime => {
      const start = `${req.date}T${s.start.slice(11)}`;
      return {
        ...s,
        id: showtimeId(title, s.theater_name, start),
        movie_title: title,
        start,
        bookable: s.chain.toLowerCase() === env.BOOK_CHAIN && !!s.booking_url,
      };
    })
    .filter((s) => matchesFilters(s, req));

  // Theaters arrive in batches, like sources finishing one after another.
  const theaters = [...new Set(searchFixture.showtimes.map((s) => s.theater_name))];
  const perBatch = Math.ceil(theaters.length / BATCHES);
  for (let b = 0; b < BATCHES; b++) {
    await sleep(BATCH_MS);
    const names = new Set(theaters.slice(b * perBatch, (b + 1) * perBatch));
    job.showtimes.push(...all.filter((s) => names.has(s.theater_name)));
    job.showtimes.sort((x, y) => (x.distance_mi ?? 99) - (y.distance_mi ?? 99) || x.start.localeCompare(y.start));
    // Source k reports ok once its share of batches has landed.
    job.sources.forEach((s, k) => {
      if (s.state === "running" && b + 1 >= Math.ceil(((k + 1) * BATCHES) / job.sources.length)) {
        s.state = "ok";
        s.ms = Date.now() - t0;
      }
    });
  }

  job.state = "done";
  if (!job.showtimes.length) job.message = "No showtimes match your filters.";
}
