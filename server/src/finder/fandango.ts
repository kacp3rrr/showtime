// Fandango via one Anchor session: zip page (?date=) → title list → movie page (?date=) →
// DOM read of ticket links + agentTask with FinderSchema. Read-only; the caller owns the time cap.
import { client, Sessions, agentTask, connectBrowser } from "anchorbrowser";
import type { Page } from "playwright-core";
import { z } from "zod";
import { env } from "../env.js";
import { matchTitle } from "./titles.js";

client.setConfig({ auth: () => env.ANCHOR_API_KEY });

export const FinderSchema = z.object({ theaters: z.array(z.object({
  theater_name: z.string(), chain: z.string(), address: z.string().optional(),
  distance_mi: z.number().optional(),
  showtimes: z.array(z.object({ time: z.string(), format: z.string().optional(),
    booking_url: z.string().optional(), sold_out: z.boolean().optional(),
    price: z.number().optional() })) })) });
export type FinderResult = z.infer<typeof FinderSchema>;

/** One ticket link read straight from the page DOM. */
export type DomShowtime = { theater: string; url: string; start: string; label: string; format?: string; distance_mi?: number; address?: string };

export type FandangoOutcome =
  | { kind: "ok"; matched_title: string; agent?: FinderResult; dom: DomShowtime[]; note?: string }
  | { kind: "no_match"; did_you_mean: string[]; titles: number }
  | { kind: "blocked"; note: string };

const AGENT_CAP_MS = 60_000;
const TIME = /\b\d{1,2}:\d{2}\s?(am|pm|a|p)\b/i;
const BLOCK = /access denied|verify you are human|are you a robot|unusual traffic|request blocked|pardon our interruption|403 forbidden/i;

const STOP_RULES = `This is a read-only task: you are only reading movie showtimes for a person.
Never click ticket or time links, never buy, never sign in, never type into any field, never accept offers or join anything.
You may scroll to see more theaters and dismiss cookie banners or popups.
Report the theater name and each time exactly as shown (e.g. "7:30p"), the format or amenity heading the time is listed under
(e.g. "IMAX", "Dolby Cinema", "Standard"), the theater's distance in miles and address if shown, and each time's link URL if you can see it.`;

export async function searchFandango(
  movie: string, zip: string, date: string, budgetMs: number,
  onSession: (id: string) => void, log: (m: string) => void,
  onPartial: (matched_title: string, dom: DomShowtime[]) => void,
): Promise<FandangoOutcome> {
  const t0 = Date.now();
  const s = await Sessions.createSession({ body: {
    // NYC exit IP: Fandango's movie page locates theaters by IP, not by the zip we visited (spike: a
    // plain "us" proxy landed in Florida). Region/city format per docs.anchorbrowser.io/advanced/proxy.
    session: { proxy: { active: true, country_code: "us", region: "ny", city: "new-york" }, timeout: { max_duration: 4, idle_timeout: 2 } },
    browser: { captcha_solver: { active: true } },
  } as never });
  const sessionId = s.data?.id;
  if (!sessionId) throw new Error("Anchor returned no session id");
  onSession(sessionId);

  const browser = await connectBrowser(sessionId);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("no page in Anchor session");

    // 1. Zip page for the date: lists every movie playing nearby, and (after a few seconds of its JS)
    // sets Fandango's location so the movie page shows theaters near this zip instead of near our IP.
    const zipUrl = `https://www.fandango.com/${zip}_movietimes?date=${date}`;
    await page.goto(zipUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector('a[href*="/movie-overview"]', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const body = await page.innerText("body").catch(() => "");
    if (BLOCK.test(body)) return { kind: "blocked", note: `Fandango: ${body.match(BLOCK)![0]}` };
    const movies = await listMovies(page);
    log(`zip page ready in ${Date.now() - t0} ms, ${movies.size} movies listed`);

    // 2. Title match against what Fandango lists.
    const m = await matchTitle(movie, [...movies.keys()]);
    if (!m.matched) return { kind: "no_match", did_you_mean: m.did_you_mean, titles: movies.size };
    log(`matched "${movie}" → "${m.matched}"`);

    // 3. Movie-specific page for the date (verified: ?date=YYYY-MM-DD selects that day).
    const movieUrl = `${movies.get(m.matched)!.split("?")[0]}?date=${date}`;
    await page.goto(movieUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitForTicketLinks(page);
    let text = await page.innerText("body").catch(() => "");
    const near = text.match(/theaters near\s+([^\n]{1,40})/i)?.[1]?.trim();
    let dom = await readTicketLinks(page, date);
    log(`movie page: theaters near "${near ?? "?"}", ${dom.length} ticket links in DOM`);

    // Location didn't stick (seen: Newark, Florida). The zip page is always right for its zip,
    // so read this movie's rows from it instead (its 10 nearest theaters).
    if (near !== zip) {
      await page.goto(zipUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await waitForTicketLinks(page);
      text = await page.innerText("body").catch(() => "");
      dom = await readTicketLinks(page, date, m.matched);
      log(`location was "${near ?? "?"}", not ${zip}: read ${dom.length} rows for this movie from the zip page`);
    }
    if (!dom.length && !TIME.test(text)) return { kind: "ok", matched_title: m.matched, dom, note: "no showtimes listed for this date" };
    if (dom.length) {
      // Spike (2026-10-16): the page read gets every time + ticket URL in ~20 s; the agent took ~150 s
      // for the same theaters and returned null formats. So the agent only runs when the page read fails.
      onPartial(m.matched, dom);
      return { kind: "ok", matched_title: m.matched, dom };
    }

    // 4. Fallback only, opt-in (FINDER_AGENT=1): agent extraction on the same page, hard 60 s cap.
    if (!env.FINDER_AGENT) throw new Error("page read found no showtimes (agent fallback is off: FINDER_AGENT=0)");
    log("page read found no ticket links; falling back to the agent");
    const agentMs = Math.min(AGENT_CAP_MS, Math.max(10_000, budgetMs - (Date.now() - t0) - 5_000));
    let agent: FinderResult | undefined;
    let note: string | undefined;
    const run = agentTask(
      `List showtimes for '${m.matched}' on ${date} at theaters on this page, at most 8 theaters, include each showtime's ticket link URL.`,
      { sessionId, taskOptions: {
        outputSchema: z.toJSONSchema(FinderSchema),
        maxSteps: 15,
        extendedSystemMessage: STOP_RULES,
        onAgentStep: (step) => log(`agent step: ${(typeof step === "string" ? step : JSON.stringify(step)).replace(/\s+/g, " ").slice(0, 200)}`),
      } },
    );
    run.catch(() => {}); // may settle after we stop waiting
    try {
      const res = await Promise.race([run, sleep(agentMs).then(() => { throw new Error(`agent timed out after ${agentMs / 1000}s`); })]);
      const parsed = parseAgentResult(res.data?.result);
      if (parsed.success) agent = parsed.data;
      else {
        note = `agent output didn't match schema (${parsed.error.issues[0]?.message ?? "invalid"})`;
        log(`agent raw result (first 300 chars): ${JSON.stringify(res.data?.result).slice(0, 300)}`);
      }
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    }
    log(agent ? `agent returned ${agent.theaters.length} theaters` : `agent: ${note}`);
    if (!agent?.theaters.length) throw new Error(`page read found no showtimes; agent fallback failed: ${note ?? "no theaters"}`);
    return { kind: "ok", matched_title: m.matched, agent, dom, note: "read by agent fallback" };
  } finally {
    await browser.close().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ticket links render late and lazily: scroll and poll until the count stops growing (max ~25 s). */
async function waitForTicketLinks(page: Page) {
  let links = 0;
  for (let i = 0, stable = 0; i < 25 && stable < 2; i++) {
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(1000);
    const n = await page.locator('a[href*="jump.aspx"]').count().catch(() => 0);
    stable = n > 0 && n === links ? stable + 1 : 0;
    links = n;
  }
}

/** The agent's result arrives as an object, or as JSON text (sometimes fenced) under `result`. */
function parseAgentResult(raw: unknown) {
  let v: unknown = raw;
  if (v && typeof v === "object" && !("theaters" in v) && "result" in v) v = (v as { result: unknown }).result;
  if (typeof v === "string") {
    try { v = JSON.parse(v.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* fall through to schema error */ }
  }
  return FinderSchema.safeParse(stripNulls(v));
}

const stripNulls = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stripNulls)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)]))
    : v;

/** Title → movie-overview URL for every movie linked on the zip page. */
async function listMovies(page: Page): Promise<Map<string, string>> {
  const links = await page.$$eval('a[href*="/movie-overview"]', (as) =>
    as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").trim().replace(/\s+/g, " ") })));
  const out = new Map<string, string>();
  for (const { href, text } of links) {
    if (!text || text.length > 80 || /^(learn more|showtimes|see all|buy|tickets?|more)$/i.test(text)) continue;
    if (!out.has(text)) out.set(text, href);
  }
  return out;
}

/** Format from an amenity list like "Closed caption, IMAX with Laser at AMC, Recliner seating". */
export function formatFrom(amenities: string, heading?: string): string {
  const PREMIUM = [/imax[^,]*/i, /dolby cinema[^,]*/i, /\b4dx\b[^,]*/i, /screenx[^,]*/i, /\brpx\b[^,]*/i, /xl at amc/i,
    /prime at amc/i, /\bplf\b|premium large format/i, /70\s?mm[^,]*/i, /reald 3d|\b3d\b[^,]*/i];
  for (const re of PREMIUM) {
    const m = amenities.match(re);
    if (m) return m[0].trim();
  }
  return heading && !/premium/i.test(heading) ? heading.trim() : "Standard";
}

/**
 * Every bookable Fandango ticket link on the page with its theater, distance, address and format.
 * On the zip page times are grouped per movie, so pass `title` to keep only that movie's rows.
 */
async function readTicketLinks(page: Page, date: string, title?: string): Promise<DomShowtime[]> {
  // Runs in the page. No named inner functions: tsx's __name() wrapper doesn't exist there.
  const rows = await page.$$eval('a[href*="jump.aspx"]', (anchors) => anchors.map((a) => {
    const theaterEl = a.closest(".js-movie-showtime-theater, .shared-showtimes__container");
    const nameLink = theaterEl?.querySelector(".shared-theater-header__name-link")
      ?? [...(theaterEl?.querySelectorAll('a[href*="theater-page"]') ?? [])]
        .find((l) => !/upcoming|details|see |directions|more/i.test(l.textContent ?? ""));
    // The block's first movie-overview link is the poster (no text); the title link has the name.
    const movieBlock = a.closest(".shared-movie-showtimes");
    const movieTitle = (movieBlock?.querySelector(".shared-movie-showtimes__movie-title-link")
      ?? [...(movieBlock?.querySelectorAll('a[href*="movie-overview"]') ?? [])].find((l) => (l.textContent ?? "").trim()))
      ?.textContent?.trim();
    const group = a.closest(".shared-showtimes__amenity-group");
    // A group's h4 ("Premium Format", "Standard") appears only on the first group of its kind.
    let heading = group?.querySelector("h4")?.textContent?.trim();
    for (let g = group?.previousElementSibling; !heading && g; g = g.previousElementSibling) {
      heading = g.querySelector?.("h4")?.textContent?.trim();
    }
    return {
      theater: (nameLink?.textContent ?? "").trim().replace(/\s+/g, " "),
      aria: nameLink?.getAttribute("aria-label") ?? "",
      distance: theaterEl?.querySelector(".shared-theater-header__distance")?.textContent?.trim() ?? "",
      amenities: (group?.querySelector(".shared-showtimes__amenities")?.textContent ?? "").trim().replace(/\s+/g, " "),
      heading,
      movieTitle,
      url: (a as HTMLAnchorElement).href,
      label: (a.textContent ?? "").trim(),
    };
  }));
  const out: DomShowtime[] = [];
  for (const r of rows) {
    const sdate = new URL(r.url).searchParams.get("sdate") ?? ""; // "2026-10-16 13:20"
    const [d, hm] = sdate.split(/[ +]/);
    if (!r.theater || d !== date || !/^\d{1,2}:\d{2}$/.test(hm ?? "")) continue;
    if (title && r.movieTitle !== title) continue;
    // aria-label: "AMC Empire 25. 234 West 42nd St., New York, NY 10036. This theater ..."
    const address = r.aria.slice(r.theater.length).replace(/^\.\s*/, "").match(/^(.*?\b\d{5})\b/)?.[1];
    const miles = r.distance.match(/(\d+(?:\.\d+)?)\s*mi/i)?.[1];
    out.push({
      theater: r.theater, url: r.url, label: r.label,
      format: formatFrom(r.amenities, r.heading),
      start: `${d}T${hm.padStart(5, "0")}:00`,
      distance_mi: miles ? Number(miles) : undefined,
      address,
    });
  }
  return out;
}
