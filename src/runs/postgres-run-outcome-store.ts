import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type { RunOutcomeKind, RunOutcomeRecord, RunOutcomeStore, RunOutcomeTotals } from "./run-outcome.ts";

export function createPostgresRunOutcomeStore(connectionString: string): RunOutcomeStore {
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS run_outcomes(
        run_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        scope_label TEXT NOT NULL,
        outcome TEXT NOT NULL,
        cost_usd DOUBLE PRECISION NOT NULL,
        at BIGINT NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS run_outcomes_by_principal_at ON run_outcomes(principal_id, at)`,
    `CREATE INDEX IF NOT EXISTS run_outcomes_by_at ON run_outcomes(at)`,
  ]);

  return {
    async record(record) {
      try {
        await q(
          `INSERT INTO run_outcomes(run_id, principal_id, scope_label, outcome, cost_usd, at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (run_id) DO UPDATE SET outcome = $4, cost_usd = $5`,
          [record.runId, record.principalId, record.scopeLabel, record.outcome, record.costUsd, record.at],
        );
      } catch (err) {
        console.error("[run-outcome] failed to persist:", err);
      }
    },
    async list(opts = {}) {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (opts.since !== undefined) {
        params.push(opts.since);
        conds.push(`at >= $${params.length}`);
      }
      if (opts.principalId !== undefined) {
        params.push(opts.principalId);
        conds.push(`principal_id = $${params.length}`);
      }
      if (opts.runId !== undefined) {
        params.push(opts.runId);
        conds.push(`run_id = $${params.length}`); // run_id is the primary key
      }
      params.push(opts.limit ?? 1_000);
      const rows = await q(
        `SELECT * FROM run_outcomes ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
         ORDER BY at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map((row): RunOutcomeRecord => ({
        runId: String(row.run_id),
        principalId: String(row.principal_id),
        scopeLabel: String(row.scope_label) as ScopeId,
        outcome: String(row.outcome) as RunOutcomeKind,
        costUsd: Number(row.cost_usd),
        at: Number(row.at),
      }));
    },
    async summary(opts = {}) {
      const params: unknown[] = [];
      let clause = "";
      if (opts.since !== undefined) {
        params.push(opts.since);
        clause = `WHERE at >= $${params.length}`;
      }
      const rows = await q(
        `SELECT principal_id,
                COUNT(*) AS runs,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COUNT(*) FILTER (WHERE outcome = 'code-pushed') AS code_pushed,
                COUNT(*) FILTER (WHERE outcome = 'artifact') AS artifact,
                COUNT(*) FILTER (WHERE outcome = 'sent-internal') AS sent_internal,
                COUNT(*) FILTER (WHERE outcome = 'chat') AS chat
         FROM run_outcomes ${clause}
         GROUP BY principal_id`,
        params,
      );
      return rows.map((row): { principalId: string } & RunOutcomeTotals => ({
        principalId: String(row.principal_id),
        runs: Number(row.runs),
        costUsd: Number(row.cost_usd),
        byOutcome: {
          "code-pushed": Number(row.code_pushed),
          artifact: Number(row.artifact),
          "sent-internal": Number(row.sent_internal),
          chat: Number(row.chat),
        },
      }));
    },
  };
}
