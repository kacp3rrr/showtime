// Payment guard (lane C), shared by the Booker and scripts/spike-booker.ts. Strictly read-only: it
// reads the URL and queries the DOM of the page and every frame; it never clicks, types or fills.
//
// Trip if ANY of:
//   a. the page URL looks like a payment step;
//   b. a VISIBLE card input exists in the page or any frame (cross-origin included);
//   c. a VISIBLE password field exists (→ needs_user, not handoff);
//   d. a payment-processor iframe is visible and at least 150×40 px.
// Hidden or tiny processor iframes (Fandango preloads one on the seat map) are ignored and logged once.
import type { connectBrowser } from "anchorbrowser";

type Browser = Awaited<ReturnType<typeof connectBrowser>>;
export type Page = ReturnType<ReturnType<Browser["contexts"]>[number]["pages"]>[number];

export const PAY_URL = /payment|billing|checkout\/(pay|review)|purchase|wallet/i;
export const PAY_IFRAME = /stripe|braintree|adyen|cybersource|paypal|spreedly/i;
const MIN_IFRAME = { w: 150, h: 40 };

export type IgnoredIframe = { src: string; w: number; h: number; visible: boolean };
export type GuardResult = {
  tripped: boolean;
  reasons: string[]; // e.g. ["url"], ["card-input", "pay-iframe"], ["password"]
  signIn: boolean; // a password field fired it → needs_user
  ignoredIframes: IgnoredIframe[];
};
type FrameScan = { card: boolean; password: boolean; iframes: (IgnoredIframe & { big: boolean })[] };

// Runs inside each frame. A string so tsx/esbuild can't inject helpers (__name) into page context.
// Visible = rendered box > 0, not display:none / visibility:hidden, and offsetParent set; position:fixed
// elements always have a null offsetParent, so those count as visible when the other checks pass.
const SCAN = `(() => {
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return (el.offsetParent !== null || s.position === "fixed") && r.width > 0 && r.height > 0 &&
      s.display !== "none" && s.visibility !== "hidden";
  };
  const any = (sel) => [...document.querySelectorAll(sel)].some(visible);
  const card = any('input[autocomplete^="cc-"], input[name*="cvv" i], input[name*="cvc" i], ' +
    'input[name*="cardnumber" i], input[name*="card_number" i]');
  const password = any('input[type="password"]');
  const iframes = [...document.querySelectorAll("iframe[src]")]
    .filter((f) => ${PAY_IFRAME}.test(f.getAttribute("src") || ""))
    .map((f) => {
      const r = f.getBoundingClientRect();
      const v = visible(f);
      return { src: (f.getAttribute("src") || "").slice(0, 120), w: Math.round(r.width), h: Math.round(r.height),
        visible: v, big: v && r.width >= ${MIN_IFRAME.w} && r.height >= ${MIN_IFRAME.h} };
    });
  return { card, password, iframes };
})()`;

const loggedDefault = new Set<string>();

/**
 * Checks one page (main document + every frame). `logged` dedupes the "ignored iframe" log line;
 * pass one Set per booking so each run logs each iframe once.
 */
export async function checkGuard(
  page: Page,
  { log = console.log, logged = loggedDefault }: { log?: (m: string) => void; logged?: Set<string> } = {},
): Promise<GuardResult> {
  const reasons = new Set<string>();
  if (PAY_URL.test(page.url())) reasons.add("url");

  const ignoredIframes: IgnoredIframe[] = [];
  const scans = await Promise.all(
    page.frames().map((f) => (f.evaluate(SCAN) as Promise<FrameScan>).catch(() => undefined)),
  );
  for (const scan of scans) {
    if (!scan) continue; // detached or navigating frame
    if (scan.card) reasons.add("card-input");
    if (scan.password) reasons.add("password");
    for (const { big, ...f } of scan.iframes) {
      if (big) reasons.add("pay-iframe");
      else ignoredIframes.push(f);
    }
  }
  for (const f of ignoredIframes) {
    if (logged.has(f.src)) continue;
    logged.add(f.src);
    log(`guard: ignoring payment iframe ${f.src} (${f.w}x${f.h}, visible ${f.visible ? "yes" : "no"})`);
  }
  const list = [...reasons];
  return { tripped: list.length > 0, reasons: list, signIn: reasons.has("password"), ignoredIframes };
}
