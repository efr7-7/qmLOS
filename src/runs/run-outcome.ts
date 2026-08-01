import type { ScopeId } from "../types.ts";
import type { Run } from "./run-store.ts";

export type RunOutcomeKind = "code-pushed" | "artifact" | "sent-internal" | "chat";

export interface RunOutcomeRecord {
  runId: string;
  principalId: string;
  scopeLabel: ScopeId;
  outcome: RunOutcomeKind;
  costUsd: number;
  at: number;
}

export interface RunOutcomeTotals {
  runs: number;
  costUsd: number;
  byOutcome: Record<RunOutcomeKind, number>;
}

export interface RunOutcomeStore {
  record(record: RunOutcomeRecord): Promise<void>;
  list(opts?: { since?: number; principalId?: string; limit?: number }): Promise<RunOutcomeRecord[]>;
  summary(opts?: { since?: number }): Promise<Array<{ principalId: string } & RunOutcomeTotals>>;
}

export function classifyRun(run: Run, signals: { gitPushed: boolean }): RunOutcomeKind {
  if (signals.gitPushed) return "code-pushed";
  if (run.result?.attachments?.length) return "artifact";
  if (run.request.conversation.kind !== "dm") return "sent-internal";
  return "chat";
}

const emptyByOutcome = (): Record<RunOutcomeKind, number> => ({
  "code-pushed": 0,
  artifact: 0,
  "sent-internal": 0,
  chat: 0,
});

const DEFAULT_MAX = 20_000;

export function createMemoryRunOutcomeStore(opts: { max?: number } = {}): RunOutcomeStore {
  const max = Math.max(1, opts.max ?? DEFAULT_MAX);
  const records: RunOutcomeRecord[] = [];
  return {
    record(record) {
      records.push(record);
      if (records.length > max) records.splice(0, records.length - max);
      return Promise.resolve();
    },
    list(listOpts = {}) {
      const limit = listOpts.limit ?? 1_000;
      const out: RunOutcomeRecord[] = [];
      for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
        const record = records[i]!;
        if (listOpts.since !== undefined && record.at < listOpts.since) continue;
        if (listOpts.principalId !== undefined && record.principalId !== listOpts.principalId) continue;
        out.push(record);
      }
      return Promise.resolve(out);
    },
    summary(summaryOpts = {}) {
      const totals = new Map<string, RunOutcomeTotals>();
      for (const record of records) {
        if (summaryOpts.since !== undefined && record.at < summaryOpts.since) continue;
        const t = totals.get(record.principalId) ?? { runs: 0, costUsd: 0, byOutcome: emptyByOutcome() };
        t.runs += 1;
        t.costUsd += record.costUsd;
        t.byOutcome[record.outcome] += 1;
        totals.set(record.principalId, t);
      }
      return Promise.resolve([...totals.entries()].map(([principalId, t]) => ({ principalId, ...t })));
    },
  };
}
