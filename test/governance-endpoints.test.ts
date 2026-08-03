import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTokenLedger } from "../src/ratelimit/token-ledger.ts";
import { createMemoryTeamStore } from "../src/directory/team-store.ts";
import { createMemoryAllocationStore } from "../src/ratelimit/allocation-store.ts";
import { createMemoryRunOutcomeStore } from "../src/runs/run-outcome.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { createAdminGrantStore, createMemoryAdminGrantPersistence } from "../src/admin/admin-grant-store.ts";
import { adminRoutes } from "../src/api/routes/admin.ts";
import { membersVersion } from "../src/api/routes/admin/observability.ts";
import { findRoute, type ApiCtx } from "../src/api/routes/route.ts";
import type { DirectoryMember, DirectoryStore } from "../src/directory/directory-store.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { personalScope, scopeId } from "../src/types.ts";

const ORG = scopeId("org", "default-org");
const ADMIN = "admin-alice";
const NOW = Date.now();
const DAY = 86_400_000;

function directoryOf(members: DirectoryMember[]): DirectoryStore {
  return {
    list: () => Promise.resolve(members),
    get: (principalId: string) => Promise.resolve(members.find((m) => m.principalId === principalId) ?? null),
  } as unknown as DirectoryStore;
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
  await teams.setMember("infra", "ghost");

  await allocations.upsert({ id: "org-cap", subject: "org", limitUsd: 500, windowMs: 30 * DAY, hard: true });
  await allocations.upsert({
    id: "platform-cap",
    subject: "team:platform",
    limitUsd: 200,
    windowMs: 30 * DAY,
    hard: true,
  });
  await allocations.upsert({
    id: "maya-cap",
    subject: "principal:maya",
    limitUsd: 10,
    windowMs: 30 * DAY,
    hard: false,
  });
  await allocations.upsert({ id: "growth-cap", subject: "team:growth", limitUsd: 50, windowMs: DAY, hard: false });

  const entry = (
    principalId: string,
    at: number,
    costUsd: number,
    model: string,
    extra: { source?: string; harness?: string } = {},
  ) => ({
    at,
    principalId,
    scopeLabel: personalScope(principalId),
    model,
    phase: extra.source ? ("external" as const) : ("turn" as const),
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.harness ? { harness: extra.harness } : {}),
    input: 1_000,
    output: 200,
    cacheRead: 500,
    cacheWrite: 0,
    costUsd,
    estimated: !!extra.source,
  });
  tokenLedger.record(entry("maya", NOW - 5 * DAY, 3, "claude-fable-5", { harness: "pi" }));
  tokenLedger.record(
    entry("maya", NOW - 2 * DAY, 1.5, "claude-sonnet-5", { source: "claude-code", harness: "claude" }),
  );
  tokenLedger.record(entry("maya", NOW - DAY, 0.5, "claude-fable-5", { harness: "pi" }));
  tokenLedger.record(entry("tomas", NOW - 3 * DAY, 2, "gpt-5.2", { harness: "codex" }));
  tokenLedger.record(entry("drifter", NOW - DAY, 0.25, "claude-sonnet-5"));

  await runOutcomes.record({
    runId: "r1",
    principalId: "maya",
    scopeLabel: personalScope("maya"),
    outcome: "code-pushed",
    costUsd: 2,
    at: NOW - 4 * DAY,
  });
  await runOutcomes.record({
    runId: "r2",
    principalId: "maya",
    scopeLabel: personalScope("maya"),
    outcome: "chat",
    costUsd: 0.2,
    at: NOW - 3 * DAY,
  });
  await runOutcomes.record({
    runId: "r3",
    principalId: "tomas",
    scopeLabel: personalScope("tomas"),
    outcome: "artifact",
    costUsd: 1,
    at: NOW - 3 * DAY,
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
      { principalId: "quiet", displayName: "Quiet Newcomer", type: "internal" },
    ]),
  } as unknown as ServerDeps;
}

async function call(
  deps: ServerDeps,
  method: string,
  path: string,
  opts: { actor?: string; body?: unknown; ifMatch?: string } = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(`http://core${path}`);
  const found = findRoute(adminRoutes, method, url.pathname);
  assert.ok(found, `no route for ${method} ${url.pathname}`);
  let status = 0;
  let payload: unknown = null;
  const ctx = {
    req: { headers: opts.ifMatch ? { "if-match": opts.ifMatch } : {} },
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
    body: opts.body ?? null,
    capability: { actorId: opts.actor ?? ADMIN },
    url,
    pathname: url.pathname,
    method,
    params: found!.params,
  } as unknown as ApiCtx;
  await found!.route.handle(ctx);
  return { status, body: payload as any };
}

const peoplePath = `/v1/admin/utb/people?scope=${encodeURIComponent(ORG)}&since=${NOW - 30 * DAY}`;
const personPath = (id: string) =>
  `/v1/admin/utb/people/${encodeURIComponent(id)}?scope=${encodeURIComponent(ORG)}&since=${NOW - 30 * DAY}`;

test("the people roster merges directory, ledger, and team membership and ranks by spend", async () => {
  const deps = await buildDeps();
  const { status, body } = await call(deps, "GET", peoplePath);
  assert.equal(status, 200);

  const ids = body.people.map((p: { principalId: string }) => p.principalId);
  assert.deepEqual(
    [...ids].sort(),
    ["drifter", "ghost", "maya", "quiet", "tomas"],
    "roster spans directory-only, ledger-only, and team-only people",
  );
  assert.deepEqual(ids.slice(0, 3), ["maya", "tomas", "drifter"], "sorted by spend desc");

  const maya = body.people.find((p: { principalId: string }) => p.principalId === "maya");
  assert.equal(maya.displayName, "Maya Okafor", "directory names the person");
  assert.equal(maya.teamId, "infra");
  assert.equal(maya.teamName, "Infra");
  assert.equal(maya.calls, 3);
  assert.equal(maya.costUsd, 5);
  assert.equal(maya.totalTokens, 3 * (1_000 + 200 + 500));
  assert.equal(maya.lastActiveAt, NOW - DAY, "last activity is the newest ledger row");
  assert.equal(maya.hasOwnAllocation, true, "a principal allocation is flagged on the roster");
  assert.equal(maya.isAdmin, false);

  const quiet = body.people.find((p: { principalId: string }) => p.principalId === "quiet");
  assert.equal(quiet.displayName, "Quiet Newcomer");
  assert.equal(quiet.costUsd, 0);
  assert.equal(quiet.calls, 0);
  assert.equal(quiet.lastActiveAt, null);
  assert.equal(quiet.teamId, null);
  assert.equal(quiet.hasOwnAllocation, false);

  const drifter = body.people.find((p: { principalId: string }) => p.principalId === "drifter");
  assert.equal(drifter.displayName, "drifter", "a person absent from the directory falls back to the id");

  assert.equal(body.totalCostUsd, 7.25);
  assert.equal(body.total, 5);

  const grantee = body.people.find((p: { principalId: string }) => p.principalId === ADMIN);
  assert.equal(grantee, undefined, "an admin with no spend, team, or directory row is not invented");
});

test("the people roster is admin-gated and requires a scope", async () => {
  const deps = await buildDeps();
  assert.equal((await call(deps, "GET", peoplePath, { actor: "nobody" })).status, 403);
  assert.equal((await call(deps, "GET", "/v1/admin/utb/people")).status, 400);
  assert.equal((await call(deps, "GET", personPath("maya"), { actor: "nobody" })).status, 403);
});

test("the person drill-down traces spend, outcomes, team chain, and every governing allocation", async () => {
  const deps = await buildDeps();
  const { status, body } = await call(deps, "GET", personPath("maya"));
  assert.equal(status, 200);

  assert.equal(body.principalId, "maya");
  assert.equal(body.displayName, "Maya Okafor");
  assert.equal(body.totals.calls, 3);
  assert.equal(body.totals.costUsd, 5);
  assert.equal(body.totals.totalTokens, 5_100);
  assert.ok(body.totals.effectiveUsdPerMtok > 0);
  assert.equal(body.lastActiveAt, NOW - DAY);

  const models = body.breakdowns.byModel.map((r: { key: string; costUsd: number }) => [r.key, r.costUsd]);
  assert.deepEqual(models, [
    ["claude-fable-5", 3.5],
    ["claude-sonnet-5", 1.5],
  ]);
  const phases = Object.fromEntries(
    body.breakdowns.byPhase.map((r: { key: string; calls: number }) => [r.key, r.calls]),
  );
  assert.deepEqual(phases, { turn: 2, external: 1 });
  const sources = Object.fromEntries(
    body.breakdowns.bySource.map((r: { key: string; costUsd: number }) => [r.key, r.costUsd]),
  );
  assert.deepEqual(sources, { los: 3.5, "claude-code": 1.5 });
  const harnesses = Object.fromEntries(
    body.breakdowns.byHarness.map((r: { key: string; costUsd: number }) => [r.key, r.costUsd]),
  );
  assert.deepEqual(harnesses, { pi: 3.5, claude: 1.5 }, "spend splits by the harness that spent it");
  assert.equal(
    body.breakdowns.byHarness.reduce((sum: number, r: { calls: number }) => sum + r.calls, 0),
    body.totals.calls,
  );

  assert.equal(body.outcomes.runs, 2);
  assert.deepEqual(body.outcomes.byOutcome, { "code-pushed": 1, artifact: 0, "sent-internal": 0, chat: 1 });
  assert.equal(body.outcomes.produced, 1);
  assert.equal(body.outcomes.costUsd, 2.2);
  assert.equal(body.outcomes.costPerOutcomeUsd, 2.2, "cost per outcome divides the outcome cost it sits next to");
  assert.equal(body.outcomes.ledgerCostUsd, 5);
  assert.equal(body.outcomes.ledgerCostPerOutcomeUsd, 5, "the ledger basis is shipped as its own named field");

  assert.deepEqual(body.team, { id: "infra", name: "Infra" });
  assert.deepEqual(body.teamAncestry, [
    { id: "infra", name: "Infra" },
    { id: "platform", name: "Platform" },
  ]);

  const allocations = Object.fromEntries(body.allocations.map((a: { id: string }) => [a.id, a])) as Record<string, any>;
  assert.deepEqual(
    Object.keys(allocations).sort(),
    ["maya-cap", "org-cap", "platform-cap"],
    "org, team chain, and own allocation govern this person; other teams' do not",
  );
  assert.equal(allocations["maya-cap"].kind, "principal");
  assert.equal(allocations["maya-cap"].limitUsd, 10);
  assert.equal(allocations["maya-cap"].hard, false);
  assert.equal(allocations["maya-cap"].spentUsd, 5, "own allocation spend is this person's ledger cost");
  assert.equal(allocations["maya-cap"].remainingUsd, 5);
  assert.equal(allocations["maya-cap"].utilization, 0.5);
  assert.equal(allocations["maya-cap"].exceeded, false);
  assert.equal(allocations["platform-cap"].kind, "team");
  assert.equal(allocations["platform-cap"].spentUsd, 7, "team spend rolls up descendants (maya + tomas)");
  assert.equal(allocations["org-cap"].kind, "org");
  assert.equal(allocations["org-cap"].spentUsd, 7.25, "org spend is every principal");
  assert.equal(allocations["org-cap"].hard, true);
});

test("the drill-down finds people who exist only in a team or only in the ledger, and 404s unknown ids", async () => {
  const deps = await buildDeps();

  const ghost = await call(deps, "GET", personPath("ghost"));
  assert.equal(ghost.status, 200, "a team member with no spend is still governable");
  assert.equal(ghost.body.totals.costUsd, 0);
  assert.equal(ghost.body.team.id, "infra");
  assert.deepEqual(
    ghost.body.allocations.map((a: { id: string }) => a.id).sort(),
    ["org-cap", "platform-cap"],
    "org + team chain still governs a zero-spend member",
  );

  const drifter = await call(deps, "GET", personPath("drifter"));
  assert.equal(drifter.status, 200, "a ledger-only principal is traceable");
  assert.equal(drifter.body.team, null);
  assert.deepEqual(
    drifter.body.allocations.map((a: { id: string }) => a.id),
    ["org-cap"],
    "an unassigned person is governed by the org allocation alone",
  );

  const unknown = await call(deps, "GET", personPath("who-dis"));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "not_found");
});

test("PUT teams replaces the listed membership and rejects unsound parents", async () => {
  const deps = await buildDeps();
  const teams = deps.teams!;
  const scoped = `/v1/admin/utb/teams?scope=${encodeURIComponent(ORG)}`;

  const created = await call(deps, "PUT", scoped, { body: { id: "infra", name: "Infra Again" } });
  assert.equal(created.status, 409, "creating a team whose id is taken is a conflict, not a silent overwrite");
  assert.equal(created.body.error, "team_exists");
  assert.equal((await teams.list()).find((t) => t.id === "infra")!.name, "Infra", "the existing team is untouched");

  const replaced = await call(deps, "PUT", scoped, {
    ifMatch: membersVersion(await teams.members("infra")),
    body: { id: "infra", name: "Infra", parentId: "platform", members: ["maya", "newbie"] },
  });
  assert.equal(replaced.status, 200);
  assert.deepEqual((await teams.members("infra")).sort(), ["maya", "newbie"], "listed members replace the roster");
  assert.equal(await teams.teamOf("ghost"), null, "a member left off the list is removed, not kept");
  assert.equal(await teams.teamOf("newbie"), "infra");

  assert.equal(
    (await call(deps, "PUT", scoped, { body: { id: "infra", name: "Infra", parentId: "nope" } })).status,
    400,
    "an unknown parent is rejected",
  );
  assert.equal(
    (await call(deps, "PUT", scoped, { body: { id: "platform", name: "Platform", parentId: "infra" } })).status,
    400,
    "a parent cycle is rejected",
  );
  assert.equal(
    (await call(deps, "PUT", scoped, { body: { id: "infra", name: "Infra", parentId: "infra" } })).status,
    400,
  );
  assert.equal((await call(deps, "PUT", scoped, { body: { id: "infra" } })).status, 400, "name is required");
  assert.equal(
    (await call(deps, "PUT", scoped, { body: { id: "infra", name: "Infra", members: ["", 7] } })).status,
    400,
    "malformed members are rejected before anything is written",
  );
  assert.deepEqual((await teams.members("infra")).sort(), ["maya", "newbie"], "rejected writes change nothing");
});

test("a person is removed from their team, and deleting a team clears its memberships", async () => {
  const deps = await buildDeps();
  const teams = deps.teams!;
  const scoped = (path: string) => `${path}?scope=${encodeURIComponent(ORG)}`;

  const wrongTeam = await call(deps, "DELETE", scoped("/v1/admin/utb/teams/platform/members/maya"));
  assert.equal(wrongTeam.status, 404, "removing from a team the person is not in is a miss");
  assert.equal(await teams.teamOf("maya"), "infra");

  const removed = await call(deps, "DELETE", scoped("/v1/admin/utb/teams/infra/members/maya"));
  assert.equal(removed.status, 200);
  assert.equal(await teams.teamOf("maya"), null, "the person is unassigned, not deleted");
  assert.equal((await call(deps, "GET", personPath("maya"))).status, 200, "and still traceable in governance");

  assert.equal((await call(deps, "DELETE", scoped("/v1/admin/utb/teams/infra"))).status, 200);
  assert.equal(await teams.teamOf("ghost"), null, "deleting a team clears its memberships");
  assert.deepEqual(await teams.members("infra"), []);
  assert.equal(
    (await call(deps, "DELETE", scoped("/v1/admin/utb/teams/infra/members/ghost"), { actor: "nobody" })).status,
    403,
    "member removal is admin-gated",
  );
});

test("allocation writes validate subject and limit before they can govern anyone", async () => {
  const deps = await buildDeps();
  const scoped = `/v1/admin/utb/allocations?scope=${encodeURIComponent(ORG)}`;
  assert.equal((await call(deps, "PUT", scoped, { body: { id: "x", subject: "nope", limitUsd: 5 } })).status, 400);
  assert.equal(
    (await call(deps, "PUT", scoped, { body: { id: "x", subject: "principal:maya", limitUsd: 0 } })).status,
    400,
  );
  assert.equal((await call(deps, "PUT", scoped, { body: { subject: "org", limitUsd: 5 } })).status, 400);
  assert.equal(
    (
      await call(deps, "PUT", scoped, {
        body: { id: "maya-daily", subject: "principal:maya", limitUsd: 4, windowMs: DAY },
      })
    ).status,
    200,
  );
  const dupe = await call(deps, "PUT", scoped, {
    body: { id: "maya-second", subject: "principal:maya", limitUsd: 99, windowMs: 30 * DAY },
  });
  assert.equal(dupe.status, 409, "a subject cannot be capped twice for the same window under a second id");
  assert.equal(dupe.body.error, "subject_already_capped");
  assert.equal(dupe.body.existingId, "maya-cap");
  const drill = await call(deps, "GET", personPath("maya"));
  const ids = drill.body.allocations.map((a: { id: string }) => a.id).sort();
  assert.deepEqual(ids, ["maya-cap", "maya-daily", "org-cap", "platform-cap"], "a new cap governs the person at once");
  assert.equal(
    (await call(deps, "DELETE", `/v1/admin/utb/allocations/maya-daily?scope=${encodeURIComponent(ORG)}`)).status,
    200,
  );
  const after = await call(deps, "GET", personPath("maya"));
  assert.equal(
    after.body.allocations.some((a: { id: string }) => a.id === "maya-daily"),
    false,
  );
});
