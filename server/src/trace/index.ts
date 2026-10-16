// Lane D: Arize tracing over OTLP. No-op when MOCK=1 or the Arize keys are missing.
// Only small scalar attributes go into spans: never page HTML, and digit runs that could be card
// numbers are scrubbed from every string value.
import { SpanStatusCode, trace, type Attributes, type AttributeValue } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor, NodeTracerProvider, type ReadableSpan, type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { env } from "../env.js";

const ENDPOINT = "https://otlp.arize.com/v1/traces";
const CARDISH = /\b\d{12,19}\b/g;
const MAX_STR = 500;

export const tracingEnabled = !env.MOCK && !!env.ARIZE_SPACE_ID && !!env.ARIZE_API_KEY;

/** Result of the most recent OTLP export, for health checks and the smoke test. */
export type ExportReport = { ok: boolean; spans: number; status?: number; error?: string; at: string };
let lastExport: ExportReport | undefined;
export const lastExportReport = () => lastExport;

/** Wraps the OTLP exporter to remember whether each batch was accepted (and the HTTP status if not). */
class ReportingExporter implements SpanExporter {
  constructor(private inner: SpanExporter) {}
  export(spans: ReadableSpan[], done: Parameters<SpanExporter["export"]>[1]) {
    this.inner.export(spans, (result) => {
      const err = result.error as (Error & { code?: number }) | undefined;
      lastExport = {
        ok: result.code === 0, // ExportResultCode.SUCCESS
        spans: spans.length,
        status: err?.code,
        error: err ? scrub(err.message) : undefined,
        at: new Date().toISOString(),
      };
      if (!lastExport.ok) console.error(`[trace] export failed (HTTP ${err?.code ?? "?"}): ${lastExport.error}`);
      done(result);
    });
  }
  shutdown() { return this.inner.shutdown(); }
  forceFlush() { return this.inner.forceFlush?.() ?? Promise.resolve(); }
}

let provider: NodeTracerProvider | undefined;

/** Idempotent; safe to call from the server and from CLI scripts. */
export function initTracing(): boolean {
  if (!tracingEnabled) return false;
  if (provider) return true;
  const exporter = new ReportingExporter(new OTLPTraceExporter({
    url: ENDPOINT,
    headers: { space_id: env.ARIZE_SPACE_ID, api_key: env.ARIZE_API_KEY },
    timeoutMillis: 15_000,
  }));
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      model_id: env.ARIZE_PROJECT,
      "openinference.project.name": env.ARIZE_PROJECT,
      "service.name": "showtime-server",
    }),
    spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 2000 })],
  });
  provider.register();
  // Flush on the way out. (Scripts that call process.exit should await flushTracing() first.)
  process.once("beforeExit", () => void flushTracing());
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void flushTracing());
  console.log(`[trace] Arize tracing on → project "${env.ARIZE_PROJECT}"`);
  return true;
}

/** Push pending spans now; resolves with the last export report (undefined if nothing was sent). */
export async function flushTracing(): Promise<ExportReport | undefined> {
  if (!provider) return undefined;
  await provider.forceFlush().catch(() => {});
  return lastExport;
}

function scrub(v: string): string {
  return v.replace(CARDISH, "[redacted]").slice(0, MAX_STR);
}

function clean(attrs: Record<string, unknown>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    let val: AttributeValue | undefined;
    if (typeof v === "string") val = scrub(v);
    else if (typeof v === "number" || typeof v === "boolean") val = v;
    else if (Array.isArray(v)) val = v.map((x) => scrub(String(x)));
    if (val !== undefined) out[k] = val;
  }
  return out;
}

export type SpanHandle = { set: (attrs: Record<string, unknown>) => void };

/**
 * Runs `fn` inside an AGENT span. Records duration_ms and an outcome ("ok" unless `fn` sets one;
 * "error" if it throws, with the scrubbed message). Without tracing it just runs `fn`.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: (span: SpanHandle) => Promise<T>,
): Promise<T> {
  if (!initTracing()) return fn({ set: () => {} });
  const tracer = trace.getTracer("showtime");
  return tracer.startActiveSpan(name, async (span) => {
    const t0 = Date.now();
    let outcome: unknown;
    span.setAttributes(clean({ "openinference.span.kind": "AGENT", ...attrs }));
    const handle: SpanHandle = {
      set: (more) => {
        if ("outcome" in more) outcome = more.outcome;
        span.setAttributes(clean(more));
      },
    };
    try {
      const result = await fn(handle);
      span.setAttributes(clean({ outcome: outcome ?? "ok", duration_ms: Date.now() - t0 }));
      if (outcome === "error" || outcome === "failed" || outcome === "blocked") span.setStatus({ code: SpanStatusCode.ERROR });
      return result;
    } catch (err) {
      const msg = scrub(err instanceof Error ? err.message : String(err));
      span.recordException({ name: err instanceof Error ? err.name : "Error", message: msg });
      span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
      span.setAttributes(clean({ outcome: "error", duration_ms: Date.now() - t0, error: msg }));
      throw err;
    } finally {
      span.end();
    }
  });
}

initTracing();
