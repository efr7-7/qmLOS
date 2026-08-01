import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresRunOutcomeStore } from "../src/runs/postgres-run-outcome-store.ts";
import type { ScopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres run-outcome tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS run_outcomes CASCADE");
  await p.end();
});

test("pg run outcomes: upsert by run, list, and summary persist across instances", { skip }, async () => {
  const a = createPostgresRunOutcomeStore(URL!);
  const b = createPostgresRunOutcomeStore(URL!);
  const scope = "personal:U1" as ScopeId;

  await a.record({ runId: "r1", principalId: "U1", scopeLabel: scope, outcome: "chat", costUsd: 1, at: 10 });
  await a.record({ runId: "r1", principalId: "U1", scopeLabel: scope, outcome: "code-pushed", costUsd: 2, at: 10 });
  await b.record({ runId: "r2", principalId: "U1", scopeLabel: scope, outcome: "artifact", costUsd: 3, at: 20 });

  const listed = await b.list({ principalId: "U1" });
  assert.equal(listed.length, 2, "same runId upserts rather than duplicating");
  assert.equal(listed[1]!.outcome, "code-pushed");
  assert.equal(listed[1]!.costUsd, 2);

  const summary = await a.summary();
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.runs, 2);
  assert.equal(summary[0]!.costUsd, 5);
  assert.equal(summary[0]!.byOutcome["code-pushed"], 1);
  assert.equal(summary[0]!.byOutcome.artifact, 1);

  const windowed = await a.summary({ since: 15 });
  assert.equal(windowed[0]!.runs, 1);
});
