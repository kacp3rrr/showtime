// Run from repo root: npx tsx --env-file=.env scripts/fandango-check.ts "<movie>" [zip] [YYYY-MM-DD]
// Read-only probe of Fandango URL shapes: does ?date= work on the zip page, and is there a
// movie-specific showtimes page? Prints links and ticket-URL patterns. One session, always deleted.
import { client, Sessions, connectBrowser } from "anchorbrowser";

client.setConfig({ auth: () => process.env.ANCHOR_API_KEY! });
const movie = process.argv[2] ?? "Street Fighter";
const zip = process.argv[3] ?? "10018";
const date = process.argv[4] ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow
const TIME = /\b\d{1,2}:\d{2}\s?(am|pm|a|p)\b/gi;
const t0 = Date.now();
const log = (m: string) => console.log(`[fandango ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const slug = movie.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let id: string | undefined;
try {
  const s: any = await Sessions.createSession({ body: {
    session: { proxy: { active: true, country_code: "us" }, timeout: { max_duration: 5, idle_timeout: 2 } },
    browser: { captcha_solver: { active: true } },
  } as any });
  id = s.data.id;
  const browser = await connectBrowser(id!);
  const page = browser.contexts()[0].pages()[0];

  const visit = async (url: string, label: string) => {
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(9000);
    const text = await page.innerText("body").catch(() => "");
    const links: { href: string; text: string }[] = await page.$$eval("a[href]", (as) =>
      as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60) })));
    const selected = await page.$$eval('[aria-selected="true"], [aria-current], .selected, .active, [class*="selected" i]', (els) =>
      els.map((e) => (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)).filter(Boolean).slice(0, 6)).catch(() => []);
    log(`${label}: HTTP ${r?.status()} url=${page.url()} title="${await page.title()}" times=${text.match(TIME)?.length ?? 0}`);
    log(`  selected-ish: ${JSON.stringify(selected)}`);
    return { text, links };
  };

  // 1. Zip page (today).
  const a = await visit(`https://www.fandango.com/${zip}_movietimes`, "zip page");
  const movieLinks = a.links.filter((l) => l.href.includes(slug));
  log(`  links for "${movie}": ${JSON.stringify([...new Map(movieLinks.map((l) => [l.href, l])).values()].slice(0, 6))}`);
  const ticket = a.links.filter((l) => TIME.test(l.text) || /ticket|transaction|checkout/i.test(l.href));
  TIME.lastIndex = 0;
  log(`  time/ticket links: ${ticket.length}; samples: ${JSON.stringify(ticket.slice(0, 4))}`);
  const theaterLinks = [...new Set(a.links.filter((l) => /theater-page|_theaterpage|\/theater/i.test(l.href)).map((l) => `${l.text} → ${l.href}`))];
  log(`  theater links: ${theaterLinks.length}; samples: ${JSON.stringify(theaterLinks.slice(0, 4))}`);
  log(`  text head: ${a.text.replace(/\s+/g, " ").slice(0, 700)}`);

  // 2. Same page with ?date=.
  const b = await visit(`https://www.fandango.com/${zip}_movietimes?date=${date}`, `zip page ?date=${date}`);
  const [y, m, d] = date.split("-").map(Number);
  const mon = new Date(y, m - 1, d).toLocaleString("en-US", { month: "short" });
  log(`  page mentions "${mon} ${d}": ${new RegExp(`${mon}\\w*\\.?\\s+${d}\\b`, "i").test(b.text)}; same text as today: ${b.text === a.text}`);
  log(`  text head: ${b.text.replace(/\s+/g, " ").slice(0, 400)}`);

  // 3. Movie-specific page, if the zip page links one.
  const overview = movieLinks.find((l) => /movie-overview|movietimes|movie-times/i.test(l.href)) ?? movieLinks[0];
  if (overview) {
    const base = overview.href.split("?")[0].replace(/movie-overview$/, "movie-times");
    const c = await visit(`${base}?date=${date}`, "movie page ?date=");
    const tix = c.links.filter((l) => /ticket|transaction|checkout/i.test(l.href) || /^\d{1,2}:\d{2}/.test(l.text));
    log(`  ticket-ish links: ${tix.length}; samples: ${JSON.stringify(tix.slice(0, 4))}`);
    log(`  text head: ${c.text.replace(/\s+/g, " ").slice(0, 700)}`);
  }
  await browser.close();
} catch (e: any) {
  log(`ERROR ${e?.message ?? e}`);
} finally {
  if (id) await Sessions.deleteSession({ path: { session_id: id } } as any).catch(() => {});
  log("session deleted");
}
