export interface Team {
  id: string;
  name: string;
  parentId: string | null;
}

export interface TeamStore {
  upsert(team: Team): Promise<void>;
  remove(teamId: string): Promise<void>;
  list(): Promise<Team[]>;
  setMember(teamId: string, principalId: string): Promise<void>;
  removeMember(principalId: string): Promise<void>;
  members(teamId: string): Promise<string[]>;
  teamOf(principalId: string): Promise<string | null>;
  ancestry(teamId: string): Promise<string[]>;
}

const MAX_TEAM_DEPTH = 16;

export class BrokenTeamChainError extends Error {
  teamId: string;
  missingParentId: string;
  constructor(teamId: string, missingParentId: string) {
    super(`team ${teamId} has unknown parent ${missingParentId}`);
    this.name = "BrokenTeamChainError";
    this.teamId = teamId;
    this.missingParentId = missingParentId;
  }
}

export function teamAncestry(teams: Map<string, Team>, teamId: string): string[] {
  const chain: string[] = [];
  let current: string | null = teamId;
  while (current && chain.length < MAX_TEAM_DEPTH) {
    if (chain.includes(current)) break;
    const team = teams.get(current);
    if (!team) {
      if (!chain.length) break;
      throw new BrokenTeamChainError(chain[chain.length - 1]!, current);
    }
    chain.push(current);
    current = team.parentId;
  }
  return chain;
}

export function createMemoryTeamStore(): TeamStore {
  const teams = new Map<string, Team>();
  const memberTeam = new Map<string, string>();
  return {
    upsert(team) {
      teams.set(team.id, team);
      return Promise.resolve();
    },
    remove(teamId) {
      teams.delete(teamId);
      for (const [principal, tid] of memberTeam) if (tid === teamId) memberTeam.delete(principal);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([...teams.values()]);
    },
    setMember(teamId, principalId) {
      memberTeam.set(principalId, teamId);
      return Promise.resolve();
    },
    removeMember(principalId) {
      memberTeam.delete(principalId);
      return Promise.resolve();
    },
    members(teamId) {
      const out: string[] = [];
      for (const [principal, tid] of memberTeam) if (tid === teamId) out.push(principal);
      return Promise.resolve(out);
    },
    teamOf(principalId) {
      return Promise.resolve(memberTeam.get(principalId) ?? null);
    },
    ancestry(teamId) {
      return Promise.resolve(teamAncestry(teams, teamId));
    },
  };
}
