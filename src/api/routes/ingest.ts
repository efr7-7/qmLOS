import { scopeId, type ScopeId } from "../../types.ts";
import { sendJson } from "../http.ts";
import { isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { usageCostUsd, type TokenLedgerEntry } from "../../ratelimit/token-ledger.ts";

interface OtelAttr {
  key?: string;
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
}

function attrMap(attrs: unknown): Map<string, string | number | boolean> {
  const out = new Map<string, string | number | boolean>();
  if (!Array.isArray(attrs)) return out;
  for (const raw of attrs as OtelAttr[]) {
    if (!raw?.key || !isObj(raw.value)) continue;
    const v = raw.value;
    if (v.stringValue !== undefined) out.set(raw.key, v.stringValue);
    else if (v.intValue !== undefined) out.set(raw.key, Number(v.intValue));
    else if (v.doubleValue !== undefined) out.set(raw.key, v.doubleValue);
    else if (v.boolValue !== undefined) out.set(raw.key, v.boolValue);
  }
  return out;
}

function num(attrs: Map<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const v = attrs.get(key);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
}

function str(attrs: Map<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = attrs.get(key);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function entryFromOtelRecord(
  attrs: Map<string, string | number | boolean>,
  timeNano: string | number | undefined,
  source: string,
): TokenLedgerEntry | null {
  const model = str(attrs, "gen_ai.request.model", "gen_ai.response.model", "model");
  const input = num(attrs, "gen_ai.usage.input_tokens", "input_tokens", "los.input_tokens");
  const output = num(attrs, "gen_ai.usage.output_tokens", "output_tokens", "los.output_tokens");
  if (!model && input === 0 && output === 0) return null;
  const cacheRead = num(attrs, "gen_ai.usage.cache_read_tokens", "cache_read_tokens", "cache_read_input_tokens");
  const cacheWrite = num(attrs, "gen_ai.usage.cache_write_tokens", "cache_creation_tokens", "cache_write_tokens");
  const reportedCost = num(attrs, "gen_ai.usage.cost", "cost_usd", "los.cost_usd");
  const principal =
    str(attrs, "los.principal_id", "user.email", "user.id", "user_id", "user.account_uuid", "enduser.id") ||
    "external:unknown";
  const harness = str(attrs, "los.harness", "gen_ai.system");
  const at = timeNano ? Math.round(Number(timeNano) / 1_000_000) : Date.now();
  const usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    costUsd: reportedCost,
  };
  const { costUsd, estimated } = usageCostUsd(usage);
  return {
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    principalId: principal,
    scopeLabel: scopeId("personal", principal) as ScopeId,
    model: model || "unknown",
    phase: "external",
    source,
    ...(harness ? { harness } : {}),
    input,
    output,
    cacheRead,
    cacheWrite,
    costUsd,
    estimated,
  };
}

async function postOtelIngest(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.tokenLedger) return sendJson(res, 200, { accepted: 0 });
  if (!isObj(body)) return sendJson(res, 400, { error: "bad_request", message: "expected an OTLP JSON payload" });
  let accepted = 0;
  const resourceGroups = [
    ...(Array.isArray(body.resourceSpans) ? body.resourceSpans : []),
    ...(Array.isArray(body.resourceLogs) ? body.resourceLogs : []),
  ];
  for (const group of resourceGroups) {
    if (!isObj(group)) continue;
    const resourceAttrs = attrMap(isObj(group.resource) ? group.resource.attributes : undefined);
    const source = str(resourceAttrs, "service.name") || "external";
    const scopeGroups = [
      ...(Array.isArray(group.scopeSpans) ? group.scopeSpans : []),
      ...(Array.isArray(group.scopeLogs) ? group.scopeLogs : []),
    ];
    for (const scopeGroup of scopeGroups) {
      if (!isObj(scopeGroup)) continue;
      const records = [
        ...(Array.isArray(scopeGroup.spans) ? scopeGroup.spans : []),
        ...(Array.isArray(scopeGroup.logRecords) ? scopeGroup.logRecords : []),
      ];
      for (const record of records) {
        if (!isObj(record)) continue;
        const attrs = attrMap(record.attributes);
        for (const [key, value] of resourceAttrs) if (!attrs.has(key)) attrs.set(key, value);
        const entry = entryFromOtelRecord(
          attrs,
          (record.startTimeUnixNano ?? record.timeUnixNano) as string | number | undefined,
          source,
        );
        if (!entry) continue;
        await deps.tokenLedger.record(entry);
        accepted += 1;
      }
    }
  }
  deps.auditLog?.record({
    at: Date.now(),
    principalId: ctx.actor?.p ?? "ingest",
    action: "utb.ingest.otel",
    resource: String(accepted),
    scopeLabel: orgScope() as ScopeId,
  });
  return sendJson(res, 200, { accepted });
}

export const ingestRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/ingest/otel", auth: "source", handle: postOtelIngest },
  { method: "POST", path: "/v1/ingest/otel/v1/traces", auth: "source", handle: postOtelIngest },
  { method: "POST", path: "/v1/ingest/otel/v1/logs", auth: "source", handle: postOtelIngest },
];
