// Lane C owns this file. Stubs so the live (MOCK=0) route path compiles and fails cleanly.
import type { BookingJob, BookingRequest, Showtime } from "../../../shared/types.js";

export async function runBooking(_req: BookingRequest, _showtime: Showtime, _job: BookingJob): Promise<void> {
  throw new Error("runBooking not implemented (lane C)");
}

export async function cancelBooking(_job: BookingJob): Promise<void> {
  throw new Error("cancelBooking not implemented (lane C)");
}

export async function continueBooking(_job: BookingJob): Promise<void> {
  throw new Error("continueBooking not implemented (lane C)");
}
