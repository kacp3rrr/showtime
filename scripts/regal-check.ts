// Run from repo root: npx tsx --env-file=.env scripts/regal-check.ts
// Read-only Regal probe: find an NYC theater URL, check showtimes render, open one showtime's
// seat/ticket step. Never selects seats, never goes near payment. One session, always deleted.
import { client, Sessions, connectBrowser } from "anchorbrowser";

client.setConfig({ auth: () => process.env.ANCHOR_API_KEY! });

const BASE = "https://www.regmovies.com";
const TIME = /\b\d{1,2}:\d{2}\s?(am|pm|a|p)\b/gi;
const BLOCK = /access denied|verify you are human|are you a robot|unusual traffic|request blocked|pardon our interruption|403 forbidden/i;
const PAY = /payment|billing|checkout\/(pay|review)|purchase|wallet/i;
const t0 = Date.now();
const log = (m: string) => console.log(`[regal ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const squash = (s: string, n: number) => s.replace(/\s+/g, " ").slice(0, n);

let id: string | undefined;
try {
  const s: any = await Sessions.createSession({ body: {
    session: { proxy: { active: true, country_code: "us" }, timeout: { max_duration: 5, idle_timeout: 2 } },
    browser: { captcha_solver: { active: true } },
  } as any });
  id = s.data.id;
  const browser = await connectBrowser(id!);
  const page = browser.contexts()[0].pages()[0];

  const visit = async (url: string, wait: number, label: string) => {
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(wait);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(700); }
    const text = await page.innerText("body").catch(() => "");
    const links: string[] = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
    log(`${label}: HTTP ${r?.status()} url=${page.url()} title="${await page.title()}" ` +
      `times=${text.match(TIME)?.length ?? 0} blocked=${BLOCK.test(text)}${BLOCK.test(text) ? ` (${text.match(BLOCK)![0]})` : ""}`);
    return { text, links };
  };

  // 1. NYC theater (IDs from regmovies.com search; Times Square is 1929, not 1514).
  const target = `${BASE}/theatres/regal-union-square-screenx-4dx-1320`;

  // 2. Theater page: do showtimes render, and what do showtime controls look like?
  const th = await visit(target, 15000, "theater page");
  const sample = th.text.match(TIME)?.slice(0, 8).join(", ");
  if (sample) log(`sample times: ${sample}`);
  const bookLinks = [...new Set(th.links.filter((h) => /^https:\/\/[^/]*regmovies\.com\//i.test(h) && /book|seat|showtime|order|session/i.test(h) && !/\/theatres\//i.test(h)))];
  log(`booking-ish links: ${bookLinks.length} ${bookLinks.slice(0, 3).join("  ")}`);
  if (!sample) log(`theater text head: ${squash(th.text, 600)}`);

  // 3. Open one showtime: prefer a link; otherwise click the first visible time (navigation only).
  if (bookLinks.length) {
    await visit(bookLinks[0], 12000, "showtime via link");
  } else if (sample) {
    const btn = page.getByText(TIME).first();
    await btn.click({ timeout: 10000 });
    await page.waitForTimeout(12000);
    log(`after clicking time "${sample.split(", ")[0]}": url=${page.url()} title="${await page.title()}"`);
    // Cloudflare Turnstile gates the seat map; give Anchor's captcha solver up to 90s.
    const gate = /one more step before you proceed/i;
    for (let w = 0; w < 90 && gate.test(await page.innerText("body").catch(() => "")); w += 5) await page.waitForTimeout(5000);
    log(`cloudflare gate still up after wait: ${gate.test(await page.innerText("body").catch(() => ""))}`);
    // Showtime dialog → "Select Seats" opens the seat map (navigation only; no seat is clicked).
    const sel = page.getByRole("button", { name: /select seats/i }).or(page.getByRole("link", { name: /select seats/i })).first();
    if (await sel.count()) {
      await sel.click({ timeout: 10000 });
      await page.waitForTimeout(15000);
      log(`after "Select Seats": url=${page.url()} title="${await page.title()}"`);
    } else {
      log(`no "Select Seats" control found`);
      const controls = await page.$$eval("button, a[href], [role=button]", (els) =>
        els.filter((e) => (e as HTMLElement).offsetParent !== null)
          .map((e) => `${e.tagName.toLowerCase()}:"${(e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"${(e as HTMLAnchorElement).href ? `→${(e as HTMLAnchorElement).href}` : ""}`)
          .filter((t) => /seat|ticket|continue|select|\d:\d\d|proceed|step/i.test(t)));
      log(`relevant controls (${controls.length}): ${controls.slice(0, 15).join(" | ")}`);
      log(`iframes: ${(await page.$$eval("iframe", (fs) => fs.map((f) => f.src))).join(" ") || "(none)"}`);
    }
    if (process.env.SHOT) { await page.screenshot({ path: process.env.SHOT }); log(`screenshot → ${process.env.SHOT}`); }
  }
  if (page.url() !== target) {
    if (PAY.test(page.url())) throw new Error(`payment-looking URL reached, stopping: ${page.url()}`);
    const text = await page.innerText("body").catch(() => "");
    log(`step page mentions: seat=${/seat/i.test(text)} screen=${/\bscreen\b/i.test(text)} ticket=${/ticket/i.test(text)} ` +
      `adult=${/adult/i.test(text)} sign-in=${/sign in|log in/i.test(text)} guest=${/guest/i.test(text)} blocked=${BLOCK.test(text)} ` +
      `password_field=${(await page.locator('input[type="password"]').count()) > 0}`);
    log(`step text head: ${squash(text, 600)}`);
  }
  await browser.close();
} catch (e: any) {
  log(`ERROR ${e?.message ?? e}`);
} finally {
  if (id) await Sessions.deleteSession({ path: { session_id: id } } as any).catch(() => {});
  log("session deleted");
}
