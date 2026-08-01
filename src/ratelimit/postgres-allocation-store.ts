import { createPgPool } from "../persistence/pg-pool.ts";
import type { Allocation, AllocationStore, AllocationSubject } from "./allocation-store.ts";

export function createPostgresAllocationStore(connectionString: string): AllocationStore {
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS utb_allocations(
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        limit_usd DOUBLE PRECISION NOT NULL,
        window_ms BIGINT NOT NULL,
        hard BOOLEAN NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS utb_allocations_by_subject ON utb_allocations(subject)`,
  ]);

  const rowToAllocation = (row: Record<string, unknown>): Allocation => ({
    id: String(row.id),
    subject: String(row.subject) as AllocationSubject,
    limitUsd: Number(row.limit_usd),
    windowMs: Number(row.window_ms),
    hard: Boolean(row.hard),
  });

  return {
    async upsert(allocation) {
      await q(
        `INSERT INTO utb_allocations(id, subject, limit_usd, window_ms, hard) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET subject = $2, limit_usd = $3, window_ms = $4, hard = $5`,
        [allocation.id, allocation.subject, allocation.limitUsd, allocation.windowMs, allocation.hard],
      );
    },
    async remove(id) {
      await q("DELETE FROM utb_allocations WHERE id = $1", [id]);
    },
    async list() {
      return (await q("SELECT * FROM utb_allocations", [])).map(rowToAllocation);
    },
    async forSubjects(subjects) {
      if (!subjects.length) return [];
      return (await q("SELECT * FROM utb_allocations WHERE subject = ANY($1)", [subjects])).map(rowToAllocation);
    },
  };
}
