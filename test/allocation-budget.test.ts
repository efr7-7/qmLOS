import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudgetTracker } from "../src/ratelimit/budget.ts";
import { createMemoryTokenLedger, entryFromUsage } from "../src/ratelimit/token-ledger.ts";
import { createMemoryTeamStore } from "../src/directory/team-store.ts";
import { createMemoryAllocationStore } from "../src/ratelimit/allocation-store.ts";
import { createAllocationBudgetTracker } from "../src/ratelimit/allocation-budget.ts";
import type { ScopeId } from "../src/types.ts";

const DAY = 86_400_000;

async function fixture() {
  const ledger = createMemoryTokenLedger();
  const teams = createMemoryTeamStore();
  const allocations = createMemoryAllocationStore();
  const warnings: string[] = [];
  const tracker = createAllocationBudgetTracker(createBudgetTracker({}), {
    teams,
    allocations,
    ledger,
    warn: (m) => warnings.push(m),
  });
  await teams.upsert({ id: "eng", name: "Engineering", parentId: null });
  await teams.upsert({ id: "eng-platform", name: "Platform", parentId: "eng" });
  await teams.setMember("eng-platform", "U1");
  await teams.setMember("eng", "U2");
  return { ledger, teams, allocations, tracker, warnings };
}

function spend(principalId: string, costUsd: number, at: number) {
  return entryFromUsage({
    principalId,
    scopeLabel: `personal:${principalId}` as ScopeId,
    model: "m",
    phase: "turn",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, costUsd },
    at,
  });
}

test("hard principal allocation refuses at the limit; other principals unaffected", async () => {
  const { ledger, allocations, tracker } = await fixture();
  await allocations.upsert({ id: "a1", subject: "principal:U1", limitUsd: 5, windowMs: DAY, hard: true });
  await ledger.record(spend("U1", 3, 1000));
  assert.equal((await tracker.check("U1", 2000)).allowed, true);
  await ledger.record(spend("U1", 2.5, 1500));
  const refused = await tracker.check("U1", 2000);
  assert.equal(refused.allowed, false);
  assert.equal(refused.limitUsd, 5);
  assert.equal((await tracker.check("U2", 2000)).allowed, true);
});

test("team allocation aggregates descendant sub-team members up the hierarchy", async () => {
  const { ledger, allocations, tracker } = await fixture();
  await allocations.upsert({ id: "a2", subject: "team:eng", limitUsd: 10, windowMs: DAY, hard: true });
  await ledger.record(spend("U1", 6, 1000));
  await ledger.record(spend("U2", 5, 1000));
  const refusedPlatformMember = await tracker.check("U1", 2000);
  assert.equal(refusedPlatformMember.allowed, false, "sub-team member spend counts toward the parent team cap");
  const refusedDirectMember = await tracker.check("U2", 2000);
  assert.equal(refusedDirectMember.allowed, false);
});

test("soft allocation warns but allows; spend outside the window does not count", async () => {
  const { ledger, allocations, tracker, warnings } = await fixture();
  await allocations.upsert({ id: "a3", subject: "org", limitUsd: 4, windowMs: DAY, hard: false });
  await ledger.record(spend("U1", 5, 1000));
  const soft = await tracker.check("U1", 2000);
  assert.equal(soft.allowed, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /soft allocation a3 exceeded/);
  const later = await tracker.check("U1", 1000 + DAY + 1000);
  assert.equal(later.allowed, true);
  assert.equal(warnings.length, 1, "expired spend does not re-warn");
});

test("principal with no team and no allocations passes through to the inner tracker", async () => {
  const { tracker } = await fixture();
  assert.equal((await tracker.check("U9", 2000)).allowed, true);
});
