// Lane A owns this file. Stub so the live (MOCK=0) route path compiles and fails cleanly.
import type { SearchJob, SearchRequest } from "../../../shared/types.js";

export async function runSearch(_req: SearchRequest, _job: SearchJob): Promise<void> {
  throw new Error("runSearch not implemented (lane A)");
}
