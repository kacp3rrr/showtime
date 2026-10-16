// Run from repo root: npx tsx scripts/run-search.ts "<movie>" [zip=10018] [date=today NYC] [party_size=2]
// Runs the real Finder (Anchor + Fandango) outside the server, prints progress, then the final SearchJob.
import { runSearch } from "../server/src/finder/index.ts";
import { createSearchJob } from "../server/src/jobs.ts";
import { env } from "../server/src/env.ts";

const [movie, zip = "10018", dateArg, party = "2"] = process.argv.slice(2);
if (!movie) {
  console.error('usage: npx tsx scripts/run-search.ts "<movie>" [zip] [YYYY-MM-DD] [party_size]');
  process.exit(2);
}
if (!env.ANCHOR_API_KEY) {
  console.error("ANCHOR_API_KEY is missing from .env");
  process.exit(2);
}
const date = dateArg ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

const job = createSearchJob(env.SEARCH_SOURCES);
const t0 = Date.now();
const tick = setInterval(() => {
  const s = job.sources.map((x) => `${x.name}:${x.state}`).join(" ");
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${job.state} showtimes=${job.showtimes.length} ${s}`);
}, 5_000);

await runSearch({ movie, zip, date, party_size: Number(party) }, job);
clearInterval(tick);

console.log(`\n=== SearchJob after ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
console.log(JSON.stringify(job, null, 2));
process.exit(job.state === "failed" ? 1 : 0);
