import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRun, createMemoryRunOutcomeStore } from "../src/runs/run-outcome.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { ScopeId } from "../src/types.ts";

function runFixture(overrides: {
  kind?: "dm" | "channel" | "group";
  attachments?: boolean;
  status?: "ok" | "refused";
}): Run {
  return {
    id: "r1",
    sessionId: "web:eoin:t1",
    status: "done",
    request: {
      actor: { id: "U1" },
      conversation: { kind: overrides.kind ?? "dm", threadRef: "web:eoin:t1", audience: [] },
      origin: { kind: "human" },
      text: "hi",
    },
    result: {
      status: overrides.status ?? "ok",
      ...(overrides.attachments ? { attachments: [{ filename: "report.md" }] } : {}),
    },
    deliveryState: null,
    dedupKey: null,
    attempts: 1,
    errorAttempts: 0,
    maxAttempts: 3,
    leaseToken: null,
    leaseExpiresAt: null,
    workerId: null,
    createdAt: 1000,
    startedAt: 1100,
    finishedAt: 2000,
  } as unknown as Run;
}

test("classifyRun precedence: git push > artifact > shared scope > chat", () => {
  assert.equal(classifyRun(runFixture({ kind: "channel", attachments: true }), { gitPushed: true }), "code-pushed");
  assert.equal(classifyRun(runFixture({ kind: "channel", attachments: true }), { gitPushed: false }), "artifact");
  assert.equal(classifyRun(runFixture({ kind: "channel" }), { gitPushed: false }), "sent-internal");
  assert.equal(classifyRun(runFixture({ kind: "group" }), { gitPushed: false }), "sent-internal");
  assert.equal(classifyRun(runFixture({}), { gitPushed: false }), "chat");
});

test("memory outcome store: list filters and summary aggregates by principal", async () => {
  const store = createMemoryRunOutcomeStore();
  const scope = "personal:U1" as ScopeId;
  await store.record({ runId: "r1", principalId: "U1", scopeLabel: scope, outcome: "code-pushed", costUsd: 2, at: 10 });
  await store.record({ runId: "r2", principalId: "U1", scopeLabel: scope, outcome: "chat", costUsd: 1, at: 20 });
  await store.record({
    runId: "r3",
    principalId: "U2",
    scopeLabel: "personal:U2" as ScopeId,
    outcome: "artifact",
    costUsd: 4,
    at: 30,
  });

  const listed = await store.list({ principalId: "U1" });
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.runId, "r2");

  const windowed = await store.list({ since: 15 });
  assert.equal(windowed.length, 2);

  const summary = await store.summary();
  const u1 = summary.find((s) => s.principalId === "U1")!;
  assert.equal(u1.runs, 2);
  assert.equal(u1.costUsd, 3);
  assert.equal(u1.byOutcome["code-pushed"], 1);
  assert.equal(u1.byOutcome.chat, 1);
  const u2 = summary.find((s) => s.principalId === "U2")!;
  assert.equal(u2.byOutcome.artifact, 1);
});
