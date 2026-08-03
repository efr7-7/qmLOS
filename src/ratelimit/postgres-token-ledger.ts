import { createPgPool } from "../persistence/pg-pool.ts";
import type { ScopeId } from "../types.ts";
import type {
  TokenLedger,
  TokenLedgerEntry,
  TokenLedgerGroupBy,
  TokenLedgerPhase,
  TokenLedgerQuery,
  TokenLedgerTotals,
} from "./token-ledger.ts";

const GROUP_COLUMNS: Record<TokenLedgerGroupBy, string> = {
  principal: "principal_id",
  scope: "scope_label",
  model: "model",
  phase: "phase",
  source: "COALESCE(source, 'los')",
  harness: "COALESCE(harness, 'unknown')",
};

export function createPostgresTokenLedger(connectionString: string): TokenLedger {
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS token_ledger(
        id BIGSERIAL PRIMARY KEY,
        at BIGINT NOT NULL,
        principal_id TEXT NOT NULL,
        scope_label TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        model TEXT NOT NULL,
        phase TEXT NOT NULL,
        input_tokens BIGINT NOT NULL,
        output_tokens BIGINT NOT NULL,
        cache_read BIGINT NOT NULL,
        cache_write BIGINT NOT NULL,
        cost_usd DOUBLE PRECISION NOT NULL,
        estimated BOOLEAN NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS token_ledger_by_principal_at ON token_ledger(principal_id, at)`,
    `CREATE INDEX IF NOT EXISTS token_ledger_by_scope_at ON token_ledger(scope_label, at)`,
    `CREATE INDEX IF NOT EXISTS token_ledger_by_at ON token_ledger(at)`,
    `ALTER TABLE token_ledger ADD COLUMN IF NOT EXISTS source TEXT`,
    `ALTER TABLE token_ledger ADD COLUMN IF NOT EXISTS harness TEXT`,
  ]);

  function where(opts: TokenLedgerQuery): { clause: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.since !== undefined) {
      params.push(opts.since);
      conds.push(`at >= $${params.length}`);
    }
    if (opts.until !== undefined) {
      params.push(opts.until);
      conds.push(`at < $${params.length}`);
    }
    if (opts.principalId !== undefined) {
      params.push(opts.principalId);
      conds.push(`principal_id = $${params.length}`);
    }
    if (opts.scopeLabel !== undefined) {
      params.push(opts.scopeLabel);
      conds.push(`scope_label = $${params.length}`);
    }
    if (opts.runId !== undefined) {
      params.push(opts.runId);
      conds.push(`run_id = $${params.length}`);
    }
    if (opts.harness !== undefined) {
      params.push(opts.harness);
      conds.push(`COALESCE(harness, 'unknown') = $${params.length}`);
    }
    return { clause: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
  }

  return {
    async record(entry: TokenLedgerEntry) {
      try {
        await q(
          `INSERT INTO token_ledger(
             at, principal_id, scope_label, session_id, run_id, model, phase,
             input_tokens, output_tokens, cache_read, cache_write, cost_usd, estimated, source, harness
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            entry.at,
            entry.principalId,
            entry.scopeLabel,
            entry.sessionId ?? null,
            entry.runId ?? null,
            entry.model,
            entry.phase,
            entry.input,
            entry.output,
            entry.cacheRead,
            entry.cacheWrite,
            entry.costUsd,
            entry.estimated,
            entry.source ?? null,
            entry.harness ?? null,
          ],
        );
      } catch (err) {
        console.error("[token-ledger] failed to persist entry:", err);
      }
    },
    async summary(groupBy, opts = {}) {
      const { clause, params } = where(opts);
      const col = GROUP_COLUMNS[groupBy];
      const rows = await q(
        `SELECT ${col} AS key,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cache_read), 0) AS cache_read,
                COALESCE(SUM(cache_write), 0) AS cache_write,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COUNT(*) FILTER (WHERE estimated) AS estimated_calls
         FROM token_ledger ${clause}
         GROUP BY ${col}
         ORDER BY cost_usd DESC`,
        params,
      );
      return rows.map((row) => ({
        key: String(row.key),
        calls: Number(row.calls),
        input: Number(row.input),
        output: Number(row.output),
        cacheRead: Number(row.cache_read),
        cacheWrite: Number(row.cache_write),
        costUsd: Number(row.cost_usd),
        estimatedCalls: Number(row.estimated_calls),
      })) as Array<{ key: string } & TokenLedgerTotals>;
    },
    async list(opts = {}) {
      const { clause, params } = where(opts);
      params.push(opts.limit ?? 1_000);
      const rows = await q(
        `SELECT at, principal_id, scope_label, session_id, run_id, model, phase,
                input_tokens, output_tokens, cache_read, cache_write, cost_usd, estimated, source, harness
         FROM token_ledger ${clause}
         ORDER BY at DESC
         LIMIT $${params.length}`,
        params,
      );
      return rows.map((row) => ({
        at: Number(row.at),
        principalId: String(row.principal_id),
        scopeLabel: String(row.scope_label) as ScopeId,
        ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
        ...(row.run_id ? { runId: String(row.run_id) } : {}),
        model: String(row.model),
        phase: String(row.phase) as TokenLedgerPhase,
        input: Number(row.input_tokens),
        output: Number(row.output_tokens),
        cacheRead: Number(row.cache_read),
        cacheWrite: Number(row.cache_write),
        costUsd: Number(row.cost_usd),
        estimated: Boolean(row.estimated),
        ...(row.source ? { source: String(row.source) } : {}),
        ...(row.harness ? { harness: String(row.harness) } : {}),
      }));
    },
  };
}
