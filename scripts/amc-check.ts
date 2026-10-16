// Run from repo root: npx tsx --env-file=.env scripts/amc-check.ts
// Read-only AMC probe: does the theater page show showtimes, and does a showtime's seat map load?
// Never selects seats, never clicks into checkout. One session, always deleted.
import { client, Sessions, connectBrowser } from "anchorbrowser";

client.setConfig({ auth: () => process.env.ANCHOR_API_KEY! });

const THEATER = "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25";
const TIME = /\b\d{1,2}:\d{2}\s?(am|pm|a|p)\b/gi;
const BLOCK = /access denied|verify you are human|are you a robot|unusual traffic|request blocked|pardon our interruption|403 forbidden/i;
const PAY = /payment|billing|checkout\/(pay|review)|purchase|wallet/i;
const log = (m: string) => console.log(`[amc ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const t0 = Date.now();

let id: string | undefined;
try {
  const s: any = await Sessions.createSession({ body: {
    session: { proxy: { active: true, country_code: "us" }, timeout: { max_duration: 4, idle_timeout: 2 } },
    browser: { captcha_solver: { active: true } },
  } as any });
  id = s.data.id;
  const browser = await connectBrowser(id!);
  const page = browser.contexts()[0].pages()[0];

  const scan = async (label: string) => {
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(800); }
    const text = await page.innerText("body").catch(() => "");
    const links: string[] = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
    const showtimeLinks = [...new Set(links.filter((h) => /\/showtimes\/\d+/i.test(h)))];
    log(`${label}: url=${page.url()} title="${await page.title()}" times=${text.match(TIME)?.length ?? 0} ` +
      `showtime_links=${showtimeLinks.length} blocked=${BLOCK.test(text)}`);
    return { text, links, showtimeLinks };
  };

  // 1. Theater page, longer wait than block-check (8s → 15s + scrolling).
  const r1 = await page.goto(THEATER, { waitUntil: "domcontentloaded", timeout: 45000 });
  log(`theater HTTP ${r1?.status()}`);
  await page.waitForTimeout(15000);
  let res = await scan("theater page");

  // 2. If no showtimes there, try the dedicated showtimes sub-page.
  if (!res.showtimeLinks.length) {
    const alt = res.links.find((h) => /amc-empire-25\/showtimes/i.test(h)) ?? `${THEATER}/showtimes`;
    const r2 = await page.goto(alt, { waitUntil: "domcontentloaded", timeout: 45000 });
    log(`showtimes page HTTP ${r2?.status()} (${alt})`);
    await page.waitForTimeout(12000);
    res = await scan("showtimes page");
  }
  const sample = res.text.match(TIME)?.slice(0, 8).join(", ");
  if (sample) log(`sample times: ${sample}`);
  if (res.showtimeLinks.length) log(`sample links: ${res.showtimeLinks.slice(0, 3).join("  ")}`);
  else log(`no /showtimes/<id> links. Text head: ${res.text.replace(/\s+/g, " ").slice(0, 600)}`);

  // 3. Open one showtime (navigation only) and look for the ticket/seat step.
  const target = res.showtimeLinks[0];
  if (target) {
    const r3 = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(12000);
    if (PAY.test(page.url())) throw new Error(`payment-looking URL reached, stopping: ${page.url()}`);
    const text = await page.innerText("body").catch(() => "");
    const seatEls = await page.locator('[class*="seat" i], [aria-label*="seat" i], [data-seat]').count().catch(() => 0);
    log(`showtime HTTP ${r3?.status()} url=${page.url()} title="${await page.title()}"`);
    log(`seat-like elements=${seatEls} mentions: tickets=${/ticket/i.test(text)} seat=${/seat/i.test(text)} ` +
      `screen=${/\bscreen\b/i.test(text)} adult=${/adult/i.test(text)} sign-in=${/sign in|log in/i.test(text)} blocked=${BLOCK.test(text)}`);
    log(`text head: ${text.replace(/\s+/g, " ").slice(0, 500)}`);
  }
  await browser.close();
} catch (e: any) {
  log(`ERROR ${e?.message ?? e}`);
} finally {
  if (id) await Sessions.deleteSession({ path: { session_id: id } } as any).catch(() => {});
  log("session deleted");
}
