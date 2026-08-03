import type { TokenLedger, TokenLedgerEntry, TokenLedgerPhase } from "../ratelimit/token-ledger.ts";
import type { TeamStore } from "../directory/team-store.ts";
import type { AllocationStore } from "../ratelimit/allocation-store.ts";
import type { RunOutcomeKind, RunOutcomeStore } from "../runs/run-outcome.ts";
import type { AdminGrantStore } from "../admin/admin-grant-store.ts";
import { personalScope, scopeId } from "../types.ts";

export interface DemoSeedStores {
  tokenLedger: TokenLedger;
  teams: TeamStore;
  allocations: AllocationStore;
  runOutcomes: RunOutcomeStore;
  adminGrants: AdminGrantStore;
  directory?: {
    replace(members: Array<{ principalId: string; displayName: string; type: "internal" }>): Promise<void>;
  };
  orgId: string;
}

const DISPLAY_NAMES: Record<string, string> = {
  demo: "Demo Admin",
  maya: "Maya Okafor",
  tomas: "Tomas Lind",
  ines: "Ines Ferreira",
};

export interface DemoSeedOptions {
  now?: number;
  ledgerEntries?: number;
  runOutcomes?: number;
  randomSeed?: number;
}

export interface DemoSeedResult {
  seeded: boolean;
  ledgerEntries: number;
  runOutcomes: number;
  totalCostUsd: number;
}

const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;
const DEFAULT_LEDGER_ENTRIES = 2_000;
const DEFAULT_RUN_OUTCOMES = 120;

export const DEMO_PRINCIPAL = "demo";

const PRINCIPALS = [
  { id: "demo", team: "platform", weight: 0.36 },
  { id: "maya", team: "platform", weight: 0.28 },
  { id: "tomas", team: "growth", weight: 0.21 },
  { id: "ines", team: "growth", weight: 0.15 },
] as const;

const MODELS = [
  { id: "claude-fable-5", inUsdPerMTok: 15, outUsdPerMTok: 75, weight: 0.45 },
  { id: "claude-sonnet-5", inUsdPerMTok: 3, outUsdPerMTok: 15, weight: 0.35 },
  { id: "gpt-5.2", inUsdPerMTok: 2.5, outUsdPerMTok: 10, weight: 0.2 },
] as const;

const PHASES: ReadonlyArray<{ phase: TokenLedgerPhase; weight: number }> = [
  { phase: "turn", weight: 0.55 },
  { phase: "detect", weight: 0.2 },
  { phase: "compact", weight: 0.15 },
  { phase: "screen", weight: 0.1 },
];

const HARNESSES: ReadonlyArray<{ id: string; weight: number }> = [
  { id: "claude", weight: 0.6 },
  { id: "codex", weight: 0.25 },
  { id: "opencode", weight: 0.15 },
];

const OUTCOMES: ReadonlyArray<{ kind: RunOutcomeKind; weight: number; costScale: number }> = [
  { kind: "code-pushed", weight: 0.35, costScale: 2.4 },
  { kind: "artifact", weight: 0.25, costScale: 1.6 },
  { kind: "sent-internal", weight: 0.25, costScale: 0.8 },
  { kind: "chat", weight: 0.15, costScale: 0.3 },
];

const CLAUDE_CODE_SHARE = 0.25;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T extends { weight: number }>(rand: () => number, items: ReadonlyArray<T>): T {
  let roll = rand();
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]!;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function ledgerEntryAt(rand: () => number, at: number, external: boolean): TokenLedgerEntry {
  const principal = pick(rand, PRINCIPALS);
  const model = external ? pick(rand, MODELS.slice(0, 2)) : pick(rand, MODELS);
  const phase = external ? "external" : pick(rand, PHASES).phase;
  const harness = external ? "claude" : pick(rand, HARNESSES).id;
  const heavy = phase === "turn" || phase === "external";
  const input = Math.round((heavy ? 900 : 250) * Math.exp(rand() * 2.2));
  const output = Math.round((heavy ? 220 : 60) * Math.exp(rand() * 2));
  const cacheRead = heavy ? Math.round(6_000 * Math.exp(rand() * 1.8)) : 0;
  const cacheWrite = heavy && rand() < 0.4 ? Math.round(input * (0.5 + rand())) : 0;
  const costUsd = round4(
    ((input + cacheWrite * 1.25) * model.inUsdPerMTok +
      cacheRead * model.inUsdPerMTok * 0.1 +
      output * model.outUsdPerMTok) /
      1_000_000,
  );
  return {
    at,
    principalId: principal.id,
    scopeLabel: personalScope(principal.id),
    model: model.id,
    phase,
    ...(external ? { source: "claude-code" } : {}),
    harness,
    input,
    output,
    cacheRead,
    cacheWrite,
    costUsd,
    estimated: external,
  };
}

export async function seedDemoData(stores: DemoSeedStores, opts: DemoSeedOptions = {}): Promise<DemoSeedResult> {
  const now = opts.now ?? Date.now();
  const rand = mulberry32(opts.randomSeed ?? 0xd3a0);
  const ledgerTarget = opts.ledgerEntries ?? DEFAULT_LEDGER_ENTRIES;
  const outcomeTarget = opts.runOutcomes ?? DEFAULT_RUN_OUTCOMES;

  await stores.adminGrants.add({
    principalId: DEMO_PRINCIPAL,
    scopeId: scopeId("org", stores.orgId),
    role: "org_admin",
    grantedBy: "demo-seed",
    createdAt: now,
  });

  const existing = await stores.tokenLedger.list({ limit: 1 });
  if (existing.length > 0) return { seeded: false, ledgerEntries: 0, runOutcomes: 0, totalCostUsd: 0 };

  await stores.teams.upsert({ id: "platform", name: "Platform", parentId: null });
  await stores.teams.upsert({ id: "growth", name: "Growth", parentId: null });
  for (const principal of PRINCIPALS) await stores.teams.setMember(principal.team, principal.id);

  await stores.directory?.replace(
    PRINCIPALS.map((principal) => ({
      principalId: principal.id,
      displayName: DISPLAY_NAMES[principal.id] ?? principal.id,
      type: "internal" as const,
    })),
  );

  await stores.allocations.upsert({ id: "demo-org", subject: "org", limitUsd: 400, windowMs: MONTH_MS, hard: true });
  await stores.allocations.upsert({
    id: "demo-team-platform",
    subject: "team:platform",
    limitUsd: 250,
    windowMs: MONTH_MS,
    hard: true,
  });
  await stores.allocations.upsert({
    id: "demo-team-growth",
    subject: "team:growth",
    limitUsd: 150,
    windowMs: MONTH_MS,
    hard: false,
  });
  await stores.allocations.upsert({
    id: "demo-principal-ines",
    subject: "principal:ines",
    limitUsd: 5,
    windowMs: DAY_MS,
    hard: true,
  });

  let totalCostUsd = 0;
  const ats: number[] = [];
  for (let i = 0; i < ledgerTarget; i++) ats.push(now - Math.floor(rand() * 30 * DAY_MS));
  ats.sort((a, b) => a - b);
  const entries: TokenLedgerEntry[] = [];
  for (const at of ats) {
    const entry = ledgerEntryAt(rand, at, rand() < CLAUDE_CODE_SHARE);
    totalCostUsd += entry.costUsd;
    entries.push(entry);
  }

  const unclaimed = new Map<string, TokenLedgerEntry[]>();
  for (const principal of PRINCIPALS) unclaimed.set(principal.id, []);
  for (const entry of entries) unclaimed.get(entry.principalId)?.push(entry);

  const floor = now - 30 * DAY_MS;
  const runs: Array<{ runId: string; entries: TokenLedgerEntry[] }> = [];
  for (let i = 0; i < outcomeTarget; i++) {
    const pool = unclaimed.get(pick(rand, PRINCIPALS).id) ?? [];
    const wanted = 2 + Math.floor(rand() * 4);
    if (pool.length < wanted) continue;
    const claimed = pool.splice(Math.floor(rand() * (pool.length - wanted + 1)), wanted);
    const runId = `demo-run-${i + 1}`;
    const sessionId = `demo-thread-${i + 1}`;
    const harness = claimed[claimed.length - 1]!.harness ?? "claude";
    const finishedAt = claimed[claimed.length - 1]!.at;
    claimed.forEach((entry, step) => {
      entry.runId = runId;
      entry.sessionId = sessionId;
      entry.harness = harness;
      entry.at = Math.max(floor, finishedAt - (claimed.length - 1 - step) * Math.round(40_000 + rand() * 140_000));
    });
    runs.push({ runId, entries: claimed });
  }

  entries.sort((a, b) => a.at - b.at);
  for (const entry of entries) await stores.tokenLedger.record(entry);

  for (const run of runs) {
    const finished = run.entries[run.entries.length - 1]!;
    await stores.runOutcomes.record({
      runId: run.runId,
      principalId: finished.principalId,
      scopeLabel: personalScope(finished.principalId),
      outcome: pick(rand, OUTCOMES).kind,
      costUsd: round4(run.entries.reduce((sum, entry) => sum + entry.costUsd, 0)),
      at: finished.at,
    });
  }

  return { seeded: true, ledgerEntries: ledgerTarget, runOutcomes: runs.length, totalCostUsd: round4(totalCostUsd) };
}
