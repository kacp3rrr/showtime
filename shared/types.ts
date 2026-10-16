// Contracts shared by server/ and web/. FROZEN at 11:15 — changes are announced by a human (lane D).

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

// "pick" (added 2026-10-16, announced): the person chooses seats in the live seat map, then the agent continues.
export type BookingRequest = { showtime_id: string; party_size: number; seat_pref: "center" | "aisle" | "any" | "pick" };

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
