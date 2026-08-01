import type { ScopeId } from "../types.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import { DEFAULT_AGENT_OUTPUT_USD_PER_MTOK } from "../model/pi-models.ts";
import { estimateCostUsd } from "./budget.ts";

export type TokenLedgerPhase = "turn" | "detect" | "compact" | "screen" | "other";

export interface TokenLedgerEntry {
  at: number;
  principalId: string;
  scopeLabel: ScopeId;
  sessionId?: string;
  runId?: string;
  model: string;
  phase: TokenLedgerPhase;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  estimated: boolean;
}

export interface TokenLedgerTotals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  estimatedCalls: number;
}

export type TokenLedgerGroupBy = "principal" | "scope" | "model" | "phase";

export interface TokenLedgerQuery {
  since?: number;
  until?: number;
  principalId?: string;
  scopeLabel?: string;
  limit?: number;
}

export interface TokenLedger {
  record(entry: TokenLedgerEntry): void | Promise<void>;
  summary(groupBy: TokenLedgerGroupBy, opts?: TokenLedgerQuery): Promise<Array<{ key: string } & TokenLedgerTotals>>;
  list(opts?: TokenLedgerQuery): Promise<TokenLedgerEntry[]>;
}

export function usageCostUsd(usage: LlmCallUsage): { costUsd: number; estimated: boolean } {
  if (usage.costUsd > 0) return { costUsd: usage.costUsd, estimated: false };
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    costUsd: estimateCostUsd(input) + (usage.output / 1_000_000) * DEFAULT_AGENT_OUTPUT_USD_PER_MTOK,
    estimated: true,
  };
}

export function estimatedEntryFromInputTokens(base: {
  principalId: string;
  scopeLabel: ScopeId;
  model: string;
  phase: TokenLedgerPhase;
  inputTokens: number;
  sessionId?: string;
  runId?: string;
  at?: number;
}): TokenLedgerEntry {
  return {
    at: base.at ?? Date.now(),
    principalId: base.principalId,
    scopeLabel: base.scopeLabel,
    ...(base.sessionId ? { sessionId: base.sessionId } : {}),
    ...(base.runId ? { runId: base.runId } : {}),
    model: base.model,
    phase: base.phase,
    input: base.inputTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: estimateCostUsd(base.inputTokens),
    estimated: true,
  };
}

export function entryFromUsage(base: {
  principalId: string;
  scopeLabel: ScopeId;
  model: string;
  phase: TokenLedgerPhase;
  usage: LlmCallUsage;
  sessionId?: string;
  runId?: string;
  at?: number;
}): TokenLedgerEntry {
  const { costUsd, estimated } = usageCostUsd(base.usage);
  return {
    at: base.at ?? Date.now(),
    principalId: base.principalId,
    scopeLabel: base.scopeLabel,
    ...(base.sessionId ? { sessionId: base.sessionId } : {}),
    ...(base.runId ? { runId: base.runId } : {}),
    model: base.model,
    phase: base.phase,
    input: base.usage.input,
    output: base.usage.output,
    cacheRead: base.usage.cacheRead,
    cacheWrite: base.usage.cacheWrite,
    costUsd,
    estimated,
  };
}

function groupKey(entry: TokenLedgerEntry, groupBy: TokenLedgerGroupBy): string {
  if (groupBy === "principal") return entry.principalId;
  if (groupBy === "scope") return entry.scopeLabel;
  if (groupBy === "model") return entry.model;
  return entry.phase;
}

function matches(entry: TokenLedgerEntry, opts: TokenLedgerQuery): boolean {
  if (opts.since !== undefined && entry.at < opts.since) return false;
  if (opts.until !== undefined && entry.at >= opts.until) return false;
  if (opts.principalId !== undefined && entry.principalId !== opts.principalId) return false;
  if (opts.scopeLabel !== undefined && entry.scopeLabel !== opts.scopeLabel) return false;
  return true;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_LIST_LIMIT = 1_000;

export function createMemoryTokenLedger(opts: { max?: number } = {}): TokenLedger {
  const max = Math.max(1, opts.max ?? DEFAULT_MAX_ENTRIES);
  const entries: TokenLedgerEntry[] = [];
  return {
    record(entry) {
      entries.push(entry);
      if (entries.length > max) entries.splice(0, entries.length - max);
    },
    summary(groupBy, queryOpts = {}) {
      const totals = new Map<string, TokenLedgerTotals>();
      for (const entry of entries) {
        if (!matches(entry, queryOpts)) continue;
        const key = groupKey(entry, groupBy);
        const t = totals.get(key) ?? {
          calls: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0,
          estimatedCalls: 0,
        };
        t.calls += 1;
        t.input += entry.input;
        t.output += entry.output;
        t.cacheRead += entry.cacheRead;
        t.cacheWrite += entry.cacheWrite;
        t.costUsd += entry.costUsd;
        if (entry.estimated) t.estimatedCalls += 1;
        totals.set(key, t);
      }
      return Promise.resolve(
        [...totals.entries()].map(([key, t]) => ({ key, ...t })).sort((a, b) => b.costUsd - a.costUsd),
      );
    },
    list(queryOpts = {}) {
      const limit = queryOpts.limit ?? DEFAULT_LIST_LIMIT;
      const out: TokenLedgerEntry[] = [];
      for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
        const entry = entries[i]!;
        if (matches(entry, queryOpts)) out.push(entry);
      }
      return Promise.resolve(out);
    },
  };
}
