export type AllocationSubject = "org" | `team:${string}` | `principal:${string}`;

export interface Allocation {
  id: string;
  subject: AllocationSubject;
  limitUsd: number;
  windowMs: number;
  hard: boolean;
}

export interface AllocationStore {
  upsert(allocation: Allocation): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<Allocation[]>;
  forSubjects(subjects: AllocationSubject[]): Promise<Allocation[]>;
}

export function isAllocationSubject(value: unknown): value is AllocationSubject {
  return typeof value === "string" && (value === "org" || value.startsWith("team:") || value.startsWith("principal:"));
}

export function createMemoryAllocationStore(): AllocationStore {
  const allocations = new Map<string, Allocation>();
  return {
    upsert(allocation) {
      allocations.set(allocation.id, allocation);
      return Promise.resolve();
    },
    remove(id) {
      allocations.delete(id);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([...allocations.values()]);
    },
    forSubjects(subjects) {
      const wanted = new Set(subjects);
      return Promise.resolve([...allocations.values()].filter((a) => wanted.has(a.subject)));
    },
  };
}
