import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresTokenLedger } from "../src/ratelimit/postgres-token-ledger.ts";
import { entryFromUsage } from "../src/ratelimit/token-ledger.ts";
import type { ScopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres token ledger tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS token_ledger CASCADE");
  await p.end();
});

const scope = "personal:U1" as ScopeId;
const usage = (costUsd: number, input = 100, output = 50) => ({
  input,
  output,
  cacheRead: 7,
  cacheWrite: 3,
  totalTokens: input + output + 10,
  costUsd,
});

test("pg ledger: entries persist across instances and roll up by group", { skip }, async () => {
  const a = createPostgresTokenLedger(URL!);
  const b = createPostgresTokenLedger(URL!);

  await a.record(
    entryFromUsage({ principalId: "U1", scopeLabel: scope, model: "m1", phase: "turn", usage: usage(1), at: 10, sessionId: "s1", runId: "r1", harness: "claude" }),
  );
  await a.record(entryFromUsage({ principalId: "U1", scopeLabel: scope, model: "m2", phase: "screen", usage: usage(2), at: 20 }));
  await b.record(
    entryFromUsage({ principalId: "U2", scopeLabel: "personal:U2" as ScopeId, model: "m1", phase: "turn", usage: usage(4), at: 30, harness: "codex" }),
  );

  const byPrincipal = await b.summary("principal");
  assert.equal(byPrincipal.length, 2);
  assert.equal(byPrincipal[0]!.key, "U2");
  assert.equal(byPrincipal[0]!.costUsd, 4);
  assert.equal(byPrincipal[1]!.key, "U1");
  assert.equal(byPrincipal[1]!.calls, 2);
  assert.equal(byPrincipal[1]!.input, 200);
  assert.equal(byPrincipal[1]!.cacheRead, 14);

  const byModel = await a.summary("model", { principalId: "U1" });
  assert.equal(byModel.length, 2);

  const windowed = await a.summary("phase", { since: 15, until: 25 });
  assert.equal(windowed.length, 1);
  assert.equal(windowed[0]!.key, "screen");

  const byHarness = await a.summary("harness");
  assert.deepEqual(
    byHarness.map((row) => row.key),
    ["codex", "unknown", "claude"],
  );
  const claudeOnly = await a.summary("model", { harness: "claude" });
  assert.equal(claudeOnly.length, 1);
  assert.equal(claudeOnly[0]!.key, "m1");
});

test("pg ledger: list filters, orders newest-first, and preserves entry fields", { skip }, async () => {
  const ledger = createPostgresTokenLedger(URL!);
  await ledger.record(
    entryFromUsage({ principalId: "U1", scopeLabel: scope, model: "m1", phase: "turn", usage: usage(1), at: 10, sessionId: "s1", runId: "r1", harness: "claude" }),
  );
  await ledger.record(entryFromUsage({ principalId: "U1", scopeLabel: scope, model: "m1", phase: "turn", usage: usage(0), at: 20 }));

  const rows = await ledger.list({ principalId: "U1" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.at, 20);
  assert.equal(rows[0]!.estimated, true);
  assert.equal(rows[1]!.at, 10);
  assert.equal(rows[1]!.estimated, false);
  assert.equal(rows[1]!.sessionId, "s1");
  assert.equal(rows[1]!.runId, "r1");
  assert.equal(rows[1]!.costUsd, 1);
  assert.equal(rows[1]!.harness, "claude");
  assert.equal(rows[0]!.harness, undefined);

  const limited = await ledger.list({ limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0]!.at, 20);
});
