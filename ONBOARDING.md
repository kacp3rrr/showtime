# Showtime — Onboarding

You type a movie and an NYC zip. Showtime shows every nearby showtime in one grid. An
Anchor browser agent books seats **up to the payment page**, and then you take over the
same live browser and pay. `CLAUDE.md` is the source of truth for contracts, rules and
architecture. This page gets you running in about 5 minutes.

## 1. First clone

Requires Node 20+ and npm 9+.

```bash
git clone <repo-url> showtime && cd showtime
npm install                 # one install at the root covers server/ and web/ (npm workspaces)
cp .env.example .env        # MOCK=1 by default, so no keys are needed to start
```

Deps are hoisted into the root `node_modules/`, so `scripts/*.ts` resolve `anchorbrowser`,
`zod` and the rest when run from the repo root. `cd server && npm i` also works; npm
detects the workspace and installs at the root.

If npm prints `allow-scripts` warnings about esbuild, you can ignore them. `tsx` and
`vite` work without that postinstall.

## 2. Run it

Use two terminals:

```bash
npm run dev:server          # tsx watch server/src/index.ts → http://localhost:8787
npm run dev:web             # vite → http://localhost:5173 (proxies /api → :8787)
```

Sanity check:

```bash
curl localhost:8787/api/health     # direct
curl localhost:5173/api/health     # through the Vite proxy
# → {"ok":true,"mock":true,"sources":["fandango","amc"],"book_chain":"amc"}
```

Typecheck everything with `npm run typecheck`.

## 3. Keys to fetch

You don't need any key for mock mode (`MOCK=1`). For live runs, get these and paste them
into your local `.env`. Never paste them into code, chat, commits or screenshots.

| ☐ | Var | Needed for | Required? | Where to get it |
|---|---|---|---|---|
| ☐ | `ANCHOR_API_KEY` | Finder (A), Booker (C), all `scripts/*-check.ts` | **Yes** when `MOCK=0` | anchorbrowser.io dashboard → API keys. Use the **team account that has credits**. A new free account has 0 credits and every session returns `402 Insufficient credits balance`. |
| ☐ | `ANTHROPIC_API_KEY` | title matching + seat/subtotal extraction (A, C) | **Yes** when `MOCK=0` | console.anthropic.com → API keys |
| ☐ | `ARIZE_SPACE_ID` | tracing (D) | No, tracing does nothing without it | app.arize.com → Space settings |
| ☐ | `ARIZE_API_KEY` | tracing (D) | No, tracing does nothing without it | app.arize.com → Space settings → API keys |
| ☐ | `ELEVENLABS_API_KEY` | voice stretch goal | No | elevenlabs.io → Profile → API keys |

Who needs what:
- **Lane A (Finder) and lane C (Booker):** Anchor and Anthropic.
- **Lane D:** Anchor and Anthropic for the eval run, plus both Arize keys.
- **Lane B (UI):** nothing. Work in `MOCK=1`.

The other variables (`PORT`, `ANTHROPIC_MODEL_FAST`, `ARIZE_PROJECT`, `BOOK_CHAIN`,
`SEARCH_SOURCES`) already have working defaults in `.env.example`.

## 4. Going live (real Anchor + Claude)

Set `MOCK=0` in `.env` once the required keys are filled in. With `MOCK=0`, the server
refuses to start if a required key is missing, and the error lists which keys. Values are
never logged.

Before building on a site, check that Anchor can reach it:

```bash
npx tsx --env-file=.env scripts/block-check.ts "<movie title>"
```

For each of Fandango, AMC, Regal, Alamo and Google, it prints one of: `LOADED (showtimes
visible)`, `LOADED but no showtimes`, `BLOCKED` or `ERROR`. A full run takes about 1–2 min
and uses Anchor credits.

## 5. Layout and who owns what

```
shared/types.ts          contracts (frozen 11:15)          D
server/src/index.ts      express app, wiring               D
server/src/env.ts        typed env; the ONLY place keys are read   D
server/src/routes/       API routes (health only so far)   D
server/src/mock/         mock mode                         D   (todo)
server/src/trace/        Arize / OpenTelemetry             D   (todo)
server/src/finder/       movie + zip → Showtime[]          A   (todo)
server/src/booker/       showtime → seats at checkout      C   (todo)
web/                     React + Vite UI                   B
fixtures/                JSON for mock mode + tests        D creates, A/C replace
scripts/                 spikes, block-check, eval         anyone
```

Stay in your lane's folders. Import types with a relative path:
`import type { Showtime } from "../../shared/types"` (adjust the depth).

## 6. Rules you must not break (full list in CLAUDE.md)

- **Payment rule:** nothing ever types, clicks or submits on a payment, card, billing or
  sign-in form. The agent stops at checkout and the human pays.
- **Mock mode always works:** `MOCK=1` must run the whole app with no network and no keys.
  Every feature needs a mock path.
- **No secrets** in code, fixtures, logs, commits or the web bundle. `.env` is gitignored.
- **Anchor tasks aren't idempotent:** retry at most once, never in a loop, and always delete
  sessions you create (`try/finally`). Pass `maxRetries: 0` where supported.
- **Commits:** small, prefixed by lane (`A:`, `B:`, `C:`, `D:`). Pull before you push.

## 7. Status right now

Done: the repo scaffold, `GET /api/health`, `env.ts`, `shared/types.ts`, the Vite proxy
and the block-check script.

Not started: search, booking, mock mode, tracing and the UI (the web app is still the
stock Vite template).
