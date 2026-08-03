import { test } from "node:test";
import assert from "node:assert/strict";
import { seedDemoData, type DemoSeedStores } from "../src/demo/seed.ts";
import { createMemoryTokenLedger } from "../src/ratelimit/token-ledger.ts";
import { createMemoryTeamStore } from "../src/directory/team-store.ts";
import { createMemoryAllocationStore } from "../src/ratelimit/allocation-store.ts";
import { createMemoryRunOutcomeStore } from "../src/runs/run-outcome.ts";
import { createAdminGrantStore } from "../src/admin/admin-grant-store.ts";

function freshStores(): DemoSeedStores {
  return {
    tokenLedger: createMemoryTokenLedger(),
    teams: createMemoryTeamStore(),
    allocations: createMemoryAllocationStore(),
    runOutcomes: createMemoryRunOutcomeStore(),
    adminGrants: createAdminGrantStore(),
    orgId: "acme",
  };
}

test("demo seed: populates teams, allocations, ledger, outcomes, and admin grant", async () => {
  const stores = freshStores();
  const now = Date.parse("2026-08-01T12:00:00Z");
  const result = await seedDemoData(stores, { now });
  assert.equal(result.seeded, true);
  assert.equal(result.ledgerEntries, 2000);
  assert.equal(result.runOutcomes, 120);

  const teams = await stores.teams.list();
  assert.deepEqual(teams.map((t) => t.id).sort(), ["growth", "platform"]);
  assert.equal(await stores.teams.teamOf("demo"), "platform");
  assert.equal(await stores.teams.teamOf("ines"), "growth");

  const allocations = await stores.allocations.list();
  assert.equal(allocations.length, 4);
  const org = allocations.find((a) => a.subject === "org");
  assert.equal(org?.limitUsd, 400);
  assert.equal(org?.hard, true);
  const growth = allocations.find((a) => a.subject === "team:growth");
  assert.equal(growth?.hard, false);
  const ines = allocations.find((a) => a.subject === "principal:ines");
  assert.equal(ines?.limitUsd, 5);
  assert.equal(ines?.windowMs, 86_400_000);

  const grants = await stores.adminGrants.list();
  assert.ok(grants.some((g) => g.principalId === "demo" && g.scopeId === "org:acme" && g.role === "org_admin"));

  const entries = await stores.tokenLedger.list({ limit: 5000 });
  assert.equal(entries.length, 2000);
  assert.ok(entries.every((e) => e.at <= now && e.at >= now - 30 * 86_400_000));
  assert.ok(entries.every((e) => e.costUsd > 0 && e.input > 0));

  const byModel = await stores.tokenLedger.summary("model");
  assert.deepEqual(
    byModel.map((r) => r.key).sort(),
    ["claude-fable-5", "claude-sonnet-5", "gpt-5.2"],
  );

  const bySource = await stores.tokenLedger.summary("source");
  const claudeCode = bySource.find((r) => r.key === "claude-code");
  const los = bySource.find((r) => r.key === "los");
  assert.ok(claudeCode && claudeCode.calls > 300 && claudeCode.calls < 700);
  assert.ok(los && los.calls + claudeCode.calls === 2000);

  const byPhase = await stores.tokenLedger.summary("phase");
  const phases = byPhase.map((r) => r.key).sort();
  assert.deepEqual(phases, ["compact", "detect", "external", "screen", "turn"]);

  const totalCost = byModel.reduce((sum, r) => sum + r.costUsd, 0);
  assert.ok(totalCost > 40 && totalCost < 400);
  assert.ok(Math.abs(totalCost - result.totalCostUsd) < 0.01);

  const byPrincipal = await stores.tokenLedger.summary("principal");
  assert.deepEqual(byPrincipal.map((r) => r.key).sort(), ["demo", "ines", "maya", "tomas"]);

  const outcomeSummary = await stores.runOutcomes.summary();
  const runs = outcomeSummary.reduce((sum, r) => sum + r.runs, 0);
  assert.equal(runs, 120);
  const kinds = outcomeSummary.reduce(
    (acc, r) => {
      for (const [kind, count] of Object.entries(r.byOutcome)) acc[kind] = (acc[kind] ?? 0) + count;
      return acc;
    },
    {} as Record<string, number>,
  );
  assert.ok((kinds["code-pushed"] ?? 0) > 0);
  assert.ok((kinds["artifact"] ?? 0) > 0);
  assert.ok((kinds["sent-internal"] ?? 0) > 0);
  assert.ok((kinds["chat"] ?? 0) > 0);
});

test("demo seed: second call is a no-op for data but keeps the admin grant", async () => {
  const stores = freshStores();
  const first = await seedDemoData(stores);
  assert.equal(first.seeded, true);
  const second = await seedDemoData(stores);
  assert.equal(second.seeded, false);
  assert.equal(second.ledgerEntries, 0);
  const entries = await stores.tokenLedger.list({ limit: 5000 });
  assert.equal(entries.length, 2000);
  assert.equal((await stores.allocations.list()).length, 4);
  const grants = await stores.adminGrants.list();
  assert.equal(grants.filter((g) => g.principalId === "demo").length, 1);
});

test("demo seed: does not touch a ledger that already has entries", async () => {
  const stores = freshStores();
  stores.tokenLedger.record({
    at: Date.now(),
    principalId: "existing",
    scopeLabel: "personal:existing",
    model: "claude-fable-5",
    phase: "turn",
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0.01,
    estimated: false,
  });
  const result = await seedDemoData(stores);
  assert.equal(result.seeded, false);
  assert.equal((await stores.teams.list()).length, 0);
  assert.equal((await stores.allocations.list()).length, 0);
  assert.equal((await stores.tokenLedger.list({ limit: 100 })).length, 1);
  assert.ok((await stores.adminGrants.list()).some((g) => g.principalId === "demo"));
});
