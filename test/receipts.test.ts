import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTokenLedger } from "../src/ratelimit/token-ledger.ts";
import { createMemoryTeamStore } from "../src/directory/team-store.ts";
import { createMemoryAllocationStore } from "../src/ratelimit/allocation-store.ts";
import { createMemoryRunOutcomeStore } from "../src/runs/run-outcome.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { createAdminGrantStore, createMemoryAdminGrantPersistence } from "../src/admin/admin-grant-store.ts";
import { adminRoutes } from "../src/api/routes/admin.ts";
import { findRoute, type ApiCtx } from "../src/api/routes/route.ts";
import type { DirectoryMember, DirectoryStore } from "../src/directory/directory-store.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { personalScope, scopeId } from "../src/types.ts";

const ORG = scopeId("org", "default-org");
const ADMIN = "admin-alice";
const NOW = Date.now();
const DAY = 86_400_000;
const MINUTE = 60_000;

function directoryOf(members: DirectoryMember[]): DirectoryStore {
  return {
    list: () => Promise.resolve(members),
    get: (principalId: string) => Promise.resolve(members.find((m) => m.principalId === principalId) ?? null),
  } as unknown as DirectoryStore;
}

interface EntrySpec {
  principalId: string;
  at: number;
  costUsd: number;
  model: string;
  runId?: string;
  phase?: "turn" | "detect" | "compact" | "external";
  harness?: string;
  source?: string;
  estimated?: boolean;
  sessionId?: string;
}

function entry(spec: EntrySpec) {
  return {
    at: spec.at,
    principalId: spec.principalId,
    scopeLabel: personalScope(spec.principalId),
    ...(spec.runId ? { runId: spec.runId } : {}),
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
    ...(spec.source ? { source: spec.source } : {}),
    harness: spec.harness ?? "claude",
    model: spec.model,
    phase: spec.phase ?? ("turn" as const),
    input: 1_000,
    output: 200,
    cacheRead: 500,
    cacheWrite: 0,
    costUsd: spec.costUsd,
    estimated: spec.estimated === true,
  };
}

async function buildDeps(): Promise<ServerDeps> {
  const tokenLedger = createMemoryTokenLedger();
  const teams = createMemoryTeamStore();
  const allocations = createMemoryAllocationStore();
  const runOutcomes = createMemoryRunOutcomeStore();
  const grants = createAdminGrantStore(createMemoryAdminGrantPersistence(), {
    seed: [{ principalId: ADMIN, scopeId: ORG, role: "org_admin" }],
  });
  const admin = createAdminService(grants);

  await teams.upsert({ id: "platform", name: "Platform", parentId: null });
  await teams.upsert({ id: "infra", name: "Infra", parentId: "platform" });
  await teams.setMember("infra", "maya");
  await teams.setMember("platform", "tomas");

  await allocations.upsert({ id: "org-cap", subject: "org", limitUsd: 500, windowMs: 30 * DAY, hard: true });
  await allocations.upsert({
    id: "platform-cap",
    subject: "team:platform",
    limitUsd: 200,
    windowMs: 30 * DAY,
    hard: true,
  });
  await allocations.upsert({ id: "maya-cap", subject: "principal:maya", limitUsd: 10, windowMs: 30 * DAY, hard: true });

  tokenLedger.record(
    entry({
      principalId: "maya",
      at: NOW - 3 * DAY,
      costUsd: 2,
      model: "claude-fable-5",
      runId: "run-ship",
      sessionId: "thread-ship",
      harness: "claude",
    }),
  );
  tokenLedger.record(
    entry({
      principalId: "maya",
      at: NOW - 3 * DAY + 2 * MINUTE,
      costUsd: 0.5,
      model: "claude-sonnet-5",
      runId: "run-ship",
      sessionId: "thread-ship",
      phase: "detect",
      harness: "claude",
    }),
  );
  tokenLedger.record(
    entry({
      principalId: "maya",
      at: NOW - 3 * DAY + 5 * MINUTE,
      costUsd: 1.25,
      model: "claude-fable-5",
      runId: "run-ship",
      sessionId: "thread-ship",
      phase: "external",
      source: "claude-code",
      harness: "claude",
      estimated: true,
    }),
  );
  tokenLedger.record(
    entry({ principalId: "maya", at: NOW - 2 * DAY, costUsd: 0.75, model: "claude-fable-5", runId: "run-chat" }),
  );
  tokenLedger.record(
    entry({
      principalId: "tomas",
      at: NOW - DAY,
      costUsd: 1.5,
      model: "gpt-5.2",
      runId: "run-note",
      harness: "codex",
    }),
  );
  tokenLedger.record(entry({ principalId: "tomas", at: NOW - 6 * DAY, costUsd: 0.3, model: "gpt-5.2" }));

  await runOutcomes.record({
    runId: "run-ship",
    principalId: "maya",
    scopeLabel: personalScope("maya"),
    outcome: "code-pushed",
    costUsd: 3.75,
    at: NOW - 3 * DAY + 5 * MINUTE,
  });
  await runOutcomes.record({
    runId: "run-chat",
    principalId: "maya",
    scopeLabel: personalScope("maya"),
    outcome: "chat",
    costUsd: 0.75,
    at: NOW - 2 * DAY,
  });
  await runOutcomes.record({
    runId: "run-note",
    principalId: "tomas",
    scopeLabel: personalScope("tomas"),
    outcome: "sent-internal",
    costUsd: 1.5,
    at: NOW - DAY,
  });
  await runOutcomes.record({
    runId: "run-ghost",
    principalId: "tomas",
    scopeLabel: personalScope("tomas"),
    outcome: "artifact",
    costUsd: 9,
    at: NOW,
  });

  return {
    admin,
    teams,
    allocations,
    tokenLedger,
    runOutcomes,
    directory: directoryOf([
      { principalId: "maya", displayName: "Maya Okafor", type: "internal" },
      { principalId: "tomas", displayName: "Tomas Lind", type: "internal" },
    ]),
  } as unknown as ServerDeps;
}

async function call(
  deps: ServerDeps,
  method: string,
  path: string,
  opts: { actor?: string } = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(`http://core${path}`);
  const found = findRoute(adminRoutes, method, url.pathname);
  assert.ok(found, `no route for ${method} ${url.pathname}`);
  let status = 0;
  let payload: unknown = null;
  const ctx = {
    req: { headers: {} },
    res: {
      statusCode: 0,
      writeHead(code: number) {
        status = code;
      },
      end(raw?: string) {
        if (raw) payload = JSON.parse(raw);
      },
    },
    deps,
    body: null,
    capability: { actorId: opts.actor ?? ADMIN },
    url,
    pathname: url.pathname,
    method,
    params: found!.params,
  } as unknown as ApiCtx;
  await found!.route.handle(ctx);
  return { status, body: payload as any };
}

const receiptPath = (runId: string) =>
  `/v1/admin/receipts/${encodeURIComponent(runId)}?scope=${encodeURIComponent(ORG)}`;
const listPath = (query = "") => `/v1/admin/receipts?scope=${encodeURIComponent(ORG)}${query}`;

test("a receipt ties one run's ask to its engine, its tokens, its outcome, and the budgets it drew down", async () => {
  const deps = await buildDeps();
  const { status, body } = await call(deps, "GET", receiptPath("run-ship"));
  assert.equal(status, 200);

  assert.equal(body.runId, "run-ship");
  assert.equal(body.principalId, "maya");
  assert.equal(body.displayName, "Maya Okafor");
  assert.equal(body.sessionId, "thread-ship");
  assert.equal(body.firstAt, NOW - 3 * DAY);
  assert.equal(body.lastAt, NOW - 3 * DAY + 5 * MINUTE);
  assert.equal(body.at, NOW - 3 * DAY + 5 * MINUTE, "the receipt is dated by the outcome it closed");

  assert.equal(body.totals.calls, 3);
  assert.equal(body.totals.costUsd, 3.75, "the total is exactly the run's ledger rows");
  assert.equal(body.totals.totalTokens, 3 * 1_700);
  assert.equal(body.totals.input, 3_000);
  assert.equal(body.totals.output, 600);
  assert.equal(body.totals.estimatedCalls, 1, "one row was priced by estimate");
  assert.ok(body.totals.effectiveUsdPerMtok > 0);

  const phases = body.breakdowns.byPhase.map((r: { key: string; costUsd: number }) => [r.key, r.costUsd]);
  assert.deepEqual(
    phases,
    [
      ["turn", 2],
      ["external", 1.25],
      ["detect", 0.5],
    ],
    "phases read in the order the work happens, not by cost",
  );
  const models = Object.fromEntries(
    body.breakdowns.byModel.map((r: { key: string; costUsd: number }) => [r.key, r.costUsd]),
  );
  assert.deepEqual(models, { "claude-fable-5": 3.25, "claude-sonnet-5": 0.5 });
  const harnesses = Object.fromEntries(
    body.breakdowns.byHarness.map((r: { key: string; calls: number }) => [r.key, r.calls]),
  );
  assert.deepEqual(harnesses, { claude: 3 }, "one run, one engine");
  assert.deepEqual([...body.sources].sort(), ["claude-code", "los"]);

  assert.deepEqual(
    body.items.map((i: { phase: string; model: string; source: string; calls: number; costUsd: number }) => [
      i.phase,
      i.model,
      i.source,
      i.calls,
      i.costUsd,
    ]),
    [
      ["turn", "claude-fable-5", "los", 1, 2],
      ["external", "claude-fable-5", "claude-code", 1, 1.25],
      ["detect", "claude-sonnet-5", "los", 1, 0.5],
    ],
    "each line item is one kind of work — a phase on a model through a surface",
  );
  assert.equal(
    body.items.reduce((sum: number, i: { costUsd: number }) => sum + i.costUsd, 0),
    body.totals.costUsd,
    "the line items add up to the total, with nothing unaccounted for",
  );

  assert.deepEqual(body.outcome, {
    kind: "code-pushed",
    costUsd: 3.75,
    at: NOW - 3 * DAY + 5 * MINUTE,
  });

  assert.deepEqual(body.team, { id: "infra", name: "Infra" });
  assert.deepEqual(
    body.teamAncestry.map((t: { id: string }) => t.id),
    ["infra", "platform"],
  );

  const stack = Object.fromEntries(body.allocations.map((a: { subject: string }) => [a.subject, a]));
  assert.deepEqual(
    Object.keys(stack).sort(),
    ["org", "principal:maya", "team:platform"],
    "own budget, the team chain it rolls up through, and the org cap",
  );
  assert.equal(stack["principal:maya"].kind, "principal");
  assert.equal(stack["principal:maya"].limitUsd, 10);
  assert.equal(stack["principal:maya"].spentUsd, 4.5, "maya's own spend across the 30d window");
  assert.equal(stack["principal:maya"].remainingUsd, 5.5);
  assert.equal(stack["team:platform"].kind, "team");
  assert.equal(stack["team:platform"].spentUsd, 6.3, "the team cap sees maya plus tomas");
  assert.equal(stack["team:platform"].remainingUsd, 193.7);
  assert.equal(stack.org.kind, "org");
  assert.equal(stack.org.spentUsd, 6.3);
  assert.equal(stack.org.remainingUsd, 493.7);
  assert.equal(stack.org.exceeded, false);
});

test("a receipt agrees with the person drill-down it was opened from", async () => {
  const deps = await buildDeps();
  const person = await call(deps, "GET", `/v1/admin/utb/people/maya?scope=${encodeURIComponent(ORG)}`);
  const { body } = await call(deps, "GET", receiptPath("run-ship"));
  assert.equal(person.status, 200);
  assert.deepEqual(
    body.allocations,
    person.body.allocations,
    "both views read the budget stack through the same helper",
  );
});

test("a run with no metered work is a clean 404, and receipts are admin-gated", async () => {
  const deps = await buildDeps();
  const missing = await call(deps, "GET", receiptPath("run-ghost"));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "not_found");
  assert.equal(missing.body.runId, "run-ghost");
  assert.match(missing.body.message, /run-ghost/);

  assert.equal((await call(deps, "GET", receiptPath("run-ship"), { actor: "nobody" })).status, 403);
  assert.equal((await call(deps, "GET", "/v1/admin/receipts/run-ship")).status, 400);
  assert.equal((await call(deps, "GET", listPath(), { actor: "nobody" })).status, 403);
});

test("the receipt list shows only runs that both spent and produced, newest first", async () => {
  const deps = await buildDeps();
  const { status, body } = await call(deps, "GET", listPath());
  assert.equal(status, 200);

  assert.deepEqual(
    body.receipts.map((r: { runId: string }) => r.runId),
    ["run-note", "run-chat", "run-ship"],
    "newest first, and run-ghost is absent because nothing was metered against it",
  );
  assert.equal(body.total, 3);

  const ship = body.receipts.find((r: { runId: string }) => r.runId === "run-ship");
  assert.equal(ship.displayName, "Maya Okafor");
  assert.equal(ship.outcome, "code-pushed");
  assert.equal(ship.costUsd, 3.75);
  assert.equal(ship.outcomeCostUsd, 3.75);
  assert.equal(ship.calls, 3);
  assert.equal(ship.model, "claude-fable-5", "the model that carried most of the cost names the run");
  assert.equal(ship.harness, "claude");
  assert.equal(ship.estimated, true);
  assert.equal(ship.at, NOW - 3 * DAY + 5 * MINUTE);

  const note = body.receipts.find((r: { runId: string }) => r.runId === "run-note");
  assert.equal(note.harness, "codex");
  assert.equal(note.estimated, false);
});

test("the receipt list narrows to one person and honours limit", async () => {
  const deps = await buildDeps();
  const mine = await call(deps, "GET", listPath("&principalId=maya"));
  assert.deepEqual(
    mine.body.receipts.map((r: { runId: string }) => r.runId),
    ["run-chat", "run-ship"],
  );
  const capped = await call(deps, "GET", listPath("&limit=1"));
  assert.equal(capped.body.receipts.length, 1);
  assert.equal(capped.body.receipts[0].runId, "run-note");
  assert.equal(capped.body.total, 3, "the total still counts every receipt behind the cap");
});
