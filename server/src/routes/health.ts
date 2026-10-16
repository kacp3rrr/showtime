import { Router } from "express";
import { env } from "../env.js";

export const health = Router();

health.get("/api/health", (_req, res) => {
  res.json({ ok: true, mock: env.MOCK, sources: env.SEARCH_SOURCES, book_chain: env.BOOK_CHAIN });
});
