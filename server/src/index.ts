import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { tracingEnabled } from "./trace/index.js"; // initializes Arize tracing (no-op in mock / without keys)
import { api } from "./routes.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

app.use(api);

// Never leak stack traces to the client.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if ((err as { type?: string })?.type === "entity.parse.failed") return void res.status(400).json({ error: "invalid JSON body" });
  console.error("[server] unhandled:", err instanceof Error ? err.message : err);
  res.status(500).json({ error: "internal error" });
});

app.listen(env.PORT, () => {
  console.log(`[server] :${env.PORT} mock=${env.MOCK} tracing=${tracingEnabled} sources=${env.SEARCH_SOURCES.join(",")} book_chain=${env.BOOK_CHAIN}`);
});
