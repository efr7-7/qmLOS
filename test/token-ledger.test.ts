import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryTokenLedger,
  entryFromUsage,
  estimatedEntryFromInputTokens,
  usageCostUsd,
} from "../src/ratelimit/token-ledger.ts";
import type { ScopeId } from "../src/types.ts";

const scope = "personal:U1" as ScopeId;

test("usageCostUsd: harness-reported cost is authoritative, zero cost falls back to estimate", () => {
  const exact = usageCostUsd({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, costUsd: 0.42 });
  assert.equal(exact.costUsd, 0.42);
  assert.equal(exact.estimated, false);

  const estimated = usageCostUsd({
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2_000_000,
    costUsd: 0,
  });
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.costUsd, 20);
});

test("usageCostUsd estimate charges cache tokens as input", () => {
  const r = usageCostUsd({
    input: 0,
    output: 0,
    cacheRead: 2_000_000,
    cacheWrite: 0,
    totalTokens: 2_000_000,
    costUsd: 0,
  });
  assert.equal(r.costUsd, 10);
});

test("entryFromUsage and estimatedEntryFromInputTokens shape entries", () => {
  const exact = entryFromUsage({
    principalId: "U1",
    scopeLabel: scope,
    model: "m-big",
    phase: "turn",
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, costUsd: 0.5 },
    sessionId: "s1",
    runId: "r1",
    at: 123,
  });
  assert.equal(exact.at, 123);
  assert.equal(exact.costUsd, 0.5);
  assert.equal(exact.estimated, false);
  assert.equal(exact.sessionId, "s1");
  assert.equal(exact.runId, "r1");

  const est = estimatedEntryFromInputTokens({
    principalId: "U1",
    scopeLabel: scope,
    model: "m-small",
    phase: "detect",
    inputTokens: 1_000_000,
    at: 5,
  });
  assert.equal(est.estimated, true);
  assert.equal(est.costUsd, 5);
  assert.equal(est.output, 0);
});

test("memory ledger: summary groups and filters, list respects limit and order", async () => {
  const ledger = createMemoryTokenLedger();
  const usage = (costUsd: number) => ({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, costUsd });
  await ledger.record(
    entryFromUsage({ principalId: "U1", scopeLabel: scope, model: "a", phase: "turn", usage: usage(1), at: 10 }),
  );
  await ledger.record(
    entryFromUsage({ principalId: "U1", scopeLabel: scope, model: "b", phase: "turn", usage: usage(2), at: 20 }),
  );
  await ledger.record(
    entryFromUsage({ principalId: "U2", scopeLabel: "personal:U2" as ScopeId, model: "a", phase: "screen", usage: usage(4), at: 30 }),
  );

  const byPrincipal = await ledger.summary("principal");
  assert.equal(byPrincipal.length, 2);
  assert.equal(byPrincipal[0]!.key, "U2");
  assert.equal(byPrincipal[0]!.costUsd, 4);
  assert.equal(byPrincipal[1]!.costUsd, 3);

  const byModel = await ledger.summary("model", { principalId: "U1" });
  assert.equal(byModel.length, 2);
  assert.equal(byModel.find((r) => r.key === "a")!.calls, 1);

  const windowed = await ledger.summary("phase", { since: 15, until: 25 });
  assert.equal(windowed.length, 1);
  assert.equal(windowed[0]!.key, "turn");
  assert.equal(windowed[0]!.costUsd, 2);

  const listed = await ledger.list({ limit: 2 });
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.at, 30);
  assert.equal(listed[1]!.at, 20);
});

test("memory ledger: bounded retention drops oldest entries", async () => {
  const ledger = createMemoryTokenLedger({ max: 2 });
  for (let i = 0; i < 5; i++) {
    await ledger.record(
      estimatedEntryFromInputTokens({
        principalId: "U1",
        scopeLabel: scope,
        model: "m",
        phase: "turn",
        inputTokens: 1,
        at: i,
      }),
    );
  }
  const listed = await ledger.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.at, 4);
});
