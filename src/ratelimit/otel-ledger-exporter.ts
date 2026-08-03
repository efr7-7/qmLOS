import { randomBytes } from "node:crypto";
import type { TokenLedger, TokenLedgerEntry } from "./token-ledger.ts";

export interface OtelExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  flushIntervalMs?: number;
  maxBatch?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_FLUSH_MS = 5_000;
const DEFAULT_MAX_BATCH = 64;
const MAX_BUFFER = 2_048;

function attr(key: string, value: string | number | boolean): Record<string, unknown> {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number" && Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  return { key, value: { stringValue: value } };
}

function spanFromEntry(entry: TokenLedgerEntry): Record<string, unknown> {
  const startNs = String(BigInt(Math.max(0, Math.round(entry.at))) * 1_000_000n);
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    name: `gen_ai.inference ${entry.model}`,
    kind: 3,
    startTimeUnixNano: startNs,
    endTimeUnixNano: startNs,
    attributes: [
      attr("gen_ai.operation.name", "inference"),
      attr("gen_ai.request.model", entry.model),
      attr("gen_ai.usage.input_tokens", entry.input),
      attr("gen_ai.usage.output_tokens", entry.output),
      attr("los.principal_id", entry.principalId),
      attr("los.scope", entry.scopeLabel),
      attr("los.phase", entry.phase),
      attr("los.cost_usd", entry.costUsd),
      attr("los.cache_read_tokens", entry.cacheRead),
      attr("los.cache_write_tokens", entry.cacheWrite),
      attr("los.cost_estimated", entry.estimated),
      ...(entry.sessionId ? [attr("los.session_id", entry.sessionId)] : []),
      ...(entry.runId ? [attr("los.run_id", entry.runId)] : []),
      ...(entry.harness ? [attr("los.harness", entry.harness)] : []),
    ],
    status: {},
  };
}

export interface OtelLedgerExporter {
  ledger: TokenLedger;
  flush(): Promise<void>;
  stop(): void;
}

export function wrapLedgerWithOtelExport(inner: TokenLedger, opts: OtelExporterOptions): OtelLedgerExporter {
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  const doFetch = opts.fetchFn ?? fetch;
  const url = `${opts.endpoint.replace(/\/+$/, "")}/v1/traces`;
  const buffer: TokenLedgerEntry[] = [];
  let inFlight = false;

  async function flush(): Promise<void> {
    if (inFlight || !buffer.length) return;
    inFlight = true;
    const batch = buffer.splice(0, maxBatch);
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [attr("service.name", opts.serviceName ?? "los-core")] },
          scopeSpans: [{ scope: { name: "los.token-ledger" }, spans: batch.map(spanFromEntry) }],
        },
      ],
    };
    try {
      await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        body: JSON.stringify(payload),
      });
    } catch {
      void 0;
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => void flush(), flushIntervalMs);
  timer.unref?.();

  const ledger: TokenLedger = {
    record(entry) {
      buffer.push(entry);
      if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
      if (buffer.length >= maxBatch) void flush();
      return inner.record(entry);
    },
    summary: (groupBy, queryOpts) => inner.summary(groupBy, queryOpts),
    list: (queryOpts) => inner.list(queryOpts),
  };

  return {
    ledger,
    flush,
    stop() {
      clearInterval(timer);
    },
  };
}

export function otelExporterOptionsFromEnv(env: NodeJS.ProcessEnv): OtelExporterOptions | undefined {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return {
    endpoint,
    ...(Object.keys(headers).length ? { headers } : {}),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "los-core",
  };
}
