import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresTeamStore } from "../src/directory/postgres-team-store.ts";
import { createPostgresAllocationStore } from "../src/ratelimit/postgres-allocation-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres UTB store tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS utb_teams, utb_team_members, utb_allocations CASCADE");
  await p.end();
});

test("pg teams: hierarchy, membership, and ancestry persist across instances", { skip }, async () => {
  const a = createPostgresTeamStore(URL!);
  const b = createPostgresTeamStore(URL!);
  await a.upsert({ id: "eng", name: "Engineering", parentId: null });
  await a.upsert({ id: "eng-platform", name: "Platform", parentId: "eng" });
  await a.setMember("eng-platform", "U1");
  await a.setMember("eng-platform", "U2");
  await a.setMember("eng", "U3");

  assert.equal((await b.list()).length, 2);
  assert.deepEqual((await b.members("eng-platform")).sort(), ["U1", "U2"]);
  assert.equal(await b.teamOf("U1"), "eng-platform");
  assert.deepEqual(await b.ancestry("eng-platform"), ["eng-platform", "eng"]);

  await b.setMember("eng", "U1");
  assert.equal(await a.teamOf("U1"), "eng", "a member belongs to one team; reassignment moves them");

  await a.remove("eng-platform");
  assert.equal((await b.list()).length, 1);
  assert.equal(await b.teamOf("U2"), null, "removing a team clears its memberships");
});

test("pg allocations: upsert, subject query, and delete", { skip }, async () => {
  const store = createPostgresAllocationStore(URL!);
  await store.upsert({ id: "a1", subject: "org", limitUsd: 100, windowMs: 86_400_000, hard: true });
  await store.upsert({ id: "a2", subject: "team:eng", limitUsd: 50, windowMs: 86_400_000, hard: false });
  await store.upsert({ id: "a2", subject: "team:eng", limitUsd: 60, windowMs: 86_400_000, hard: true });

  const all = await store.list();
  assert.equal(all.length, 2);
  assert.equal(all.find((a) => a.id === "a2")!.limitUsd, 60);

  const matched = await store.forSubjects(["org", "principal:U1"]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.id, "a1");

  await store.remove("a1");
  assert.equal((await store.list()).length, 1);
});
