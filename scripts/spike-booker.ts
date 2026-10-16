// Run from repo root: npx tsx --env-file=.env scripts/spike-booker.ts "<showtime booking url>"
// C's spike: an Anchor agent books 2 adult seats up to the payment step while a read-only CDP
// watcher polls the page every 1.5 s and pauses the agent when the payment guard trips.
// The watcher NEVER clicks, types or fills anything. No secrets/card data go to the agent.
// One session, held 3 min for inspection, always deleted in finally (or on Ctrl-C).
import { client, Sessions, Agent, connectBrowser, agentTask } from "anchorbrowser";
import { checkGuard } from "../server/src/booker/guard.js";

type Browser = Awaited<ReturnType<typeof connectBrowser>>;

const URL_ARG = process.argv[2];
if (!URL_ARG || !/^https?:\/\//i.test(URL_ARG)) {
  console.error('usage: npx tsx --env-file=.env scripts/spike-booker.ts "<booking url>"');
  process.exit(1);
}
const KEY = process.env.ANCHOR_API_KEY;
if (!KEY) {
  console.error("missing ANCHOR_API_KEY in environment (.env)");
  process.exit(1);
}
client.setConfig({ auth: () => KEY });

const N = 2;
const PREF = "center";
const TICK_MS = 1500;
const RUN_CAP_MS = 6 * 60_000; // stop waiting on the agent after this
const HOLD_MS = 3 * 60_000;

const PROMPT =
  "Book 2 Adult tickets with 2 adjacent seats near the center, continue as guest until the payment step, then stop.";
// CLAUDE.md "Booker stop rules", verbatim with {N}/{PREF} filled.
const STOP_RULES = `You are booking movie tickets for a human who will pay themselves.
Select exactly ${N} "Adult" tickets. Never select child, senior, member or discount types.
Choose ${N} adjacent seats; prefer ${PREF}. If none adjacent, choose the closest available.
Skip food, upgrades, memberships, newsletters and add-ons. Dismiss cookie banners and popups.
Continue to checkout as a guest when asked.
STOP IMMEDIATELY and report done when any page asks for payment, card number, billing
address, PayPal/Apple Pay/Google Pay, or a sign-in/password. Never type into those fields.
Never create an account. Never enter an email unless the site requires it to continue
as a guest before payment; if so, STOP and report "needs_user".`;

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (m: string) => console.log(`[booker ${secs()}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sessionId: string | undefined;
let watcher: Browser | undefined;
let cleanedUp = false;
const urlsSeen: string[] = [];
let lastUrl = "";
let guard: { at: string; reasons: string[] } | undefined;

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  await watcher?.close().catch(() => {});
  if (sessionId) {
    await Sessions.deleteSession({ path: { session_id: sessionId } })
      .then(() => log(`session ${sessionId} deleted`))
      .catch((e) => log(`deleteSession failed: ${(e as Error).message}`));
  }
}
process.on("SIGINT", () => {
  log("SIGINT, ending session");
  cleanup().finally(() => process.exit(130));
});

async function onGuard(url: string, reasons: string[], signIn: boolean) {
  guard = { at: url, reasons };
  console.log(`\n>>> GUARD TRIPPED at ${url}  [${reasons.join(", ")}]\n`);
  try {
    await Agent.pauseAgent({ path: { session_id: sessionId! } });
    log("Agent.pauseAgent ok");
  } catch (e) {
    log(`!!! Agent.pauseAgent FAILED: ${(e as Error).message}`);
  }
  if (signIn) log("password field present → would be needs_user");
}

async function watchLoop(stop: () => boolean) {
  while (!stop()) {
    const started = Date.now();
    try {
      const pages = watcher!.contexts().flatMap((c) => c.pages());
      for (const [i, page] of pages.entries()) {
        const url = page.url();
        if (url !== "about:blank" && !urlsSeen.includes(url)) urlsSeen.push(url);
        lastUrl = url;
        const title = await page.title().catch(() => "?");
        const g = await checkGuard(page, { log });
        log(`p${i} ${url} | "${title.slice(0, 60)}" | guard=${g.tripped ? g.reasons.join(",") : "-"}`);
        if (g.tripped && !guard) await onGuard(url, g.reasons, g.signIn);
      }
    } catch (e) {
      log(`watcher error: ${(e as Error).message}`);
    }
    await sleep(Math.max(0, TICK_MS - (Date.now() - started)));
  }
}

try {
  const s = await Sessions.createSession({
    body: {
      session: {
        // NYC exit, same as the Finder and the Booker (a plain "us" proxy landed in Florida).
        proxy: { active: true, country_code: "us", region: "ny", city: "new-york" },
        timeout: { max_duration: 15, idle_timeout: 5 },
        recording: { active: true },
      },
      browser: { captcha_solver: { active: true } },
    },
  });
  sessionId = s.data?.id;
  if (!sessionId) throw new Error(`createSession returned no id; keys: ${Object.keys(s.data ?? {})}`);
  console.log(`\nLIVE VIEW: ${s.data?.live_view_url}\nsession:  ${sessionId}\n`);

  watcher = await connectBrowser(sessionId);
  log("watcher connected (read-only)");

  let done = false;
  const loop = watchLoop(() => done);

  // Not awaited: agent and watcher run concurrently. Called once, never retried.
  const task = agentTask(PROMPT, {
    sessionId,
    taskOptions: { url: URL_ARG, extendedSystemMessage: STOP_RULES, maxSteps: 40 },
  }).then(
    (r) => ({ ok: true as const, result: r.data?.result }),
    (e) => ({ ok: false as const, error: (e as Error).message }),
  );
  log("agentTask started");

  // A paused agent may never resolve, so the guard also ends the run.
  const outcome = await Promise.race([
    task,
    (async () => { while (!guard) await sleep(250); return "guard" as const; })(),
    sleep(RUN_CAP_MS).then(() => "timeout" as const),
  ]);
  if (outcome === "guard") await sleep(TICK_MS * 2); // a couple more ticks to see where it settled
  done = true;
  await loop;

  const pages = watcher.contexts().flatMap((c) => c.pages());
  const finalUrl = pages[pages.length - 1]?.url() ?? lastUrl;

  console.log("\n===== SUMMARY =====");
  console.log(`total:        ${secs()} s`);
  console.log(`ended by:     ${typeof outcome === "string" ? outcome : outcome.ok ? "agent finished" : "agent error"}`);
  if (typeof outcome !== "string") {
    console.log(outcome.ok ? `agent result: ${JSON.stringify(outcome.result)}` : `agent error:  ${outcome.error}`);
  }
  console.log(`final URL:    ${finalUrl}`);
  console.log(`guard fired:  ${guard ? `yes at ${guard.at} [${guard.reasons.join(", ")}]` : "no"}`);
  console.log("URLs seen:");
  urlsSeen.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  console.log("===================\n");

  log(`holding session ${HOLD_MS / 60000} min for inspection (Ctrl-C to end now): ${s.data?.live_view_url}`);
  await sleep(HOLD_MS);
} catch (e) {
  log(`ERROR: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  // A paused agentTask can leave its HTTP request pending; don't let it keep the process alive.
  process.exit(process.exitCode ?? 0);
}
