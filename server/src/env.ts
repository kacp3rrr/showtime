// Single source of configuration. Read keys from here only; never log values.
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo-root .env, regardless of the cwd the server is started from.
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env"), quiet: true });

export type Env = {
  MOCK: boolean;
  PORT: number;
  ANCHOR_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL_FAST: string;
  ARIZE_SPACE_ID: string;
  ARIZE_API_KEY: string;
  ARIZE_PROJECT: string;
  BOOK_CHAIN: string;
  SEARCH_SOURCES: string[];
  ELEVENLABS_API_KEY: string;
  FINDER_AGENT: boolean;
};

// Needed for real (non-mock) runs. Arize and ElevenLabs are optional: tracing no-ops without them.
const REQUIRED_WHEN_LIVE = ["ANCHOR_API_KEY", "ANTHROPIC_API_KEY"] as const;

const str = (k: string, fallback = "") => (process.env[k] ?? "").trim() || fallback;

function load(): Env {
  const mock = str("MOCK", "1") === "1";
  if (!mock) {
    const missing = REQUIRED_WHEN_LIVE.filter((k) => !str(k));
    if (missing.length) {
      throw new Error(
        `Missing required env vars (MOCK!=1): ${missing.join(", ")}. ` +
          `Set them in the repo-root .env (see .env.example) or run with MOCK=1.`,
      );
    }
  }
  const port = Number(str("PORT", "8787"));
  if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");

  return {
    MOCK: mock,
    PORT: port,
    ANCHOR_API_KEY: str("ANCHOR_API_KEY"),
    ANTHROPIC_API_KEY: str("ANTHROPIC_API_KEY"),
    ANTHROPIC_MODEL_FAST: str("ANTHROPIC_MODEL_FAST", "claude-haiku-5-5"),
    ARIZE_SPACE_ID: str("ARIZE_SPACE_ID"),
    ARIZE_API_KEY: str("ARIZE_API_KEY"),
    ARIZE_PROJECT: str("ARIZE_PROJECT", "showtime"),
    BOOK_CHAIN: str("BOOK_CHAIN", "fandango").toLowerCase(),
    SEARCH_SOURCES: str("SEARCH_SOURCES", "fandango,amc")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    ELEVENLABS_API_KEY: str("ELEVENLABS_API_KEY"),
    FINDER_AGENT: str("FINDER_AGENT", "0") === "1",
  };
}

export const env: Env = load();
