/** "2026-10-16T19:30:00" → "7:30 PM" (times are theater-local; no timezone math). */
export function clock(iso: string): string {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Local calendar date as YYYY-MM-DD, `offsetDays` from today. */
export function localDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const money = (n: number) => `$${n.toFixed(2)}`;
