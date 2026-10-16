// Map the user's movie text to a title Fandango lists: cheap local match first, then one fast-model call.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";

export type TitleMatch = { matched?: string; did_you_mean: string[] };

const norm = (s: string) => s.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const MatchSchema = z.object({
  matched_title: z.string().nullable(),
  did_you_mean: z.array(z.string()),
});

let anthropic: Anthropic | undefined;

export async function matchTitle(query: string, titles: string[]): Promise<TitleMatch> {
  const q = norm(query);
  const exact = titles.find((t) => norm(t) === q);
  if (exact) return { matched: exact, did_you_mean: [] };
  const contains = titles.filter((t) => q.length >= 3 && norm(t).includes(q));
  if (contains.length === 1) return { matched: contains[0], did_you_mean: [] };
  if (!titles.length) return { did_you_mean: [] };

  try {
    anthropic ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 });
    const res = await anthropic.messages.parse({
      model: env.ANTHROPIC_MODEL_FAST,
      max_tokens: 2000,
      output_config: { effort: "low", format: zodOutputFormat(MatchSchema) },
      system:
        "You match a moviegoer's typed movie name to the exact title a ticketing site lists. " +
        "Allow typos, missing articles, sequel numbers written differently, and partial titles. " +
        "Set matched_title only when one listed title is clearly what they meant, copied exactly from the list. " +
        "Otherwise set matched_title to null and put up to 3 plausible listed titles in did_you_mean (exact copies; empty if none are close).",
      messages: [{ role: "user", content: `Typed: ${JSON.stringify(query)}\nListed titles:\n${titles.map((t) => `- ${t}`).join("\n")}` }],
    });
    const out = res.parsed_output;
    if (!out) return { did_you_mean: contains.slice(0, 3) };
    const listed = new Set(titles);
    return {
      matched: out.matched_title && listed.has(out.matched_title) ? out.matched_title : undefined,
      did_you_mean: out.did_you_mean.filter((t) => listed.has(t)).slice(0, 3),
    };
  } catch (err) {
    console.error("[finder] title match call failed:", err instanceof Error ? err.message : err);
    return contains.length ? { did_you_mean: contains.slice(0, 3) } : { did_you_mean: [] };
  }
}
