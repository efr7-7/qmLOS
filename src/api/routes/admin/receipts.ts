import { parseScopeId } from "../../../types.ts";
import { sendJson } from "../../http.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import type { TokenLedgerEntry, TokenLedgerPhase, TokenLedgerQuery } from "../../../ratelimit/token-ledger.ts";
import type { RunOutcomeKind, RunOutcomeRecord } from "../../../runs/run-outcome.ts";
import { enrich, foldTotals, governingAllocations } from "./governance.ts";

const LEDGER_SCAN_LIMIT = 20_000;
const OUTCOME_SCAN_LIMIT = 20_000;
const DEFAULT_LIST_LIMIT = 12;
const MAX_LIST_LIMIT = 100;

const PHASE_ORDER: TokenLedgerPhase[] = ["turn", "external", "detect", "compact", "screen", "other"];

function phaseRank(key: string): number {
  const at = PHASE_ORDER.indexOf(key as TokenLedgerPhase);
  return at === -1 ? PHASE_ORDER.length : at;
}

interface ReceiptItem {
  phase: TokenLedgerPhase;
  model: string;
  harness: string;
  source: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  estimatedCalls: number;
}

function itemize(entries: readonly TokenLedgerEntry[]): ReceiptItem[] {
  const items = new Map<string, ReceiptItem>();
  for (const e of entries) {
    const harness = e.harness ?? "unknown";
    const source = e.source ?? "los";
    const key = `${e.phase}\u0000${e.model}\u0000${harness}\u0000${source}`;
    const item = items.get(key) ?? {
      phase: e.phase,
      model: e.model,
      harness,
      source,
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0,
      estimatedCalls: 0,
    };
    item.calls += 1;
    item.input += e.input;
    item.output += e.output;
    item.cacheRead += e.cacheRead;
    item.cacheWrite += e.cacheWrite;
    item.totalTokens += e.input + e.output + e.cacheRead + e.cacheWrite;
    item.costUsd += e.costUsd;
    if (e.estimated) item.estimatedCalls += 1;
    items.set(key, item);
  }
  return [...items.values()].sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || b.costUsd - a.costUsd);
}

function listLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit") ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.floor(raw));
}

async function displayNameOf(deps: ApiCtx["deps"], principalId: string): Promise<string> {
  const member = (await deps.directory?.get(principalId).catch(() => null)) ?? null;
  if (member?.displayName) return member.displayName;
  const override = (await deps.rosterOverrides?.get(principalId).catch(() => null)) ?? null;
  return override?.displayName ?? principalId;
}

function scopeFilterFor(scope: string): TokenLedgerQuery {
  return parseScopeId(scope).kind === "org" ? {} : { scopeLabel: scope };
}

/**
 * Build one run's receipt under an arbitrary ledger filter, so the admin route and the
 * self-serve route produce the identical document from the identical code. The filter is
 * the only thing that differs: an admin is bounded by their scope, a person by their own
 * principal — which is what makes a self receipt safe to expose.
 */
export async function buildReceipt(
  deps: ApiCtx["deps"],
  runId: string,
  filter: TokenLedgerQuery,
): Promise<Record<string, unknown> | null> {
  const base: TokenLedgerQuery = { runId, ...filter };
  const entries = (await deps.tokenLedger?.list({ ...base, limit: LEDGER_SCAN_LIMIT }).catch(() => [])) ?? [];
  if (!entries.length) return null;

  const ordered = [...entries].sort((a, b) => a.at - b.at);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const principalId = first.principalId;

  const byPhase = (await deps.tokenLedger?.summary("phase", base).catch(() => [])) ?? [];
  const byModel = (await deps.tokenLedger?.summary("model", base).catch(() => [])) ?? [];
  const byHarness = (await deps.tokenLedger?.summary("harness", base).catch(() => [])) ?? [];
  const totals = foldTotals(byPhase);

  // Ask for the one run rather than scanning this person's history for it.
  const outcomes = (await deps.runOutcomes?.list({ runId, limit: 1 }).catch(() => [])) ?? [];
  const record = outcomes.find((o) => o.runId === runId) ?? null;

  const teamId = (await deps.teams?.teamOf(principalId).catch(() => null)) ?? null;
  const allTeams = (await deps.teams?.list().catch(() => [])) ?? [];
  const teamNames = new Map(allTeams.map((team) => [team.id, team.name] as const));
  const ancestry = teamId ? ((await deps.teams?.ancestry(teamId).catch(() => [])) ?? []) : [];
  const allocations = await governingAllocations(deps, principalId, ancestry, Date.now());

  return {
    runId,
    principalId,
    displayName: await displayNameOf(deps, principalId),
    sessionId: first.sessionId ?? null,
    scopeLabel: first.scopeLabel,
    at: record?.at ?? last.at,
    firstAt: first.at,
    lastAt: last.at,
    outcome: record ? { kind: record.outcome, costUsd: record.costUsd, at: record.at } : null,
    totals: enrich(totals),
    items: itemize(ordered),
    breakdowns: {
      byPhase: [...byPhase].sort((a, b) => phaseRank(a.key) - phaseRank(b.key)).map((row) => enrich(row)),
      byModel: byModel.map((row) => enrich(row)),
      byHarness: byHarness.map((row) => enrich(row)),
    },
    sources: [...new Set(ordered.map((e) => e.source ?? "los"))],
    team: teamId ? { id: teamId, name: teamNames.get(teamId) ?? teamId } : null,
    teamAncestry: ancestry.map((id) => ({ id, name: teamNames.get(id) ?? id })),
    allocations,
  };
}

export function receiptNotFound(runId: string): Record<string, unknown> {
  return { error: "not_found", runId, message: `no metered work is recorded under run ${runId}` };
}

export async function receipt(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  const runId = params.runId!;
  audit(deps, { principalId: actor.id, action: "receipts.read", resource: runId, scopeLabel: scope });

  const built = await buildReceipt(deps, runId, scopeFilterFor(scope));
  if (!built) return sendJson(res, 404, receiptNotFound(runId));
  return sendJson(res, 200, { scopeId: scope, ...built });
}

interface Bucket {
  costUsd: number;
  calls: number;
  totalTokens: number;
  estimatedCalls: number;
  at: number;
  model: string;
  harness: string;
  sessionId: string | null;
}

function bucketOf(entries: readonly TokenLedgerEntry[]): Bucket {
  const ordered = [...entries].sort((a, b) => a.at - b.at);
  const last = ordered[ordered.length - 1]!;
  const cost = new Map<string, number>();
  let costUsd = 0;
  let totalTokens = 0;
  let estimatedCalls = 0;
  for (const e of ordered) {
    costUsd += e.costUsd;
    totalTokens += e.input + e.output + e.cacheRead + e.cacheWrite;
    if (e.estimated) estimatedCalls += 1;
    cost.set(e.model, (cost.get(e.model) ?? 0) + e.costUsd);
  }
  const model = [...cost.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? last.model;
  return {
    costUsd,
    calls: ordered.length,
    totalTokens,
    estimatedCalls,
    at: last.at,
    model,
    harness: last.harness ?? "unknown",
    sessionId: last.sessionId ?? null,
  };
}

/** Shared by the admin list and the self-serve list; only the ledger filter differs. */
export async function buildReceiptList(
  deps: ApiCtx["deps"],
  limit: number,
  filter: TokenLedgerQuery,
  principalId?: string,
): Promise<{ limit: number; total: number; receipts: Record<string, unknown>[] }> {
  const entries =
    (await deps.tokenLedger
      ?.list({ limit: LEDGER_SCAN_LIMIT, ...filter, ...(principalId ? { principalId } : {}) })
      .catch(() => [])) ?? [];

  const byRun = new Map<string, TokenLedgerEntry[]>();
  for (const entry of entries) {
    if (!entry.runId) continue;
    const held = byRun.get(entry.runId);
    if (held) held.push(entry);
    else byRun.set(entry.runId, [entry]);
  }
  if (!byRun.size) return { limit, total: 0, receipts: [] };

  const outcomes: RunOutcomeRecord[] =
    (await deps.runOutcomes
      ?.list({ limit: OUTCOME_SCAN_LIMIT, ...(principalId ? { principalId } : {}) })
      .catch(() => [])) ?? [];

  const joined = outcomes
    .filter((o) => byRun.has(o.runId))
    .map((o) => ({ outcome: o, bucket: bucketOf(byRun.get(o.runId)!) }))
    .sort((a, b) => b.outcome.at - a.outcome.at);

  const names = new Map<string, string>();
  for (const { outcome } of joined.slice(0, limit)) {
    if (!names.has(outcome.principalId)) names.set(outcome.principalId, await displayNameOf(deps, outcome.principalId));
  }

  return {
    limit,
    total: joined.length,
    receipts: joined.slice(0, limit).map(({ outcome, bucket }) => ({
      runId: outcome.runId,
      principalId: outcome.principalId,
      displayName: names.get(outcome.principalId) ?? outcome.principalId,
      outcome: outcome.outcome as RunOutcomeKind,
      outcomeCostUsd: outcome.costUsd,
      costUsd: bucket.costUsd,
      calls: bucket.calls,
      totalTokens: bucket.totalTokens,
      model: bucket.model,
      harness: bucket.harness,
      sessionId: bucket.sessionId,
      estimated: bucket.estimatedCalls > 0,
      at: outcome.at,
    })),
  };
}

export function receiptListLimit(url: URL): number {
  return listLimit(url);
}

export async function listReceipts(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "receipts.list", resource: "receipts", scopeLabel: scope });

  const built = await buildReceiptList(
    deps,
    listLimit(url),
    scopeFilterFor(scope),
    url.searchParams.get("principalId") || undefined,
  );
  return sendJson(res, 200, { scopeId: scope, ...built });
}
