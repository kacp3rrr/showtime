# Showtime

One search for every NYC movie showtime, and an AI browser agent that books your seats up to the
payment page, then hands you the live browser to pay.

Built in one day at Daytona HackSprint #6.

## Demo

Demo video: <link>

Screenshot: <image>

## How it works

**1. Search.** Enter a movie, an NYC zip code, a date, party size (1–6) and a seat preference.

**2. Finder** (`server/src/finder/`)
- Opens Fandango in an [Anchor](https://anchorbrowser.io) cloud browser routed through an NYC proxy.
- Matches what you typed to a title Fandango lists: a local match first, then one Claude Haiku call.
  Ambiguous input gets "Did you mean…" suggestions.
- Reads showtimes and booking links straight from the page, for up to 8 theaters, sorted by distance
  and time. Results are cached for 5 minutes.

**3. Booker** (`server/src/booker/`)
- Click **Book** on a showtime. A fresh Anchor session opens the Fandango booking link, and its live
  view is embedded in the app (view-only while the agent drives).
- An Anchor agent task picks adjacent seats by your preference, selects Adult tickets only, skips
  add-ons and continues as a guest.
- Seat preference is ranked, never a blocker: middle rows first; on a nearly sold-out show it takes
  the best adjacent seats anywhere, front rows included.
- At Fandango's guest checkout the agent stops. Claude Haiku reads the seats and subtotal from the
  page, and the embedded browser becomes clickable: you enter your email and pay.
- If the site wants a sign-in, the agent stops early or takes over 3 minutes, you get the browser
  with a "Continue" button and the theater's booking link as a fallback. Sold-out shows say so.

**4. Pick your own seats.** Choose "I'll pick" as the seat preference. The Booker opens the seat map
with no agent running and hands you the browser. Pick your seats, press Continue, and the agent
handles tickets and checkout without changing your seats.

## Safeguards

- **The human always pays.** The agent never receives card data or passwords; no secrets are passed
  to it.
- **Stop rules.** The agent is told to stop at any payment, card, billing, wallet, sign-in or password
  step, never type into those fields, and never create an account.
- **Read-only watcher.** A second connection to the same browser checks every 1.5 s and pauses the
  agent if it sees any of:
  - a payment URL;
  - a visible card field (card number, CVV/CVC, `cc-*` autocomplete) in the page or any frame;
  - a visible password field (handed to you as a sign-in step);
  - a visible payment-processor iframe (Stripe, Braintree, Adyen, CyberSource, PayPal, Spreedly)
    of at least 150×40 px.

  The watcher only reads the page. It never clicks, types or fills anything.
- **Hidden payment iframes are ignored.** Fandango loads PayPal and Braintree frames in the
  background on the seat map, long before payment; zero-size or hidden frames don't trip the guard.
- **Sessions end.** Every browser session is capped at 15 minutes and is deleted on cancel, on
  failure and when the server shuts down.

## Tech stack

- **Server:** Node + TypeScript + Express (`server/`)
- **Web:** React + Vite (`web/`)
- **Contracts:** shared TypeScript types in `shared/types.ts`; zod validates every API request and
  every agent / model output
- **Browser automation:** Anchor Browser (cloud sessions, agent tasks, live view, CDP)
- **LLM:** Anthropic API with Claude Haiku, for title matching and checkout extraction
- **Mock mode:** `MOCK=1` replays fixtures with no network and no keys

## Run it

```bash
npm install
cp .env.example .env      # MOCK=1 by default: runs with no keys and no network
npm run dev:server        # API on http://localhost:8787
npm run dev:web           # app on http://localhost:5173 (proxies /api to the server)
```

Open http://localhost:5173. Add `?demo=1` to prefill the demo search (Street Fighter, 10018,
pick-your-own seats).

**Live mode:** in `.env` set `MOCK=0`, `ANCHOR_API_KEY`, `ANTHROPIC_API_KEY` and
`BOOK_CHAIN=fandango`.

**Mock-mode test inputs:** movie `zzz` → not playing, `fail` → search fails, `sold` → booking ends
sold out, `login` → booking asks you to sign in.

## Team

<names>
