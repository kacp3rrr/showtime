import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BookingJob, BookingState, SearchJob } from "../../../shared/types.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(dir, name), "utf8")) as T;

export const searchFixture = load<SearchJob>("search_10018.json");
export const bookingFixtures = load<Record<BookingState, BookingJob>>("booking_states.json");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
