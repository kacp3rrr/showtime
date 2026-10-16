// Run from repo root: npx tsx --env-file=.env scripts/block-check.ts "<movie>"
// Opens each site in an Anchor session (US residential proxy + captcha solver),
// waits for JS to render, and reports: loaded / blocked / empty, with timing.
// Takes ~1-2 min total. Read-only: never clicks into checkout.
import { client, Sessions, connectBrowser } from "anchorbrowser";

client.setConfig({ auth: () => process.env.ANCHOR_API_KEY! });
const movie = process.argv[2] ?? "";

const SITES: Record<string, string> = {
  fandango: "https://www.fandango.com/10018_movietimes",
  amc: "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25",
  regal: "https://www.regmovies.com/theatres/regal-times-square-1929",
  alamo: "https://drafthouse.com/nyc",
  google: `https://www.google.com/search?q=${encodeURIComponent(movie + " showtimes near 10018")}`,
};
const BLOCK = /access denied|verify you are human|are you a robot|captcha|unusual traffic|request blocked|attention required|pardon our interruption|403 forbidden/i;
const TIME = /\b\d{1,2}:\d{2}\s?(am|pm|a|p)\b/gi;

for (const [name, url] of Object.entries(SITES)) {
  const t0 = Date.now();
  let id: string | undefined;
  try {
    const s: any = await Sessions.createSession({ body: {
      session: { proxy: { active: true, country_code: "us" }, timeout: { max_duration: 3, idle_timeout: 1 } },
      browser: { captcha_solver: { active: true } },
    } as any });
    id = s.data.id;
    console.log(`\n[${name}] live view: ${s.data.live_view_url ?? JSON.stringify(Object.keys(s.data))}`);
    const browser = await connectBrowser(id!);
    const page = browser.contexts()[0].pages()[0];
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(8000); // let JS render + captcha solver work
    const text = (await page.innerText("body").catch(() => "")).slice(0, 20000);
    const times = text.match(TIME)?.length ?? 0;
    const hasMovie = movie ? text.toLowerCase().includes(movie.toLowerCase()) : false;
    const verdict = BLOCK.test(text) || (resp && resp.status() >= 400) ? "BLOCKED"
      : times > 3 ? "LOADED (showtimes visible)" : "LOADED but no showtimes found (JS/geo/empty?)";
    console.log(`[${name}] HTTP ${resp?.status()} | ${verdict} | times=${times} movie_on_page=${hasMovie} | title="${await page.title()}" | ${((Date.now()-t0)/1000).toFixed(1)}s`);
    if (verdict === "BLOCKED") console.log(`[${name}] block text: ${text.match(BLOCK)?.[0]}`);
    await browser.close();
  } catch (e: any) {
    console.log(`[${name}] ERROR ${e?.message ?? e}`);
  } finally {
    if (id) await Sessions.deleteSession({ path: { session_id: id } } as any).catch(() => {});
  }
}