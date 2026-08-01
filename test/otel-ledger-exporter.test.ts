import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTokenLedger, entryFromUsage } from "../src/ratelimit/token-ledger.ts";
import { otelExporterOptionsFromEnv, wrapLedgerWithOtelExport } from "../src/ratelimit/otel-ledger-exporter.ts";
import type { ScopeId } from "../src/types.ts";

const entry = (i: number) =>
  entryFromUsage({
    principalId: "U1",
    scopeLabel: "personal:U1" as ScopeId,
    model: "m1",
    phase: "turn",
    usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, totalTokens: 180, costUsd: 0.01 },
    sessionId: "s1",
    runId: `r${i}`,
    at: 1_700_000_000_000 + i,
  });

test("otel exporter: batches spans, posts GenAI attributes, and still records to the inner ledger", async () => {
  const posts: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: any, init: any) => {
    posts.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const inner = createMemoryTokenLedger();
  const exporter = wrapLedgerWithOtelExport(inner, {
    endpoint: "http://collector:4318/",
    headers: { authorization: "Bearer x" },
    serviceName: "los-test",
    maxBatch: 2,
    flushIntervalMs: 60_000,
    fetchFn,
  });

  await exporter.ledger.record(entry(1));
  assert.equal(posts.length, 0, "below batch size, nothing posted yet");
  await exporter.ledger.record(entry(2));
  await exporter.flush();
  assert.equal(posts.length, 1);

  const post = posts[0]!;
  assert.equal(post.url, "http://collector:4318/v1/traces");
  assert.equal(post.headers.authorization, "Bearer x");
  const resource = post.body.resourceSpans[0];
  assert.equal(resource.resource.attributes[0].value.stringValue, "los-test");
  const spans = resource.scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  const attrs = Object.fromEntries(spans[0].attributes.map((a: any) => [a.key, a.value]));
  assert.equal(attrs["gen_ai.request.model"].stringValue, "m1");
  assert.equal(attrs["gen_ai.usage.input_tokens"].intValue, "100");
  assert.equal(attrs["gen_ai.usage.output_tokens"].intValue, "50");
  assert.equal(attrs["los.principal_id"].stringValue, "U1");
  assert.equal(attrs["los.phase"].stringValue, "turn");
  assert.equal(attrs["los.cost_estimated"].boolValue, false);
  assert.equal(spans[0].traceId.length, 32);
  assert.equal(spans[0].spanId.length, 16);

  assert.equal((await inner.list()).length, 2, "inner ledger still receives every entry");
  exporter.stop();
});

test("otel exporter: collector failures never break recording", async () => {
  const fetchFn = (async () => {
    throw new Error("collector down");
  }) as unknown as typeof fetch;
  const inner = createMemoryTokenLedger();
  const exporter = wrapLedgerWithOtelExport(inner, {
    endpoint: "http://collector:4318",
    maxBatch: 1,
    flushIntervalMs: 60_000,
    fetchFn,
  });
  await exporter.ledger.record(entry(1));
  await exporter.flush();
  assert.equal((await inner.list()).length, 1);
  exporter.stop();
});

test("otelExporterOptionsFromEnv parses endpoint, headers, and service name", () => {
  assert.equal(otelExporterOptionsFromEnv({}), undefined);
  const opts = otelExporterOptionsFromEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://langfuse.example/api/public/otel",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Basic abc, x-extra=1",
    OTEL_SERVICE_NAME: "los-prod",
  });
  assert.equal(opts!.endpoint, "https://langfuse.example/api/public/otel");
  assert.deepEqual(opts!.headers, { authorization: "Basic abc", "x-extra": "1" });
  assert.equal(opts!.serviceName, "los-prod");
});
