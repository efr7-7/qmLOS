import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryTokenLedger } from "../src/ratelimit/token-ledger.ts";
import { createMemoryTeamStore } from "../src/directory/team-store.ts";
import { createMemoryAllocationStore } from "../src/ratelimit/allocation-store.ts";
import { createAdminService } from "../src/admin/admin-service.ts";
import { createAdminGrantStore, createMemoryAdminGrantPersistence } from "../src/admin/admin-grant-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createRosterOverrideStore } from "../src/directory/roster-overrides.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { adminRoutes } from "../src/api/routes/admin.ts";
import { findRoute, type ApiCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { personalScope, scopeId } from "../src/types.ts";

const ORG = scopeId("org", "default-org");
const ADMIN = "admin-alice";
const NOW = Date.now();
const DAY = 86_400_000;

async function buildDeps(): Promise<ServerDeps> {
  const tokenLedger = createMemoryTokenLedger();
  const teams = createMemoryTeamStore();
  const allocations = createMemoryAllocationStore();
  const grants = createAdminGrantStore(createMemoryAdminGrantPersistence(), {
    seed: [
      { principalId: ADMIN, scopeId: ORG, role: "org_admin" },
      { principalId: "maya", scopeId: ORG, role: "org_admin" },
    ],
  });
  const admin = createAdminService(grants);
  const directory = createDirectoryStore();
  const rosterOverrides = createRosterOverrideStore();
  const identity = createIdentityService();

  await directory.replace([
    { principalId: "maya", displayName: "Maya Okafor", type: "internal" },
    { principalId: "tomas", displayName: "Tomas Lind", type: "internal" },
  ]);
  await teams.upsert({ id: "platform", name: "Platform", parentId: null });
  await teams.setMember("platform", "maya");
  await teams.setMember("platform", "tomas");
  await allocations.upsert({ id: "org-cap", subject: "org", limitUsd: 500, windowMs: 30 * DAY, hard: true });
  await allocations.upsert({
    id: "platform-cap",
    subject: "team:platform",
    limitUsd: 200,
    windowMs: 30 * DAY,
    hard: true,
  });
  await allocations.upsert({ id: "maya-cap", subject: "principal:maya", limitUsd: 10, windowMs: DAY, hard: true });

  for (const [principalId, costUsd] of [
    ["maya", 12],
    ["tomas", 4],
  ] as const) {
    tokenLedger.record({
      at: NOW - 2 * DAY,
      principalId,
      scopeLabel: personalScope(principalId),
      model: "claude-fable-5",
      phase: "turn",
      harness: "pi",
      input: 1_000,
      output: 200,
      cacheRead: 500,
      cacheWrite: 0,
      costUsd,
      estimated: false,
    });
  }

  return { admin, teams, allocations, tokenLedger, directory, rosterOverrides, identity } as unknown as ServerDeps;
}

async function call(
  deps: ServerDeps,
  method: string,
  path: string,
  opts: { actor?: string; body?: unknown } = {},
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
const createPath = `/v1/admin/utb/people?scope=${encodeURIComponent(ORG)}`;
const deletePath = (id: string) => `/v1/admin/utb/people/${encodeURIComponent(id)}?scope=${encodeURIComponent(ORG)}`;

test("an upsert that omits displayName keeps the stored name", async () => {
  const deps = await buildDeps();
  const created = await call(deps, "POST", createPath, {
    body: { principalId: "qa-elena", displayName: "Elena Ortiz", teamId: "platform" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.person.displayName, "Elena Ortiz");

  const upserted = await call(deps, "POST", createPath, {
    body: { principalId: "qa-elena", upsert: true, budget: { limitUsd: 25, windowMs: DAY } },
  });
  assert.equal(upserted.status, 200);
  assert.equal(upserted.body.person.displayName, "Elena Ortiz", "an omitted displayName must not become the id");
  assert.equal(upserted.body.person.teamId, "platform", "the stored team survives too");

  const fetched = await call(deps, "GET", personPath("qa-elena"));
  assert.equal(fetched.body.displayName, "Elena Ortiz");
});

test("removing a person who has spend tombstones them instead of resurrecting an active-looking row", async () => {
  const deps = await buildDeps();
  const before = await call(deps, "GET", peoplePath);
  assert.equal(before.body.total, 2, "maya and tomas are on the roster");

  const removed = await call(deps, "DELETE", deletePath("tomas"));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed.directory, true);
  assert.equal(removed.body.removed.teamId, "platform");
  assert.equal(removed.body.removed.access, true);
  assert.ok(
    removed.body.consequences.some((line: string) => line.includes("Former") || line.includes("former")),
    "the response states where the spend goes",
  );

  const after = await call(deps, "GET", peoplePath);
  const tomas = after.body.people.find((p: { principalId: string }) => p.principalId === "tomas");
  assert.ok(tomas, "his spend is still enumerated");
  assert.equal(tomas.status, "former", "but never as an active member");
  assert.equal(tomas.costUsd, 4, "spend is retained");
  assert.ok(tomas.removedAt > 0, "the tombstone carries a timestamp");
  assert.equal(after.body.total, 1, "the roster count excludes former members");
  assert.equal(after.body.formerTotal, 1);

  const detail = await call(deps, "GET", personPath("tomas"));
  assert.equal(detail.body.status, "former");

  assert.equal(
    deps.identity!.classify("tomas").type,
    "guest",
    "removal deactivates the principal so no session capability is issued",
  );
});

test("removing an admin revokes the grant, deletes their budget, and says so", async () => {
  const deps = await buildDeps();
  const removed = await call(deps, "DELETE", deletePath("maya"));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed.adminGrant, true);
  assert.deepEqual(removed.body.removed.allocations, ["maya-cap"]);
  assert.ok(
    removed.body.consequences.some((line: string) => line.includes("org_admin")),
    "the consequence list names the grant revocation",
  );
  assert.ok(
    removed.body.consequences.some((line: string) => line.includes("budget")),
    "and the budget deletion",
  );
  assert.equal((await deps.admin!.adminStatusOf({ id: "maya", type: "internal" })).isAdmin, false);
  assert.equal(
    (await deps.allocations!.list()).some((a) => a.subject === "principal:maya"),
    false,
  );
});

test("a Slack directory push cannot resurrect a removed person or erase a portal-created one", async () => {
  const deps = await buildDeps();
  assert.equal((await call(deps, "POST", createPath, { body: { principalId: "newhire", displayName: "New Hire" } })).status, 201);
  assert.equal((await call(deps, "DELETE", deletePath("tomas"))).status, 200);

  const slackSnapshot = [
    { principalId: "maya", displayName: "Maya Okafor", type: "internal" as const },
    { principalId: "tomas", displayName: "Tomas Lind", type: "internal" as const },
  ];
  const merged = await deps.rosterOverrides!.merge(slackSnapshot);
  await deps.directory!.replace(merged);

  const ids = (await deps.directory!.list()).map((m) => m.principalId).sort();
  assert.deepEqual(ids, ["maya", "newhire"], "the tombstone survives the sync and the portal add is not dropped");
  assert.equal(
    (await deps.directory!.get("newhire"))?.displayName,
    "New Hire",
    "the portal-set display name survives the sync",
  );

  const roster = await call(deps, "GET", peoplePath);
  const tomas = roster.body.people.find((p: { principalId: string }) => p.principalId === "tomas");
  assert.equal(tomas.status, "former", "he stays offboarded across a sync");
});

test("revokeDepartedGrants clears a departed admin but never the last one", async () => {
  const deps = await buildDeps();
  const admin = deps.admin!;
  assert.deepEqual(
    (await admin.revokeDepartedGrants("maya")).map((g) => g.principalId),
    ["maya"],
  );
  assert.equal((await admin.adminStatusOf({ id: "maya", type: "internal" })).isAdmin, false);
  assert.deepEqual(await admin.revokeDepartedGrants(ADMIN), [], "the last org admin is kept");
  assert.equal((await admin.adminStatusOf({ id: ADMIN, type: "internal" })).isAdmin, true);
});
