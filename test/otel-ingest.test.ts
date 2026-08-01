import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTokenLedger } from "../src/ratelimit/token-ledger.ts";
import { ingestRoutes } from "../src/api/routes/ingest.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

function ctxFor(body: unknown, ledger: ReturnType<typeof createMemoryTokenLedger>) {
  let statusCode = 0;
  let payload: unknown;
  const ctx = {
    res: {
      writeHead: () => {},
      end: () => {},
    },
    deps: { tokenLedger: ledger },
    body,
    url: new URL("http://localhost/v1/ingest/otel"),
    method: "POST",
    pathname: "/v1/ingest/otel",
  } as unknown as ApiCtx;
  (ctx.res as unknown as { writeHead: (code: number) => void }).writeHead = (code: number) => {
    statusCode = code;
  };
  (ctx.res as unknown as { end: (body?: string) => void }).end = (raw?: string) => {
    if (raw) payload = JSON.parse(raw);
  };
  return { ctx, result: () => ({ statusCode, payload: payload as { accepted?: number } }) };
}

const handle = ingestRoutes[0]!.handle;

test("otel ingest: GenAI trace spans land in the ledger with source and external phase", async () => {
  const ledger = createMemoryTokenLedger();
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeSpans: [
          {
            spans: [
              {
                startTimeUnixNano: "1700000000000000000",
                attributes: [
                  { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "1200" } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: "300" } },
                  { key: "user.email", value: { stringValue: "ada@acme.com" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const { ctx, result } = ctxFor(body, ledger);
  await handle(ctx);
  assert.equal(result().payload?.accepted, 1);
  const rows = await ledger.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "claude-code");
  assert.equal(rows[0]!.phase, "external");
  assert.equal(rows[0]!.principalId, "ada@acme.com");
  assert.equal(rows[0]!.model, "claude-sonnet-5");
  assert.equal(rows[0]!.input, 1200);
  assert.equal(rows[0]!.at, 1_700_000_000_000);
  assert.equal(rows[0]!.estimated, true);

  const bySource = await ledger.summary("source");
  assert.equal(bySource[0]!.key, "claude-code");
});

test("otel ingest: Claude Code style log records with cost land exact", async () => {
  const ledger = createMemoryTokenLedger();
  const body = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1700000001000000000",
                attributes: [
                  { key: "model", value: { stringValue: "claude-fable-5" } },
                  { key: "input_tokens", value: { intValue: 500 } },
                  { key: "output_tokens", value: { intValue: 200 } },
                  { key: "cache_read_tokens", value: { intValue: 90 } },
                  { key: "cost_usd", value: { doubleValue: 0.031 } },
                  { key: "user.id", value: { stringValue: "U-77" } },
                ],
              },
              { attributes: [{ key: "event.name", value: { stringValue: "unrelated" } }] },
            ],
          },
        ],
      },
    ],
  };
  const { ctx, result } = ctxFor(body, ledger);
  await handle(ctx);
  assert.equal(result().payload?.accepted, 1);
  const rows = await ledger.list();
  assert.equal(rows[0]!.costUsd, 0.031);
  assert.equal(rows[0]!.estimated, false);
  assert.equal(rows[0]!.cacheRead, 90);
  assert.equal(rows[0]!.principalId, "U-77");
});

test("otel ingest: malformed payloads are rejected without recording", async () => {
  const ledger = createMemoryTokenLedger();
  const { ctx } = ctxFor("not-an-object", ledger);
  await handle(ctx);
  assert.equal((await ledger.list()).length, 0);
});
