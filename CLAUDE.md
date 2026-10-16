# Showtime — CLAUDE.md

Showtime: type a movie + NYC zip → see every nearby showtime in one grid → an Anchor
browser agent books seats **up to the payment page** → the human takes over the same
live browser and pays. Built in one day at Daytona HackSprint #6 (submit by 3:20 pm).

Full plan (product, test cases, schedule): https://claude.ai/code/artifact/f241ed3b-c285-4331-8d5c-f540c9a43f3d

---

## Rules for Claude Code in this repo (read every time)

1. **Speed over polish, but never break the contracts.** `shared/types.ts` is frozen after
   11:15. If a change is truly needed, say so in your reply and stop; a human announces it.
2. **Stay in your lane's folder** (see Ownership). Don't edit another lane's files unless
   the prompt says so. Integration edits happen only in the integration phase.
3. **Never write secrets** into code, fixtures, logs, commits or the UI bundle. Read keys
   from `process.env` via `server/src/env.ts` only. `.env` is gitignored.
4. **The payment rule is absolute.** No code path may type, fill, click or submit anything
   on a payment/card/billing form, pass card data or passwords to the agent, or create accounts.
   The agent stops at checkout; the human pays. Don't "helpfully" relax this.
5. **Mock mode must always work.** `MOCK=1` runs the whole app with no network and no keys.
   Every new feature needs a mock path.
6. **Anchor agent tasks are not idempotent.** Never auto-retry an `agentTask` more than once,
   never inside a loop, and always end sessions you create (`try/finally`).
7. **Verify SDK signatures before guessing.** If an Anchor call fails or the type doesn't
   match, read https://docs.anchorbrowser.io/llms.txt and the linked `.md` page, or fall back
   to the REST API with `fetch`. Don't invent parameters.
8. Small commits, message prefix by lane: `A:`, `B:`, `C:`, `D:`. Pull before you push.
9. When done with a task, list: files changed, how to run it, what's untested.

---

## Stack

- **server/**: Node 20+, TypeScript via `tsx`, Express, ESM (`"type": "module"`).
  Deps: `anchorbrowser`, `zod`, `@anthropic-ai/sdk`, `dotenv`, `express`, `cors`,
  `playwright-core` (only for `connectBrowser`, if the SDK needs it), OpenTelemetry pkgs (lane D).
- **web/**: React + Vite + TypeScript. Plain CSS or CSS modules (no UI library install fights).
- **shared/**: `types.ts` only, imported by relative path from both sides.
- **fixtures/**: JSON used by mock mode and tests.
- No database. Job state lives in in-memory `Map`s in the server.

## Folders and ownership

| Path | Lane | Owner does |
|---|---|---|
| `server/src/finder/` | A | movie + zip → `Showtime[]` via Anchor |
| `server/src/booker/` | C | showtime → seats held at checkout, live view, payment guard |
| `server/src/index.ts`, `server/src/routes/`, `server/src/mock/`, `server/src/trace/`, `server/src/env.ts` | D | API, jobs, mock mode, Arize |
| `web/` | B | all UI |
| `shared/types.ts` | D (frozen 11:15) | contracts |
| `fixtures/` | D creates, A/C replace with real captures | |
| `scripts/` | anyone | spikes, eval runner |

## Environment variables (`.env` at repo root, loaded by `server/src/env.ts`)

```
MOCK=1                       # 1 = no network, replay fixtures
PORT=8787
ANCHOR_API_KEY=              # anchorbrowser.io dashboard → API keys
ANTHROPIC_API_KEY=           # for title matching + extraction (Haiku-class model)
ANTHROPIC_MODEL_FAST=claude-haiku-5-5        # confirm the exact id in console; override here
ARIZE_SPACE_ID=
ARIZE_API_KEY=
ARIZE_PROJECT=showtime
BOOK_CHAIN=amc               # decided at 11:15 spike: the one chain the Booker supports
SEARCH_SOURCES=fandango,amc  # decided at 11:15 spike, comma-separated
ELEVENLABS_API_KEY=          # stretch only
```

`server/src/env.ts` exports a typed `env` object, throws a clear error listing missing keys
when `MOCK!=1`, and never logs values.

---

## Contracts (`shared/types.ts`) — frozen at 11:15

```ts
export type SearchRequest = {
  movie: string; zip: string; date: string;      // YYYY-MM-DD
  party_size: number;                             // 1-6
  time_from?: string; time_to?: string;           // "18:00"
  format?: "any" | "imax" | "dolby" | "standard";
};

export type Showtime = {
  id: string;                  // stable hash of theater_name + start
  theater_name: string; chain: string; address?: string;
  distance_mi?: number;
  movie_title: string;         // as the site names it
  start: string;               // ISO local time, e.g. 2026-10-16T19:30:00
  format: string;              // "Standard", "IMAX", ...
  booking_url?: string;
  price?: number;              // per adult, if shown
  status: "available" | "sold_out" | "unknown";
  bookable: boolean;           // true only when chain === BOOK_CHAIN and booking_url exists
};

export type SourceStatus = { name: string; state: "running" | "ok" | "blocked" | "error"; ms?: number; note?: string };

export type SearchJob = {
  search_id: string;
  state: "running" | "done" | "failed";
  matched_title?: string;
  did_you_mean?: string[];     // max 3, when ambiguous
  showtimes: Showtime[];       // grows as sources finish
  sources: SourceStatus[];
  message?: string;
};

export type BookingRequest = { showtime_id: string; party_size: number; seat_pref: "center" | "aisle" | "any" };

export type BookingState =
  | "starting" | "opening" | "tickets" | "seats" | "checkout"
  | "handoff" | "needs_user" | "sold_out" | "failed" | "cancelled";

export type BookingJob = {
  booking_id: string;
  state: BookingState;
  live_view_url?: string;
  interactive: boolean;        // false while agent works; true at handoff / needs_user
  seats?: string[];            // ["F7","F8"]
  subtotal?: number;
  hold_expires_at?: string;    // ISO, if the site shows a timer
  steps: { at: string; text: string }[];
  guard_tripped?: boolean;     // payment guard fired
  fallback_url?: string;       // theater booking link for manual finish
  message?: string;
};
```

## API (server, port 8787; Vite proxies `/api` to it)

| Method | Path | Body / returns |
|---|---|---|
| POST | `/api/search` | `SearchRequest` → `{search_id}` (returns immediately) |
| GET | `/api/search/:id` | `SearchJob` (UI polls every 1 s) |
| POST | `/api/book` | `BookingRequest` → `{booking_id}` |
| GET | `/api/book/:id` | `BookingJob` (UI polls every 1 s) |
| POST | `/api/book/:id/cancel` | `{ok: true}`; ends the Anchor session |
| POST | `/api/book/:id/continue` | after `needs_user` (user signed in), resumes the agent |
| GET | `/api/health` | `{ok, mock, sources, book_chain}` |

Validation with zod on every POST. Errors: `400 {error}`; never a stack trace to the client.
The Finder and Booker expose functions that **mutate a job object** passed in by the route,
so the route layer owns the maps and the polling just reads them.

```ts
// server/src/finder/index.ts (A)
export async function runSearch(req: SearchRequest, job: SearchJob): Promise<void>;
// server/src/booker/index.ts (C)
export async function runBooking(req: BookingRequest, showtime: Showtime, job: BookingJob): Promise<void>;
export async function cancelBooking(job: BookingJob): Promise<void>;
export async function continueBooking(job: BookingJob): Promise<void>;
```

---

## Anchor Browser — how we use it

Docs index: https://docs.anchorbrowser.io/llms.txt (append `.md` to doc URLs for raw text).

```ts
import { client, Sessions, connectBrowser, agentTask } from "anchorbrowser";
client.setConfig({ auth: () => env.ANCHOR_API_KEY });

const s = await Sessions.createSession({ body: {
  session: {
    proxy: { active: true, country_code: "us" },        // NYC city targeting if supported: verify
    timeout: { max_duration: 15, idle_timeout: 5 },      // minutes
    recording: { active: true },                          // backup-video source
  },
  browser: { captcha_solver: { active: true } },          // requires proxy on
}});
const sessionId = s.data.id;
const liveViewUrl = s.data.live_view_url;                 // verify field name at runtime; log keys once

const res = await agentTask(PROMPT, { sessionId, taskOptions: {
  url: START_URL,
  outputSchema: z.toJSONSchema(Schema),   // zod v4; else zod-to-json-schema
  maxSteps: 40,
  extendedSystemMessage: STOP_RULES,
}});
const data = Schema.parse(res.data.result);              // result is already an object

await Sessions.deleteSession({ path: { session_id: sessionId } });   // verify arg shape
```

Facts to respect:
- The SDK has no `maxRetries` option and does not auto-retry, so duplicates can only come from
  our own code: never retry `agentTask` ourselves (rule 6).
- `agentTask` blocks until done (can take 30–150 s). Run it without awaiting in the route;
  update the job as it progresses.
- Live view embed: `<iframe src={live_view_url} sandbox="allow-same-origin allow-scripts"
  allow="clipboard-read; clipboard-write">`. View-only = CSS `pointer-events: none`.
  Interactive = remove that style. Same URL, no new session.
- Agent control: `Agent.pauseAgent` / `Agent.resumeAgent` exist (path `{session_id}`).
  Human-in-the-loop (`humanIntervention: true`) is a stretch only.
- A second CDP connection via `connectBrowser(sessionId)` can watch the page (URL, title,
  inputs) while the agent drives it. That watcher is how we track state and run the guard.

### Booker stop rules (`extendedSystemMessage`, verbatim)

```
You are booking movie tickets for a human who will pay themselves.
Select exactly {N} "Adult" tickets. Never select child, senior, member or discount types.
Choose {N} adjacent seats; prefer {PREF}. If none adjacent, choose the closest available.
Skip food, upgrades, memberships, newsletters and add-ons. Dismiss cookie banners and popups.
Continue to checkout as a guest when asked.
STOP IMMEDIATELY and report done when any page asks for payment, card number, billing
address, PayPal/Apple Pay/Google Pay, or a sign-in/password. Never type into those fields.
Never create an account. Never enter an email unless the site requires it to continue
as a guest before payment; if so, STOP and report "needs_user".
```

### Payment guard (C owns, D tests) — three layers

1. Stop rules above. 2. No secrets are ever passed (`secretValues` unused).
3. **Watcher**, every 1.5 s over CDP:
   - `url` matches `/payment|billing|checkout\/(pay|review)|purchase|wallet/i`, **or**
   - the page has any of: `input[autocomplete^="cc-"]`, `input[name*="card" i]`,
     `input[name*="cvv" i]`, `input[name*="cvc" i]`, an iframe whose src matches
     `/stripe|braintree|adyen|cybersource|paypal|spreedly/i`, or a password field.
   → `Agent.pauseAgent`, set `job.state = "handoff"` (or `needs_user` for password/sign-in),
   `job.interactive = true`, `job.guard_tripped = true`, extract seats + subtotal with one
   read of the page text (Haiku call), push a step. Never close the session on handoff.

### Finder approach

- One Anchor session per source in `SEARCH_SOURCES`, run in parallel, each with a 120 s cap.
- Agent prompt asks for showtimes of `{movie}` on `{date}` for theaters near `{zip}`,
  max 8 theaters, returning the zod schema below. Then: zod validate → dedupe by
  `theater_name+start` → drop past times (if date is today) → sort by distance then time →
  set `bookable` → push to `job.showtimes` as each source finishes.
- Source fails or is blocked → its `SourceStatus` says so; others continue.
- Title matching: one Haiku call maps the user's text to a canonical title from what the
  site lists; ambiguous → `did_you_mean`.
- 5-minute in-memory cache keyed by `movie|zip|date`.

```ts
const FinderSchema = z.object({ theaters: z.array(z.object({
  theater_name: z.string(), chain: z.string(), address: z.string().optional(),
  distance_mi: z.number().optional(),
  showtimes: z.array(z.object({ time: z.string(), format: z.string().optional(),
    booking_url: z.string().optional(), sold_out: z.boolean().optional(),
    price: z.number().optional() })) })) });
```

## Arize (lane D)

- OTLP endpoint `https://otlp.arize.com/v1/traces`, headers `space_id`, `api_key`.
  Resource attribute `model_id = ARIZE_PROJECT` (also set `openinference.project.name`).
- Packages: `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-proto`,
  `@opentelemetry/resources`, `@opentelemetry/api`.
- `server/src/trace/index.ts` exports `withSpan(name, attrs, fn)`. One span per search source
  and per booking. Attributes: `kind` (finder|booker), `source`/`chain`, `outcome`
  (ok|blocked|error|handoff|needs_user|failed), `duration_ms`, `showtimes_count`,
  `guard_tripped`, `movie`, `zip`. Set `openinference.span.kind = "AGENT"`.
- No-op when `MOCK=1` or keys missing. Never put page HTML or anything card-like in spans.
- `scripts/eval.ts` runs `fixtures/queries.json` and writes `eval/results.json` + a summary
  line: "search correct X/10, booking reached checkout Y/10, avg Z s".

## UI (lane B)

Three screens, one page app, state machine `search → results → booking`.
- **Search:** movie, zip (5 digits, NYC prefixes 100–104, 110–114, 116), date (today..+14),
  party size 1–6, seat pref, optional time window/format. Inline validation; submit disabled
  until valid.
- **Results:** banner "Showing results for {matched_title}" / "Did you mean…" chips;
  source pills (running spinner / ok / blocked); grid rows = theaters (name, chain,
  distance), chips = times with format badge; sold-out chips grey + disabled; `bookable`
  chips primary "Book", others open `booking_url` in a new tab. Partial results render as
  they arrive.
- **Booking:** big live-view iframe (left, ~65%), right panel: state stepper
  (opening → tickets → seats → checkout → your turn), step log, seats + subtotal, hold
  countdown, Cancel button. While `interactive=false`: overlay label "Agent is driving" and
  `pointer-events:none`. On `handoff`: animated banner "Your turn — finish payment in the
  window" and the iframe becomes clickable. `needs_user`: "Sign in here, then press Continue"
  + Continue button. `failed`/`sold_out`: message + fallback link + "try next showtime".
- Look: dark cinema theme, one accent color, big readable type (judges view on a projector).

## Mock mode (lane D)

- `server/src/mock/`: search emits showtimes from `fixtures/search_10018.json` in 3 batches over
  6 s; booking walks `starting→opening→tickets→seats→checkout→handoff` over ~20 s using
  `fixtures/booking_states.json`; `live_view_url` = `/mock-live.html` (a static page in
  `web/public/` that looks like a seat map).
- Special mock inputs for UI states: movie `"zzz"` → not playing; `"sold"` → booking ends
  `sold_out`; `"login"` → `needs_user`; `"fail"` → search `failed`.

## Commands

```
cd server && npm i && npm run dev        # tsx watch src/index.ts → :8787
cd web && npm i && npm run dev           # vite → :5173, proxies /api
npx tsx scripts/spike-finder.ts          # A's spike
npx tsx scripts/spike-booker.ts          # C's spike
npx tsx scripts/eval.ts                  # D's eval batch
```

## Definition of done (P0, by 1:30)

S1 search grid from ≥2 theaters in ≤90 s · S5/S6 not-playing + invalid zip handled ·
F2/F3/F4/F7 source failures don't crash · B1 reaches checkout with 2 adjacent seats ·
B2/B3 guard fires, no payment field touched · B4 sign-in → needs_user · B9 adult only ·
B13 step cap → needs_user · B14 non-bookable opens link · X1 full flow < 4 min on venue
Wi-Fi · X2 mock mode works · X3 live view visible · X6 no secrets anywhere · X9 backup
video recorded.
