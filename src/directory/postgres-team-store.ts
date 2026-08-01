import { createPgPool } from "../persistence/pg-pool.ts";
import { teamAncestry, type Team, type TeamStore } from "./team-store.ts";

export function createPostgresTeamStore(connectionString: string): TeamStore {
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS utb_teams(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT
      )`,
    `CREATE TABLE IF NOT EXISTS utb_team_members(
        principal_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS utb_team_members_by_team ON utb_team_members(team_id)`,
  ]);

  async function allTeams(): Promise<Map<string, Team>> {
    const rows = await q("SELECT id, name, parent_id FROM utb_teams", []);
    return new Map(
      rows.map((row) => [
        String(row.id),
        { id: String(row.id), name: String(row.name), parentId: row.parent_id ? String(row.parent_id) : null },
      ]),
    );
  }

  return {
    async upsert(team) {
      await q(
        `INSERT INTO utb_teams(id, name, parent_id) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = $2, parent_id = $3`,
        [team.id, team.name, team.parentId],
      );
    },
    async remove(teamId) {
      await q("DELETE FROM utb_team_members WHERE team_id = $1", [teamId]);
      await q("DELETE FROM utb_teams WHERE id = $1", [teamId]);
    },
    async list() {
      return [...(await allTeams()).values()];
    },
    async setMember(teamId, principalId) {
      await q(
        `INSERT INTO utb_team_members(principal_id, team_id) VALUES ($1, $2)
         ON CONFLICT (principal_id) DO UPDATE SET team_id = $2`,
        [principalId, teamId],
      );
    },
    async removeMember(principalId) {
      await q("DELETE FROM utb_team_members WHERE principal_id = $1", [principalId]);
    },
    async members(teamId) {
      const rows = await q("SELECT principal_id FROM utb_team_members WHERE team_id = $1", [teamId]);
      return rows.map((row) => String(row.principal_id));
    },
    async teamOf(principalId) {
      const rows = await q("SELECT team_id FROM utb_team_members WHERE principal_id = $1", [principalId]);
      return rows.length ? String(rows[0]!.team_id) : null;
    },
    async ancestry(teamId) {
      return teamAncestry(await allTeams(), teamId);
    },
  };
}
