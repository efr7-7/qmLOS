import type { BudgetTracker } from "./budget.ts";
import type { TokenLedger } from "./token-ledger.ts";
import type { TeamStore } from "../directory/team-store.ts";
import type { Allocation, AllocationStore, AllocationSubject } from "./allocation-store.ts";

interface AllocationBudgetDeps {
  teams: TeamStore;
  allocations: AllocationStore;
  ledger: TokenLedger;
  warn?: (message: string) => void;
}

async function descendantTeamIds(teams: TeamStore, rootId: string): Promise<string[]> {
  const all = await teams.list();
  const childrenOf = new Map<string, string[]>();
  for (const team of all) {
    if (!team.parentId) continue;
    const siblings = childrenOf.get(team.parentId) ?? [];
    siblings.push(team.id);
    childrenOf.set(team.parentId, siblings);
  }
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    if (out.includes(current)) continue;
    out.push(current);
    queue.push(...(childrenOf.get(current) ?? []));
  }
  return out;
}

async function teamSpendUsd(deps: AllocationBudgetDeps, teamId: string, since: number): Promise<number> {
  const memberSets = await Promise.all((await descendantTeamIds(deps.teams, teamId)).map((id) => deps.teams.members(id)));
  const members = new Set(memberSets.flat());
  if (!members.size) return 0;
  const rows = await deps.ledger.summary("principal", { since });
  return rows.filter((row) => members.has(row.key)).reduce((sum, row) => sum + row.costUsd, 0);
}

async function allocationSpendUsd(deps: AllocationBudgetDeps, allocation: Allocation, now: number): Promise<number> {
  const since = now - allocation.windowMs;
  if (allocation.subject === "org") {
    const rows = await deps.ledger.summary("phase", { since });
    return rows.reduce((sum, row) => sum + row.costUsd, 0);
  }
  if (allocation.subject.startsWith("team:")) {
    return teamSpendUsd(deps, allocation.subject.slice("team:".length), since);
  }
  const principalId = allocation.subject.slice("principal:".length);
  const rows = await deps.ledger.summary("phase", { since, principalId });
  return rows.reduce((sum, row) => sum + row.costUsd, 0);
}

export function createAllocationBudgetTracker(inner: BudgetTracker, deps: AllocationBudgetDeps): BudgetTracker {
  return {
    async check(principalId, now = Date.now()) {
      const base = await inner.check(principalId, now);
      if (!base.allowed) return base;
      const subjects: AllocationSubject[] = ["org", `principal:${principalId}`];
      const teamId = await deps.teams.teamOf(principalId);
      if (teamId) for (const ancestor of await deps.teams.ancestry(teamId)) subjects.push(`team:${ancestor}`);
      const allocations = await deps.allocations.forSubjects(subjects);
      for (const allocation of allocations) {
        const spentUsd = await allocationSpendUsd(deps, allocation, now);
        if (spentUsd < allocation.limitUsd) continue;
        if (allocation.hard) return { allowed: false, spentUsd, limitUsd: allocation.limitUsd };
        (deps.warn ?? console.error)(
          `[utb] soft allocation ${allocation.id} exceeded for ${allocation.subject}: ` +
            `$${spentUsd.toFixed(2)} of $${allocation.limitUsd.toFixed(2)}`,
        );
      }
      return base;
    },
    record(principalId, costUsd, now) {
      return inner.record(principalId, costUsd, now);
    },
  };
}
