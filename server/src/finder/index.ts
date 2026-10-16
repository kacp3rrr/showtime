// Lane A: movie + zip → Showtime[] via Fandango (the only source that passed the spike).
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sessions } from "anchorbrowser";
import type { SearchJob, SearchRequest, Showtime, SourceStatus } from "../../../shared/types.js";
import { env } from "../env.js";
import { showtimeId } from "../jobs.js";
import { searchFandango, type DomShowtime, type FinderResult } from "./fandango.js";

const SOURCE = "fandango";
const CAP_MS = 120_000;
const CACHE_MS = 5 * 60_000;
const MAX_THEATERS = 8;
const here = dirname(fileURLToPath(import.meta.url));

type Found = { matched_title: string; showtimes: Showtime[]; note?: string };
const cache = new Map<string, { at: number; found: Found }>();

// Tracing is lane D's; use it only if server/src/trace exists.
type WithSpan = <T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>) => Promise<T>;
let withSpan: WithSpan = (_name, _attrs, fn) => fn();
const tracePath = resolve(here, "../trace/index.ts");
if (existsSync(tracePath)) {
  try {
    const mod = await import(new URL("../trace/index.ts", import.meta.url).href);
    if (typeof mod.withSpan === "function") withSpan = mod.withSpan;
  } catch (err) {
    console.error("[finder] trace module failed to load:", err instanceof Error ? err.message : err);
  }
}

export async function runSearch(req: SearchRequest, job: SearchJob): Promise<void> {
  const unsupported = job.sources.filter((s) => s.name !== SOURCE).map((s) => s.name);
  if (unsupported.length) console.warn(`[finder] no adapter for ${unsupported.join(", ")}; set SEARCH_SOURCES=${SOURCE}`);
  job.sources = [{ name: SOURCE, state: "running" }];
  const src = job.sources[0];
  const t0 = Date.now();
  const cacheKey = `${req.movie.trim().toLowerCase()}|${req.zip}|${req.date}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    finish(job, req, hit.found, src, t0, "cached");
    return;
  }

  await withSpan("finder.fandango", { kind: "finder", source: SOURCE, movie: req.movie, zip: req.zip, "openinference.span.kind": "AGENT" }, async () => {
    let sessionId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const log = (m: string) => console.log(`[finder ${job.search_id}] ${m}`);
    try {
      const work = searchFandango(req.movie, req.zip, req.date, CAP_MS, (id) => (sessionId = id), log, (title, dom) => {
        // Partial results: publish page-read showtimes while the agent enriches them.
        publish(job, req, { matched_title: title, showtimes: normalize(title, req.date, undefined, dom) });
        src.note = "showtimes read from page; agent adding details";
      });
      work.catch(() => {}); // still settles after a timeout; the session delete below ends it
      const outcome = await Promise.race([
        work,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${CAP_MS / 1000}s`)), CAP_MS); }),
      ]);

      if (outcome.kind === "blocked") {
        setSource(src, "blocked", t0, outcome.note);
        job.state = "failed";
        job.message = "Fandango blocked the search. Try again in a minute.";
        return;
      }
      if (outcome.kind === "no_match") {
        setSource(src, "ok", t0, `${outcome.titles} titles listed`);
        job.did_you_mean = outcome.did_you_mean.length ? outcome.did_you_mean : undefined;
        job.state = "done";
        job.message = outcome.did_you_mean.length
          ? `Couldn't find "${req.movie}" near ${req.zip}. Did you mean one of these?`
          : `"${req.movie}" isn't playing near ${req.zip} on ${req.date}.`;
        return;
      }
      const found: Found = {
        matched_title: outcome.matched_title,
        showtimes: normalize(outcome.matched_title, req.date, outcome.agent, outcome.dom),
        note: outcome.note,
      };
      if (found.showtimes.length) {
        cache.set(cacheKey, { at: Date.now(), found });
        saveDemoCache(req, found);
      }
      finish(job, req, found, src, t0, outcome.note);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      log(`failed: ${msg}`);
      setSource(src, "error", t0, msg.slice(0, 160));
      job.state = "failed";
      job.message = `Search failed: ${msg.slice(0, 160)}`;
    } finally {
      clearTimeout(timer);
      if (sessionId) await Sessions.deleteSession({ path: { session_id: sessionId } } as never).catch(() => {});
    }
  });
}

function setSource(src: SourceStatus, state: SourceStatus["state"], t0: number, note?: string) {
  src.state = state;
  src.ms = Date.now() - t0;
  if (note) src.note = note;
}

/** Apply per-request filters to (possibly cached) results and put them on the job. */
function publish(job: SearchJob, req: SearchRequest, found: Found) {
  job.matched_title = found.matched_title;
  const all = dropPast(found.showtimes, req.date);
  const shown = all.filter((s) => matchesFilters(s, req));
  job.showtimes = shown;
  return { all, shown };
}

function finish(job: SearchJob, req: SearchRequest, found: Found, src: SourceStatus, t0: number, note?: string) {
  const { all, shown } = publish(job, req, found);
  src.note = undefined;
  setSource(src, "ok", t0, note);
  job.state = "done";
  if (!found.showtimes.length) job.message = `"${found.matched_title}" has no showtimes near ${req.zip} on ${req.date}.`;
  else if (!all.length) job.message = `No more showtimes today for "${found.matched_title}" near ${req.zip}.`;
  else if (!shown.length) job.message = "No showtimes match your time or format filters.";
}

// ---------- normalization ----------

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export const chainOf = (theater: string) =>
  /^amc\b/i.test(theater) ? "AMC"
    : /regal/i.test(theater) ? "Regal"
    : /alamo/i.test(theater) ? "Alamo Drafthouse"
    : /angelika|village east|cinema 123/i.test(theater) ? "Angelika"
    : "Other";

/** "7:30p", "7:30 PM", "19:30" → "19:30". */
function parseClock(t: string): string | undefined {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?\.?$/i);
  if (!m) return undefined;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return h < 24 ? `${String(h).padStart(2, "0")}:${m[2]}` : undefined;
}

function toShowtime(title: string, p: {
  theater: string; start: string; format?: string; url?: string; soldOut?: boolean;
  price?: number; distance?: number; address?: string;
}): Showtime {
  const chain = chainOf(p.theater);
  return {
    id: showtimeId(title, p.theater, p.start),
    theater_name: p.theater,
    chain,
    address: p.address,
    distance_mi: p.distance,
    movie_title: title,
    start: p.start,
    format: p.format?.trim() || "Standard",
    booking_url: p.url,
    price: p.price,
    status: p.soldOut ? "sold_out" : p.url ? "available" : "unknown",
    bookable: env.BOOK_CHAIN === "fandango" ? !!p.url : chain.toLowerCase() === env.BOOK_CHAIN && !!p.url,
  };
}

/** Agent rows are primary; ticket links read from the DOM fill in URLs, exact times and anything the agent missed. */
function normalize(title: string, date: string, agent: FinderResult | undefined, dom: DomShowtime[]): Showtime[] {
  const domBy = new Map(dom.map((d) => [`${key(d.theater)}|${d.start}`, d]));
  const domFor = (theater: string, start: string) =>
    domBy.get(`${key(theater)}|${start}`) ??
    dom.find((d) => d.start === start && (key(d.theater).includes(key(theater)) || key(theater).includes(key(d.theater))));

  const out: Showtime[] = [];
  for (const t of agent?.theaters ?? []) {
    for (const s of t.showtimes) {
      const hm = parseClock(s.time);
      if (!hm) continue;
      const start = `${date}T${hm}:00`;
      const d = domFor(t.theater_name, start);
      out.push(toShowtime(title, {
        theater: d?.theater ?? t.theater_name, start,
        format: s.format ?? d?.format, url: d?.url ?? safeUrl(s.booking_url), soldOut: s.sold_out,
        price: s.price, distance: t.distance_mi ?? d?.distance_mi, address: t.address ?? d?.address,
      }));
    }
  }
  for (const d of dom) {
    out.push(toShowtime(title, { theater: d.theater, start: d.start, format: d.format, url: d.url, distance: d.distance_mi, address: d.address }));
  }

  // Dedupe by theater+start (first wins: agent rows carry format/price), then sort and cap theaters.
  const seen = new Set<string>();
  const unique = out.filter((s) => {
    const k = `${key(s.theater_name)}|${s.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => (a.distance_mi ?? 99) - (b.distance_mi ?? 99) || a.theater_name.localeCompare(b.theater_name) || a.start.localeCompare(b.start));
  const theaters = [...new Set(unique.map((s) => s.theater_name))].slice(0, MAX_THEATERS);
  return unique.filter((s) => theaters.includes(s.theater_name));
}

const safeUrl = (u?: string) => (u && /^https:\/\/([a-z0-9-]+\.)*fandango\.com\//i.test(u) ? u : undefined);

/** Today's date and clock in New York, where every theater we search is. */
function nycNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}

function dropPast(list: Showtime[], date: string): Showtime[] {
  const now = nycNow();
  return date === now.date ? list.filter((s) => s.start.slice(11, 16) > now.hm) : list;
}

function matchesFilters(s: Showtime, req: SearchRequest): boolean {
  const hm = s.start.slice(11, 16);
  if (req.time_from && hm < req.time_from) return false;
  if (req.time_to && hm > req.time_to) return false;
  switch (req.format ?? "any") {
    case "imax": return /imax/i.test(s.format);
    case "dolby": return /dolby/i.test(s.format);
    case "standard": return !/imax|dolby|4dx|screenx|rpx|70mm|3d/i.test(s.format);
    default: return true;
  }
}

function saveDemoCache(req: SearchRequest, found: Found) {
  const file = resolve(here, "../../../fixtures/demo_cache.json");
  const body = { saved_at: new Date().toISOString(), request: { movie: req.movie, zip: req.zip, date: req.date }, ...found };
  writeFile(file, JSON.stringify(body, null, 2) + "\n").catch((err) =>
    console.error("[finder] couldn't write demo_cache.json:", err instanceof Error ? err.message : err));
}
