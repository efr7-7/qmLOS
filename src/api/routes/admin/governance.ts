import { parseScopeId } from "../../../types.ts";
import { sendJson } from "../../http.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import type { TokenLedgerQuery, TokenLedgerTotals } from "../../../ratelimit/token-ledger.ts";
import type { RunOutcomeKind } from "../../../runs/run-outcome.ts";
import type { AllocationSubject } from "../../../ratelimit/allocation-store.ts";
import { allocationSpendUsd } from "../../../ratelimit/allocation-budget.ts";

const DEFAULT_WINDOW_MS = 30 * 86_400_000;
const OUTCOME_SCAN_LIMIT = 20_000;

type TotalsRow = { key: string } & TokenLedgerTotals;

const emptyTotals = (): TokenLedgerTotals => ({
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  estimatedCalls: 0,
});

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function allocationKind(subject: AllocationSubject): "org" | "team" | "principal" {
  if (subject === "org") return "org";
  if (subject.startsWith("team:")) return "team";
  return "principal";
}

function windowSince(url: URL): number {
  const raw = Number(url.searchParams.get("since") ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : Date.now() - DEFAULT_WINDOW_MS;
}

function foldTotals(rows: readonly TotalsRow[]): TokenLedgerTotals {
  const out = emptyTotals();
  for (const row of rows) {
    out.calls += row.calls;
    out.input += row.input;
    out.output += row.output;
    out.cacheRead += row.cacheRead;
    out.cacheWrite += row.cacheWrite;
    out.costUsd += row.costUsd;
    out.estimatedCalls += row.estimatedCalls;
  }
  return out;
}

function enrich<T extends TokenLedgerTotals>(
  totals: T,
): T & {
  totalTokens: number;
  effectiveUsdPerMtok: number | null;
  cacheReadShare: number | null;
  estimatedShare: number;
} {
  const inputSide = totals.input + totals.cacheRead + totals.cacheWrite;
  const totalTokens = inputSide + totals.output;
  return {
    ...totals,
    totalTokens,
    effectiveUsdPerMtok: totalTokens > 0 ? (totals.costUsd / totalTokens) * 1_000_000 : null,
    cacheReadShare: inputSide > 0 ? totals.cacheRead / inputSide : null,
    estimatedShare: totals.calls > 0 ? totals.estimatedCalls / totals.calls : 0,
  };
}

export async function utbPeople(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "utb.people.read", resource: "people", scopeLabel: scope });

  const since = windowSince(url);
  const orgWide = parseScopeId(scope).kind === "org";
  const scopeFilter: TokenLedgerQuery = orgWide ? {} : { scopeLabel: scope };
  const ledgerRows = (await deps.tokenLedger?.summary("principal", { since, ...scopeFilter }).catch(() => [])) ?? [];
  const members = (await deps.directory?.list().catch(() => [])) ?? [];
  const teams = (await deps.teams?.list().catch(() => [])) ?? [];
  const allocations = (await deps.allocations?.list().catch(() => [])) ?? [];

  const teamNames = new Map(teams.map((team) => [team.id, team.name] as const));
  const displayNames = new Map(members.filter((m) => m.principalId).map((m) => [m.principalId, m.displayName]));
  const totals = new Map(ledgerRows.map((row) => [row.key, row] as const));
  const allocationSubjects = new Set(allocations.map((a) => a.subject as string));

  const ids = new Set<string>();
  for (const member of members) if (member.principalId) ids.add(member.principalId);
  for (const row of ledgerRows) ids.add(row.key);
  for (const team of teams) {
    for (const member of (await deps.teams?.members(team.id).catch(() => [])) ?? []) ids.add(member);
  }

  const people = await Promise.all(
    [...ids].map(async (principalId) => {
      const row = totals.get(principalId) ?? null;
      const teamId = (await deps.teams?.teamOf(principalId).catch(() => null)) ?? null;
      const status = (await deps.admin?.adminStatusOf({ id: principalId, type: "internal" }).catch(() => null)) ?? null;
      const latest = (await deps.tokenLedger?.list({ principalId, limit: 1, ...scopeFilter }).catch(() => [])) ?? [];
      return {
        principalId,
        displayName: displayNames.get(principalId) ?? principalId,
        teamId,
        teamName: teamId ? (teamNames.get(teamId) ?? null) : null,
        isAdmin: status?.isAdmin === true,
        adminRole: status?.role ?? null,
        calls: row?.calls ?? 0,
        totalTokens: row ? row.input + row.output + row.cacheRead + row.cacheWrite : 0,
        costUsd: row?.costUsd ?? 0,
        lastActiveAt: latest[0]?.at ?? null,
        hasOwnAllocation: allocationSubjects.has(`principal:${principalId}`),
      };
    }),
  );
  people.sort((a, b) => b.costUsd - a.costUsd || compareIds(a.principalId, b.principalId));

  return sendJson(res, 200, {
    since,
    scopeId: scope,
    orgWide,
    totalCostUsd: ledgerRows.reduce((sum, row) => sum + row.costUsd, 0),
    total: people.length,
    people,
  });
}

export async function utbPerson(ctx: ApiCtx): Promise<void> {
  const { res, deps, url, params } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  const principalId = params.id!;
  audit(deps, { principalId: actor.id, action: "utb.person.read", resource: principalId, scopeLabel: scope });

  const since = windowSince(url);
  const now = Date.now();
  const orgWide = parseScopeId(scope).kind === "org";
  const scopeFilter: TokenLedgerQuery = orgWide ? {} : { scopeLabel: scope };
  const base: TokenLedgerQuery = { since, principalId, ...scopeFilter };

  const byPhase = (await deps.tokenLedger?.summary("phase", base).catch(() => [])) ?? [];
  const byModel = (await deps.tokenLedger?.summary("model", base).catch(() => [])) ?? [];
  const bySource = (await deps.tokenLedger?.summary("source", base).catch(() => [])) ?? [];
  const byHarness = (await deps.tokenLedger?.summary("harness", base).catch(() => [])) ?? [];
  const latest = (await deps.tokenLedger?.list({ ...base, limit: 1 }).catch(() => [])) ?? [];
  const totals = foldTotals(byPhase);

  const member = (await deps.directory?.get(principalId).catch(() => null)) ?? null;
  const teamId = (await deps.teams?.teamOf(principalId).catch(() => null)) ?? null;
  const status = (await deps.admin?.adminStatusOf({ id: principalId, type: "internal" }).catch(() => null)) ?? null;
  const allTeams = (await deps.teams?.list().catch(() => [])) ?? [];
  const teamNames = new Map(allTeams.map((team) => [team.id, team.name] as const));
  const ancestry = teamId ? ((await deps.teams?.ancestry(teamId).catch(() => [])) ?? []) : [];

  const subjects: AllocationSubject[] = ["org", `principal:${principalId}`];
  for (const ancestor of ancestry) subjects.push(`team:${ancestor}`);
  const governing = (await deps.allocations?.forSubjects(subjects).catch(() => [])) ?? [];
  const ownAllocation = governing.some((a) => a.subject === `principal:${principalId}`);

  if (totals.calls === 0 && !member && !teamId && !ownAllocation && status?.isAdmin !== true && !latest.length) {
    return sendJson(res, 404, { error: "not_found", message: `no person ${principalId}` });
  }

  const allocations = await Promise.all(
    governing.map(async (allocation) => {
      const spentUsd =
        deps.teams && deps.tokenLedger
          ? await allocationSpendUsd({ teams: deps.teams, ledger: deps.tokenLedger }, allocation, now).catch(() => null)
          : null;
      return {
        id: allocation.id,
        subject: allocation.subject,
        kind: allocationKind(allocation.subject),
        limitUsd: allocation.limitUsd,
        windowMs: allocation.windowMs,
        hard: allocation.hard,
        spentUsd,
        remainingUsd: spentUsd === null ? null : allocation.limitUsd - spentUsd,
        utilization: spentUsd === null || allocation.limitUsd <= 0 ? null : spentUsd / allocation.limitUsd,
        exceeded: spentUsd === null ? null : spentUsd >= allocation.limitUsd,
      };
    }),
  );

  const outcomeRecords =
    (await deps.runOutcomes?.list({ since, principalId, limit: OUTCOME_SCAN_LIMIT }).catch(() => [])) ?? [];
  const byOutcome: Record<RunOutcomeKind, number> = { "code-pushed": 0, artifact: 0, "sent-internal": 0, chat: 0 };
  let outcomeCostUsd = 0;
  for (const record of outcomeRecords) {
    byOutcome[record.outcome] += 1;
    outcomeCostUsd += record.costUsd;
  }
  const produced = byOutcome["code-pushed"] + byOutcome.artifact + byOutcome["sent-internal"];

  return sendJson(res, 200, {
    since,
    scopeId: scope,
    orgWide,
    principalId,
    displayName: member?.displayName ?? principalId,
    isAdmin: status?.isAdmin === true,
    adminRole: status?.role ?? null,
    adminScopeId: status?.scopeId ?? null,
    lastActiveAt: latest[0]?.at ?? null,
    totals: enrich(totals),
    breakdowns: {
      byModel: byModel.map((row) => enrich(row)),
      byHarness: byHarness.map((row) => enrich(row)),
      byPhase: byPhase.map((row) => enrich(row)),
      bySource: bySource.map((row) => enrich(row)),
    },
    outcomes: {
      runs: outcomeRecords.length,
      costUsd: outcomeCostUsd,
      ledgerCostUsd: totals.costUsd,
      costBasis: { costUsd: "run-outcomes", ledgerCostUsd: "token-ledger" },
      byOutcome,
      produced,
      costPerOutcomeUsd: produced > 0 ? outcomeCostUsd / produced : null,
      ledgerCostPerOutcomeUsd: produced > 0 ? totals.costUsd / produced : null,
    },
    team: teamId ? { id: teamId, name: teamNames.get(teamId) ?? teamId } : null,
    teamAncestry: ancestry.map((id) => ({ id, name: teamNames.get(id) ?? id })),
    allocations,
  });
}

export async function putUtbTeamMember(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  if (!deps.teams) return sendJson(res, 404, { error: "not_found" });
  const teamId = params.id!;
  const principalId = params.principalId!;
  if (!(await deps.teams.list()).some((team) => team.id === teamId)) {
    return sendJson(res, 404, { error: "not_found", message: `no team ${teamId}` });
  }
  const previousTeamId = await deps.teams.teamOf(principalId);
  await deps.teams.setMember(teamId, principalId);
  audit(deps, {
    principalId: authz.actor.id,
    action: "utb.teams.member.write",
    resource: `${teamId}/${principalId}`,
    scopeLabel: authz.scope,
  });
  return sendJson(res, 200, { ok: true, teamId, principalId, previousTeamId });
}

export async function deleteUtbTeamMember(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  if (!deps.teams) return sendJson(res, 404, { error: "not_found" });
  const teamId = params.id!;
  const principalId = params.principalId!;
  const current = await deps.teams.teamOf(principalId);
  if (current !== teamId) {
    return sendJson(res, 404, { error: "not_found", message: `${principalId} is not a member of ${teamId}` });
  }
  await deps.teams.removeMember(principalId);
  audit(deps, {
    principalId: authz.actor.id,
    action: "utb.teams.member.delete",
    resource: `${teamId}/${principalId}`,
    scopeLabel: authz.scope,
  });
  return sendJson(res, 200, { ok: true, teamId, principalId });
}
