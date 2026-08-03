import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import type { DirectoryMember } from "./directory-store.ts";
import { personKey } from "./person.ts";

export type RosterOverrideState = "member" | "removed";

export interface RosterOverride {
  principalId: string;
  state: RosterOverrideState;
  displayName?: string;
  at: number;
}

export interface RosterOverrideStore {
  list(): Promise<RosterOverride[]>;
  get(principalId: string): Promise<RosterOverride | null>;
  isRemoved(principalId: string): Promise<boolean>;
  remember(member: { principalId: string; displayName?: string }, at?: number): Promise<void>;
  tombstone(member: { principalId: string; displayName?: string }, at?: number): Promise<void>;
  forget(principalId: string): Promise<void>;
  merge(members: readonly DirectoryMember[]): Promise<DirectoryMember[]>;
}

export function createRosterOverrideStore(backing?: DurableMap<RosterOverride>): RosterOverrideStore {
  const store = backing ?? createMemoryMap<RosterOverride>();

  return {
    async list() {
      return store.all();
    },
    async get(principalId) {
      const key = personKey(principalId);
      return key ? store.get(key) : null;
    },
    async isRemoved(principalId) {
      const key = personKey(principalId);
      if (!key) return false;
      return (await store.get(key))?.state === "removed";
    },
    async remember(member, at = Date.now()) {
      const key = personKey(member.principalId);
      if (!key) return;
      await store.put(key, {
        principalId: member.principalId,
        state: "member",
        ...(member.displayName ? { displayName: member.displayName } : {}),
        at,
      });
    },
    async tombstone(member, at = Date.now()) {
      const key = personKey(member.principalId);
      if (!key) return;
      const kept = member.displayName?.trim() || (await store.get(key))?.displayName?.trim() || "";
      await store.put(key, {
        principalId: member.principalId,
        state: "removed",
        ...(kept ? { displayName: kept } : {}),
        at,
      });
    },
    async forget(principalId) {
      const key = personKey(principalId);
      if (key) await store.delete(key);
    },
    async merge(members) {
      const overrides = await store.all();
      if (!overrides.length) return [...members];
      const byKey = new Map(overrides.map((o) => [personKey(o.principalId), o] as const));
      const kept: DirectoryMember[] = [];
      const seen = new Set<string>();
      for (const member of members) {
        const key = personKey(member.principalId);
        const override = byKey.get(key);
        if (override?.state === "removed") continue;
        seen.add(key);
        kept.push(override?.displayName ? { ...member, displayName: override.displayName } : member);
      }
      for (const override of overrides) {
        const key = personKey(override.principalId);
        if (override.state !== "member" || seen.has(key)) continue;
        kept.push({
          principalId: override.principalId,
          displayName: override.displayName ?? override.principalId,
          type: "internal",
        });
      }
      return kept;
    },
  };
}
