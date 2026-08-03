import { html, nothing, render, type TemplateResult } from "lit";
import { AlertTriangle, ChevronDown, Pencil, Plus, RefreshCw, Trash2, X } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { subjectLabel } from "./subject-label";
import { icon, initials, relTime } from "./ui";
import { playHue } from "./playground";
import { emptyPlayground } from "./playground";
import { loadReceipts, receiptList, type ReceiptRow } from "./receipt";
import { appState, replacePanePreservingFocus } from "./shell";

interface Person {
  principalId: string;
  displayName?: string;
  teamId?: string | null;
  teamName?: string | null;
  isAdmin?: boolean;
  adminRole?: string | null;
  calls?: number;
  totalTokens?: number;
  costUsd?: number;
  lastActiveAt?: number | null;
  hasOwnAllocation?: boolean;
  unsaved?: boolean;
  status?: "member" | "former";
  removedAt?: number | null;
}

interface PeopleResponse {
  since?: number;
  totalCostUsd?: number;
  total?: number;
  formerTotal?: number;
  people?: Person[];
}

interface Team {
  id: string;
  name: string;
  parentId?: string | null;
  membersVersion?: string;
}

interface Allocation {
  id?: string;
  subject?: string;
  kind?: string;
  limitUsd?: number;
  windowMs?: number;
  hard?: boolean;
  spentUsd?: number | null;
  remainingUsd?: number | null;
  utilization?: number | null;
  exceeded?: boolean | null;
}

interface BreakdownRow {
  key: string;
  calls?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  totalTokens?: number;
  effectiveUsdPerMtok?: number | null;
  cacheReadShare?: number | null;
}

interface PersonDetail {
  principalId?: string;
  displayName?: string;
  isAdmin?: boolean;
  adminRole?: string | null;
  lastActiveAt?: number | null;
  totals?: {
    calls?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    costUsd?: number;
    totalTokens?: number;
    effectiveUsdPerMtok?: number | null;
    cacheReadShare?: number | null;
  };
  breakdowns?: Record<string, BreakdownRow[] | undefined>;
  outcomes?: {
    runs?: number;
    costUsd?: number;
    ledgerCostUsd?: number;
    byOutcome?: Record<string, number>;
    produced?: number;
    costPerOutcomeUsd?: number | null;
    ledgerCostPerOutcomeUsd?: number | null;
  };
  team?: { id?: string; name?: string } | null;
  teamAncestry?: { id: string; name?: string }[];
  allocations?: Allocation[];
}

interface AllocDraft {
  id: string;
  subject: string;
  amount: string;
  window: string;
  hard: boolean;
  editing: boolean;
}

interface PersonDraft {
  principalId: string;
  displayName: string;
  teamId: string;
  isAdmin: boolean;
  amount: string;
  window: string;
  hard: boolean;
}

interface Notice {
  tone: "error" | "info";
  text: string;
  retry: (() => void) | null;
  actionLabel?: string;
}

interface Trouble {
  tone: "error" | "info";
  text: string;
  retry: (() => void) | null;
  discard: (() => void) | null;
}

const WINDOWS: { key: string; label: string; ms: number }[] = [
  { key: "day", label: "Per day", ms: 86_400_000 },
  { key: "week", label: "Per week", ms: 7 * 86_400_000 },
  { key: "month", label: "Per month", ms: 30 * 86_400_000 },
];

const emptyPersonDraft = (): PersonDraft => ({
  principalId: "",
  displayName: "",
  teamId: "",
  isAdmin: false,
  amount: "",
  window: "day",
  hard: true,
});

let people: Person[] | null = null;
let peopleTotal = 0;
let teams: Team[] | null = null;
let allocations: Allocation[] | null = null;
let detail: PersonDetail | null = null;
let detailReceipts: ReceiptRow[] | null = null;
let openPerson: string | null = null;
let detailLoading = false;
let forbidden = false;
let notice: Notice | null = null;
let stale = false;
let pending = new Set<string>();
let trouble = new Map<string, Trouble>();
let live = "";
let teamDraft = { id: "", name: "", parentId: "", membersVersion: "", editing: false };
let teamFormOpen = false;
let confirmTeam = "";
let confirmAlloc = "";
let confirmPerson = "";
let allocFormOpen = false;
let allocDraft: AllocDraft = { id: "", subject: "org", amount: "", window: "month", hard: true, editing: false };
let personFormOpen = false;
let personDraft: PersonDraft = emptyPersonDraft();
let pinned: string[] = [];

export function resetGovernanceState(): void {
  people = null;
  peopleTotal = 0;
  teams = null;
  allocations = null;
  detail = null;
  detailReceipts = null;
  openPerson = null;
  detailLoading = false;
  forbidden = false;
  notice = null;
  stale = false;
  pending = new Set();
  trouble = new Map();
  live = "";
  teamDraft = { id: "", name: "", parentId: "", membersVersion: "", editing: false };
  teamFormOpen = false;
  confirmTeam = "";
  confirmAlloc = "";
  confirmPerson = "";
  allocFormOpen = false;
  allocDraft = { id: "", subject: "org", amount: "", window: "month", hard: true, editing: false };
  personFormOpen = false;
  personDraft = emptyPersonDraft();
  pinned = [];
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function money(v: unknown): string {
  const value = n(v);
  const digits = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${digits}` : `$${digits}`;
}

function moneyTight(v: unknown): string {
  const value = n(v);
  return value >= 1000
    ? `$${Math.round(value).toLocaleString("en-US")}`
    : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTokens(v: unknown): string {
  const value = n(v);
  const one = (x: number) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ""));
  if (value >= 1e9) return `${one(value / 1e9)}B`;
  if (value >= 1e6) return `${one(value / 1e6)}M`;
  if (value >= 1e3) return `${one(value / 1e3)}k`;
  return String(Math.round(value));
}

function fmtCalls(v: unknown): string {
  return n(v).toLocaleString("en-US");
}

function share(v: unknown): number {
  return Math.max(0, Math.min(1, n(v)));
}

function pct(v: unknown): string {
  return `${Math.round(share(v) * 100)}%`;
}

function orgScope(): string {
  return `org:${appState.me?.org ?? ""}`;
}

function scopeQuery(): string {
  return `scope=${encodeURIComponent(orgScope())}`;
}

function windowLabel(windowMs: number): string {
  if (windowMs >= 27 * 86_400_000) return "per month";
  if (windowMs >= 6 * 86_400_000) return "per week";
  if (windowMs >= 86_400_000) return "per day";
  return `per ${Math.max(1, Math.round(windowMs / 3_600_000))}h`;
}

function windowKey(windowMs: number): string {
  if (windowMs >= 27 * 86_400_000) return "month";
  if (windowMs >= 6 * 86_400_000) return "week";
  return "day";
}

function label(subject: string) {
  return subjectLabel(subject, { teams, people });
}

function subjectCell(subject: string): TemplateResult {
  const l = label(subject);
  return html`<span class="subj">
    <span class="subj-name">${l.name}</span>
    ${l.id && l.id !== l.name ? html`<span class="subj-id">${l.id}</span>` : nothing}
    ${l.orphaned ? html`<span class="subj-orphan">orphaned — governs nobody</span>` : nothing}
  </span>`;
}

function meterLevel(over: boolean, used: number): string {
  if (over) return "is-over";
  return used >= 0.8 ? "is-warn" : "";
}

function adminTitle(isSelf: boolean, isAdmin: boolean): string {
  if (isSelf && isAdmin) return "You can't remove your own admin grant";
  return isAdmin ? "Revoke org admin" : "Grant org admin";
}

function subjectKind(subject: string): string {
  return label(subject).chip;
}

function kicker(text: string): TemplateResult {
  return html`<div class="usage-kicker"><span class="usage-kicker-mark"></span>${text}</div>`;
}

function tile(label: string, value: string, sub: unknown = nothing): TemplateResult {
  return html`<div class="usage-tile">
    <div class="usage-tile-label">${label}</div>
    <div class="usage-tile-value">${value}</div>
    ${sub}
  </div>`;
}

function meter(value: number, cls = ""): TemplateResult {
  return html`<div class="usage-meter ${cls}"><span style=${`width:${(share(value) * 100).toFixed(1)}%`}></span></div>`;
}

function card(title: string, blurb: string, head: unknown, body: unknown): TemplateResult {
  return html`<section class="usage-card">
    <div class="usage-card-head gov-card-head">
      <div>
        <h2>${title}</h2>
        <p>${blurb}</p>
      </div>
      ${head}
    </div>
    ${body}
  </section>`;
}

function avatar(id: string, name: string): TemplateResult {
  return html`<span class="gov-avatar" style=${`--gov-hue:${playHue(id)}`}>${initials(name || id)}</span>`;
}

function status(e: unknown): number {
  return Number((e as { status?: number })?.status ?? 0);
}

function busy(key: string): boolean {
  return pending.has(key);
}

function say(text: string): void {
  live = text;
}

function clearTrouble(key: string): void {
  if (trouble.delete(key)) draw();
}

function focusByKey(key: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus());
}

function personKey(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  return s.includes("@") ? s.toLowerCase() : s;
}

interface Mutation {
  key: string;
  label: string;
  apply: () => void;
  rollback: () => void;
  run: () => Promise<void>;
  goneText?: string;
  done?: string;
  discard?: () => void;
  sync?: () => void;
}

async function mutate(m: Mutation): Promise<boolean> {
  if (pending.has(m.key)) return false;
  pending.add(m.key);
  trouble.delete(m.key);
  m.apply();
  draw();
  let ok = true;
  try {
    await m.run();
    if (m.done) say(m.done);
  } catch (e) {
    if (status(e) === 404 && m.goneText) {
      trouble.set(m.key, { tone: "info", text: m.goneText, retry: null, discard: null });
      say(m.goneText);
    } else {
      ok = false;
      m.rollback();
      const text = `${m.label} — ${errMessage(e, "the server refused the change")}`;
      trouble.set(m.key, {
        tone: "error",
        text,
        retry: () => void mutate(m),
        discard: m.discard ?? null,
      });
      say(text);
    }
  }
  pending.delete(m.key);
  draw();
  if (ok) m.sync?.();
  return ok;
}

function orderPeople(rows: Person[]): Person[] {
  const first: Person[] = [];
  for (const id of pinned) {
    const hit = rows.find((p) => p.principalId === id);
    if (hit) first.push(hit);
  }
  return [...first, ...rows.filter((p) => !first.includes(p))];
}

function mergePeople(rows: Person[]): void {
  const held = (people ?? []).filter((p) => p.unsaved);
  const byId = new Set(rows.map((p) => p.principalId));
  people = orderPeople([...held.filter((p) => !byId.has(p.principalId)), ...rows]);
}

async function syncPeople(): Promise<void> {
  if (pending.size) return;
  try {
    const r = await api<PeopleResponse>(`/api/admin/utb/people?${scopeQuery()}`);
    if (appState.currentView !== "governance" || pending.size) return;
    mergePeople(r.people ?? []);
    peopleTotal = n(r.totalCostUsd);
    stale = false;
  } catch {
    stale = people !== null;
  }
  draw();
}

async function syncTeams(): Promise<void> {
  if (pending.size) return;
  try {
    const r = await api<{ teams?: Team[] }>(`/api/admin/utb/teams?${scopeQuery()}`);
    if (appState.currentView !== "governance" || pending.size) return;
    teams = r.teams ?? [];
  } catch {
    stale = teams !== null;
  }
  draw();
}

async function syncAllocations(): Promise<void> {
  if (pending.size) return;
  try {
    const r = await api<{ allocations?: Allocation[] }>(`/api/admin/utb/allocations?${scopeQuery()}`);
    if (appState.currentView !== "governance" || pending.size) return;
    allocations = r.allocations ?? [];
  } catch {
    stale = allocations !== null;
  }
  draw();
}

async function syncDetail(): Promise<void> {
  const who = openPerson;
  if (!who) return;
  try {
    const d = await api<PersonDetail>(`/api/admin/utb/people/${encodeURIComponent(who)}?${scopeQuery()}`);
    if (openPerson !== who) return;
    detail = d;
    draw();
  } catch {
    stale = true;
  }
}

async function reload(): Promise<void> {
  const [p, t, a] = await Promise.allSettled([
    api<PeopleResponse>(`/api/admin/utb/people?${scopeQuery()}`),
    api<{ teams?: Team[] }>(`/api/admin/utb/teams?${scopeQuery()}`),
    api<{ allocations?: Allocation[] }>(`/api/admin/utb/allocations?${scopeQuery()}`),
  ]);
  if (appState.currentView !== "governance") return;
  if (p.status === "fulfilled") {
    people = orderPeople(p.value.people ?? []);
    peopleTotal = n(p.value.totalCostUsd);
    forbidden = false;
    stale = false;
  } else {
    forbidden = status(p.reason) === 403;
    if (forbidden) {
      people = null;
      stale = false;
    } else {
      stale = people !== null;
      if (!notice) {
        notice = {
          tone: "error",
          text: `Couldn't refresh the roster — ${errMessage(p.reason, "the server did not answer")}`,
          retry: () => void renderGovernance(),
        };
      }
    }
  }
  if (t.status === "fulfilled") teams = t.value.teams ?? [];
  else if (!forbidden) {
    stale = true;
    if (!notice) {
      notice = {
        tone: "error",
        text: `Couldn't refresh teams — ${errMessage(t.reason, "the server did not answer")}`,
        retry: () => void renderGovernance(),
      };
    }
  }
  if (a.status === "fulfilled") allocations = a.value.allocations ?? [];
  else if (!forbidden) {
    stale = true;
    if (!notice) {
      notice = {
        tone: "error",
        text: `Couldn't refresh budgets — ${errMessage(a.reason, "the server did not answer")}`,
        retry: () => void renderGovernance(),
      };
    }
  }
  if (openPerson) await loadDetail(openPerson, true);
  else draw();
}

async function loadDetail(principalId: string, quiet = false): Promise<void> {
  detailLoading = !quiet;
  if (!quiet) draw();
  try {
    const [d, r] = await Promise.all([
      api<PersonDetail>(`/api/admin/utb/people/${encodeURIComponent(principalId)}?${scopeQuery()}`),
      loadReceipts({ principalId, limit: 5 }).catch(() => [] as ReceiptRow[]),
    ]);
    if (openPerson !== principalId) return;
    detail = d;
    detailReceipts = r;
  } catch (e) {
    if (openPerson !== principalId) return;
    detail = null;
    notice = {
      tone: "error",
      text: `Couldn't open ${principalId} — ${errMessage(e, "the server did not answer")}`,
      retry: () => void loadDetail(principalId),
    };
  }
  detailLoading = false;
  draw();
}

function togglePerson(principalId: string): void {
  if (openPerson === principalId) {
    openPerson = null;
    detail = null;
    detailReceipts = null;
    draw();
    return;
  }
  openPerson = principalId;
  detail = null;
  detailReceipts = null;
  void loadDetail(principalId);
}

function teamMembers(teamId: string): string[] {
  return (people ?? []).filter((p) => p.teamId === teamId).map((p) => p.principalId);
}

function livePerson(principalId: string): Person | null {
  return (people ?? []).find((p) => p.principalId === principalId) ?? null;
}

function nameOf(person: Person): string {
  return person.displayName ?? person.principalId;
}

async function assignTeam(person: Person, teamId: string): Promise<void> {
  const from = person.teamId ?? "";
  if (from === teamId) return;
  const fromName = person.teamName ?? null;
  const who = nameOf(person);
  const target = teamId ? (teams ?? []).find((t) => t.id === teamId) : null;
  if (teamId && !target) return;
  const key = `person:${person.principalId}`;
  const path = teamId
    ? `/api/admin/utb/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(person.principalId)}?${scopeQuery()}`
    : `/api/admin/utb/teams/${encodeURIComponent(from)}/members/${encodeURIComponent(person.principalId)}?${scopeQuery()}`;
  await mutate({
    key,
    label: teamId ? `Couldn't move ${who} to ${target?.name ?? teamId}` : `Couldn't unassign ${who}`,
    done: teamId ? `${who} moved to ${target?.name ?? teamId}` : `${who} unassigned`,
    goneText: teamId ? undefined : `${who} was already off that team.`,
    apply: () => {
      const row = livePerson(person.principalId);
      if (!row) return;
      row.teamId = teamId || null;
      row.teamName = target?.name ?? null;
    },
    rollback: () => {
      const row = livePerson(person.principalId);
      if (!row) return;
      row.teamId = from || null;
      row.teamName = fromName;
    },
    run: () => api(path, { method: teamId ? "PUT" : "DELETE" }).then(() => undefined),
    sync: () => {
      void syncPeople();
      void syncDetail();
    },
  });
}

async function toggleAdmin(person: Person): Promise<void> {
  const key = `person:${person.principalId}`;
  const who = nameOf(person);
  const was = person.isAdmin === true;
  const wasRole = person.adminRole ?? null;
  await mutate({
    key,
    label: was ? `Couldn't revoke admin for ${who}` : `Couldn't grant admin to ${who}`,
    done: was ? `${who} is no longer an admin` : `${who} is now an org admin`,
    goneText: was ? `${who} was already not an admin.` : undefined,
    apply: () => {
      const row = livePerson(person.principalId);
      if (!row) return;
      row.isAdmin = !was;
      row.adminRole = was ? null : "org_admin";
    },
    rollback: () => {
      const row = livePerson(person.principalId);
      if (!row) return;
      row.isAdmin = was;
      row.adminRole = wasRole;
    },
    run: () =>
      was
        ? api(`/api/admin/grants/${encodeURIComponent(person.principalId)}?${scopeQuery()}&role=org_admin`, {
            method: "DELETE",
          }).then(() => undefined)
        : api(`/api/admin/grants?${scopeQuery()}`, {
            method: "POST",
            body: JSON.stringify({ principalId: person.principalId, role: "org_admin", scopeId: orgScope() }),
          }).then(() => undefined),
    sync: () => {
      void syncPeople();
      void syncDetail();
    },
  });
}

function openPersonForm(prefill?: Partial<PersonDraft>): void {
  personFormOpen = true;
  personDraft = { ...emptyPersonDraft(), ...prefill };
  trouble.delete("person:new");
  draw();
  focusByKey(prefill?.principalId ? "person-new-name" : "person-new-id");
}

function closePersonForm(): void {
  personFormOpen = false;
  personDraft = emptyPersonDraft();
  trouble.delete("person:new");
  draw();
  focusByKey("person-add-trigger");
}

function personPayload(draft: PersonDraft): Record<string, unknown> {
  const amount = Number(draft.amount);
  const win = WINDOWS.find((w) => w.key === draft.window) ?? WINDOWS[0]!;
  return {
    principalId: personKey(draft.principalId.trim()),
    displayName: draft.displayName.trim() || personKey(draft.principalId.trim()),
    ...(draft.teamId ? { teamId: draft.teamId } : {}),
    ...(draft.isAdmin ? { isAdmin: true } : {}),
    ...(draft.amount.trim() && Number.isFinite(amount) && amount > 0
      ? { budget: { limitUsd: amount, windowMs: win.ms, hard: draft.hard } }
      : {}),
  };
}

async function addPerson(draft: PersonDraft): Promise<void> {
  const principalId = personKey(draft.principalId.trim());
  if (!principalId || /\s/.test(principalId) || !/^[a-zA-Z0-9][a-zA-Z0-9._@+-]*$/.test(principalId)) {
    trouble.set("person:new", {
      tone: "error",
      text: "A principal id is required — an email, or letters, digits, dot, dash, underscore, plus or at, no spaces.",
      retry: null,
      discard: null,
    });
    draw();
    focusByKey("person-new-id");
    return;
  }
  if ((people ?? []).some((p) => personKey(p.principalId) === principalId && p.status !== "former")) {
    trouble.set("person:new", {
      tone: "error",
      text: `${principalId} is already on the roster.`,
      retry: null,
      discard: null,
    });
    draw();
    focusByKey("person-new-id");
    return;
  }
  const amount = Number(draft.amount);
  if (draft.amount.trim() && (!Number.isFinite(amount) || amount <= 0)) {
    trouble.set("person:new", {
      tone: "error",
      text: "A starting budget has to be above zero — or leave it empty.",
      retry: null,
      discard: null,
    });
    draw();
    return;
  }
  const team = draft.teamId ? (teams ?? []).find((t) => t.id === draft.teamId) : null;
  const optimistic: Person = {
    principalId,
    displayName: draft.displayName.trim() || principalId,
    teamId: draft.teamId || null,
    teamName: team?.name ?? null,
    isAdmin: draft.isAdmin,
    adminRole: draft.isAdmin ? "org_admin" : null,
    calls: 0,
    totalTokens: 0,
    costUsd: 0,
    lastActiveAt: null,
    hasOwnAllocation: draft.amount.trim() !== "",
    unsaved: true,
  };
  const key = `person:${principalId}`;
  personFormOpen = false;
  personDraft = emptyPersonDraft();
  await mutate({
    key,
    label: `Couldn't add ${principalId}`,
    done: `${optimistic.displayName} added to the roster`,
    apply: () => {
      if (!pinned.includes(principalId)) pinned = [principalId, ...pinned];
      people = [optimistic, ...(people ?? []).filter((p) => p.principalId !== principalId)];
      focusByKey(`row:${principalId}`);
    },
    rollback: () => {
      const row = livePerson(principalId);
      if (row) row.unsaved = true;
    },
    discard: () => {
      pinned = pinned.filter((id) => id !== principalId);
      people = (people ?? []).filter((p) => p.principalId !== principalId);
      trouble.delete(key);
      personFormOpen = true;
      personDraft = { ...draft };
      draw();
      focusByKey("person-new-id");
    },
    run: async () => {
      const r = await api<{ person?: Person }>(`/api/admin/utb/people?${scopeQuery()}`, {
        method: "POST",
        body: JSON.stringify(personPayload(draft)),
      });
      const server = r.person;
      people = (people ?? []).map((p) => (p.principalId === principalId ? { ...(server ?? p), unsaved: false } : p));
      focusByKey(`row:${principalId}`);
    },
    sync: () => {
      if (draft.amount.trim()) void syncAllocations();
      void syncPeople();
    },
  });
}

async function removePerson(person: Person): Promise<void> {
  confirmPerson = "";
  const principalId = person.principalId;
  const key = `person:${principalId}`;
  const who = nameOf(person);
  const index = (people ?? []).findIndex((p) => p.principalId === principalId);
  const snapshot = { ...person };
  const heldAllocs = (allocations ?? []).filter((a) => String(a.subject ?? "") === `principal:${principalId}`);
  await mutate({
    key,
    label: `Couldn't remove ${who}`,
    done: `${who} removed from the roster`,
    goneText: `${who} was already gone.`,
    apply: () => {
      pinned = pinned.filter((id) => id !== principalId);
      people = (people ?? []).map((p) =>
        p.principalId === principalId
          ? {
              ...p,
              status: "former",
              teamId: null,
              teamName: null,
              isAdmin: false,
              adminRole: null,
              hasOwnAllocation: false,
            }
          : p,
      );
      allocations = (allocations ?? []).filter((a) => String(a.subject ?? "") !== `principal:${principalId}`);
      if (openPerson === principalId) {
        openPerson = null;
        detail = null;
      }
      focusByKey(`row:${principalId}`);
    },
    rollback: () => {
      const rows = (people ?? []).filter((p) => p.principalId !== principalId);
      rows.splice(Math.max(0, index), 0, snapshot);
      people = rows;
      allocations = [...(allocations ?? []), ...heldAllocs];
    },
    run: () =>
      api(`/api/admin/utb/people/${encodeURIComponent(principalId)}?${scopeQuery()}`, { method: "DELETE" }).then(
        () => undefined,
      ),
    sync: () => {
      void syncPeople();
      void syncAllocations();
    },
  });
}

function openTeamForm(team: Team | null): void {
  teamFormOpen = true;
  teamDraft = team
    ? {
        id: team.id,
        name: team.name,
        parentId: team.parentId ?? "",
        membersVersion: team.membersVersion ?? "",
        editing: true,
      }
    : { id: "", name: "", parentId: "", membersVersion: "", editing: false };
  draw();
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(".gov-team-form")?.scrollIntoView({ block: "nearest" });
    document.querySelector<HTMLInputElement>(teamDraft.editing ? ".gov-team-name" : ".gov-team-id")?.focus();
  });
}

function closeTeamForm(): void {
  teamFormOpen = false;
  teamDraft = { id: "", name: "", parentId: "", membersVersion: "", editing: false };
  trouble.delete("team:form");
  draw();
  focusByKey("team-add-trigger");
}

async function saveTeam(): Promise<void> {
  const id = teamDraft.id.trim();
  const name = teamDraft.name.trim() || id;
  const parentId = teamDraft.parentId.trim() || null;
  const editing = teamDraft.editing;
  if (!id) {
    trouble.set("team:form", { tone: "error", text: "A team needs an id.", retry: null, discard: null });
    draw();
    return;
  }
  const clash = editing ? null : ((teams ?? []).find((t) => t.id === id) ?? null);
  if (clash) {
    trouble.set("team:form", {
      tone: "error",
      text: `A team ${id} already exists — edit it instead.`,
      retry: () => openTeamForm(clash),
      discard: null,
    });
    draw();
    return;
  }
  const ifMatch = editing ? teamDraft.membersVersion : "";
  const before = [...(teams ?? [])];
  const ok = await mutate({
    key: "team:form",
    label: `Couldn't ${editing ? "save" : "create"} team ${id}`,
    done: `Team ${name} ${editing ? "saved" : "created"}`,
    apply: () => {
      const rows = [...(teams ?? [])];
      const at = rows.findIndex((t) => t.id === id);
      const next: Team = { ...(at >= 0 ? rows[at]! : {}), id, name, parentId };
      if (at >= 0) rows[at] = next;
      else rows.push(next);
      teams = rows;
      for (const p of people ?? []) if (p.teamId === id) p.teamName = name;
    },
    rollback: () => {
      teams = before;
      for (const p of people ?? [])
        if (p.teamId === id) p.teamName = before.find((t) => t.id === id)?.name ?? p.teamName;
    },
    run: () =>
      api(`/api/admin/utb/teams?${scopeQuery()}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(ifMatch ? { "if-match": ifMatch } : {}) },
        body: JSON.stringify({ id, name, parentId }),
      }).then(() => undefined),
    sync: () => void syncTeams(),
  });
  if (!ok) return;
  teamDraft = { id: "", name: "", parentId: "", membersVersion: "", editing: false };
  teamFormOpen = false;
  draw();
  focusByKey("team-add-trigger");
}

async function deleteTeam(id: string): Promise<void> {
  confirmTeam = "";
  const before = [...(teams ?? [])];
  const gone = before.find((t) => t.id === id) ?? null;
  const heldAllocs = (allocations ?? []).filter((a) => String(a.subject ?? "") === `team:${id}`);
  const heldMembers = (people ?? []).filter((p) => p.teamId === id).map((p) => p.principalId);
  await mutate({
    key: `team:${id}`,
    label: `Couldn't delete team ${id}`,
    done: `Team ${gone?.name ?? id} deleted`,
    goneText: `Team ${id} was already gone.`,
    apply: () => {
      teams = (teams ?? [])
        .filter((t) => t.id !== id)
        .map((t) => (t.parentId === id ? { ...t, parentId: gone?.parentId ?? null } : t));
      allocations = (allocations ?? []).filter((a) => String(a.subject ?? "") !== `team:${id}`);
      for (const p of people ?? []) {
        if (p.teamId !== id) continue;
        p.teamId = null;
        p.teamName = null;
      }
    },
    rollback: () => {
      teams = before;
      allocations = [...(allocations ?? []), ...heldAllocs];
      for (const p of people ?? []) {
        if (!heldMembers.includes(p.principalId)) continue;
        p.teamId = id;
        p.teamName = gone?.name ?? id;
      }
    },
    run: () =>
      api(`/api/admin/utb/teams/${encodeURIComponent(id)}?${scopeQuery()}`, { method: "DELETE" }).then(() => undefined),
    sync: () => {
      void syncTeams();
      void syncPeople();
      void syncAllocations();
    },
  });
}

function openTeamConfirm(id: string): void {
  confirmTeam = id;
  draw();
  focusByKey(`team-keep:${id}`);
}

function closeTeamConfirm(id: string): void {
  confirmTeam = "";
  draw();
  focusByKey(`team-kill:${id}`);
}

function capLine(alloc: Allocation): string {
  return `${money(n(alloc.limitUsd))} ${windowLabel(n(alloc.windowMs) || 86_400_000)}`;
}

function teamConsequences(team: Team, memberCount: number, spend: number): string[] {
  const caps = (allocations ?? []).filter((a) => String(a.subject ?? "") === `team:${team.id}`);
  const children = (teams ?? []).filter((t) => t.parentId === team.id);
  const parent = team.parentId ? ((teams ?? []).find((t) => t.id === team.parentId)?.name ?? team.parentId) : "";
  return [
    memberCount
      ? `Unassigns ${memberCount} ${memberCount === 1 ? "member" : "members"} — they keep their access and personal budgets.`
      : "Nobody is in this team, so no one loses a team.",
    ...caps.map((a) => `Deletes this team's ${capLine(a)} cap.`),
    ...(children.length
      ? [
          `Moves ${children.length} child ${children.length === 1 ? "team" : "teams"} up to ${parent || "the top level"}.`,
        ]
      : []),
    `Keeps the ${money(spend)} already spent in the org total — it stops counting against any team cap.`,
  ];
}

function teamConfirm(team: Team, memberCount: number, spend: number): TemplateResult {
  return html`<div
    class="gov-confirm gov-confirm-pop gov-confirm-inline"
    role="alertdialog"
    aria-label=${`Delete team ${team.name}`}
    @keydown=${(e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeTeamConfirm(team.id);
    }}
  >
    <strong class="gov-confirm-title">Delete ${team.name}?</strong>
    <ul class="gov-confirm-list">
      ${teamConsequences(team, memberCount, spend).map((line) => html`<li>${line}</li>`)}
    </ul>
    <div class="gov-confirm-actions">
      <button
        class="gov-ghost tiny"
        type="button"
        data-focus-key=${`team-keep:${team.id}`}
        @click=${() => closeTeamConfirm(team.id)}
      >
        Keep
      </button>
      <button
        class="gov-danger"
        type="button"
        aria-label=${`Delete team ${team.name}`}
        @click=${() => void deleteTeam(team.id)}
      >
        Delete
      </button>
    </div>
  </div>`;
}

function allocConfirm(alloc: Allocation): TemplateResult {
  const id = String(alloc.id ?? "");
  const who = label(String(alloc.subject ?? "")).name;
  return html`<div
    class="gov-confirm gov-confirm-pop gov-confirm-inline"
    role="alertdialog"
    aria-label=${`Remove the budget on ${who}`}
    @keydown=${(e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeAllocConfirm(id);
    }}
  >
    <strong class="gov-confirm-title">Remove this cap?</strong>
    <ul class="gov-confirm-list">
      ${allocConsequences(alloc).map((line) => html`<li>${line}</li>`)}
    </ul>
    <div class="gov-confirm-actions">
      <button
        class="gov-ghost tiny"
        type="button"
        data-focus-key=${`alloc-keep:${id}`}
        @click=${() => closeAllocConfirm(id)}
      >
        Keep
      </button>
      <button
        class="gov-danger"
        type="button"
        aria-label=${`Remove the budget on ${who}`}
        @click=${() => void deleteAlloc(id)}
      >
        Delete
      </button>
    </div>
  </div>`;
}

function openAllocConfirm(id: string): void {
  confirmAlloc = id;
  draw();
  focusByKey(`alloc-keep:${id}`);
}

function closeAllocConfirm(id: string): void {
  confirmAlloc = "";
  draw();
  focusByKey(`alloc-kill:${id}`);
}

function allocConsequences(alloc: Allocation): string[] {
  const subject = String(alloc.subject ?? "");
  const who = label(subject).name;
  const spent = alloc.spentUsd == null ? null : n(alloc.spentUsd);
  return [
    `Lifts the ${capLine(alloc)} ${alloc.hard ? "hard" : "soft"} cap on ${who}.`,
    alloc.hard
      ? `${who} stops being refused at the cap — turns run until a wider budget refuses them.`
      : `${who} stops being warned at the cap.`,
    ...(spent === null ? [] : [`Keeps the ${money(spent)} already spent — this removes the limit, not the history.`]),
  ];
}

function allocFor(subject: string, windowMs?: number): Allocation | null {
  const rows = (allocations ?? []).filter((a) => String(a.subject ?? "") === subject);
  const match = windowMs === undefined ? rows[0] : rows.find((a) => (n(a.windowMs) || 86_400_000) === windowMs);
  return match ?? null;
}

function draftAllocationId(subject: string, key: string): string {
  return `${subject.replace(/[^a-zA-Z0-9]+/g, "-")}-${key}`.replace(/-+/g, "-").toLowerCase();
}

function openAllocForm(subject: string, amount = ""): void {
  allocFormOpen = true;
  allocDraft = {
    id: "",
    subject,
    amount,
    window: subject.startsWith("principal:") ? "day" : "month",
    hard: true,
    editing: false,
  };
  draw();
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(".gov-alloc-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    document.querySelector<HTMLInputElement>(".gov-alloc-amount")?.focus();
  });
}

function editAlloc(a: Allocation): void {
  allocFormOpen = true;
  allocDraft = {
    id: String(a.id ?? ""),
    subject: String(a.subject ?? "org"),
    amount: String(n(a.limitUsd)),
    window: windowKey(n(a.windowMs) || 86_400_000),
    hard: a.hard === true,
    editing: true,
  };
  draw();
}

function closeAllocForm(): void {
  allocFormOpen = false;
  allocDraft = { id: "", subject: "org", amount: "", window: "month", hard: true, editing: false };
  trouble.delete("alloc:form");
  draw();
  focusByKey("alloc-add-trigger");
}

function markOwnAllocation(subject: string, held: boolean): void {
  if (!subject.startsWith("principal:")) return;
  const row = livePerson(subject.slice("principal:".length));
  if (row) row.hasOwnAllocation = held;
}

async function saveAlloc(): Promise<void> {
  const limitUsd = Number(allocDraft.amount);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    trouble.set("alloc:form", { tone: "error", text: "Enter a budget above zero.", retry: null, discard: null });
    draw();
    return;
  }
  const win = WINDOWS.find((w) => w.key === allocDraft.window) ?? WINDOWS[2]!;
  const subject = allocDraft.subject;
  const hard = allocDraft.hard;
  const existing = allocDraft.editing ? null : allocFor(subject, win.ms);
  const id = allocDraft.id || existing?.id || draftAllocationId(subject, win.key);
  const before = [...(allocations ?? [])];
  const heldOwn = (people ?? []).find((p) => `principal:${p.principalId}` === subject)?.hasOwnAllocation === true;
  const ok = await mutate({
    key: "alloc:form",
    label: `Couldn't save the budget for ${label(subject).name}`,
    done: `Budget for ${label(subject).name} saved`,
    apply: () => {
      const rows = [...(allocations ?? [])];
      const at = rows.findIndex((a) => a.id === id);
      const prior = at >= 0 ? rows[at]! : null;
      const next: Allocation = {
        ...(prior ?? {}),
        id,
        subject,
        limitUsd,
        windowMs: win.ms,
        hard,
        spentUsd: prior?.spentUsd ?? null,
      };
      if (at >= 0) rows[at] = next;
      else rows.push(next);
      allocations = rows;
      markOwnAllocation(subject, true);
    },
    rollback: () => {
      allocations = before;
      markOwnAllocation(subject, heldOwn);
    },
    run: () =>
      api(`/api/admin/utb/allocations?${scopeQuery()}`, {
        method: "PUT",
        body: JSON.stringify({ id, subject, limitUsd, windowMs: win.ms, hard }),
      }).then(() => undefined),
    sync: () => {
      void syncAllocations();
      void syncPeople();
      void syncDetail();
    },
  });
  if (!ok) return;
  allocFormOpen = false;
  allocDraft = { id: "", subject: "org", amount: "", window: "month", hard: true, editing: false };
  draw();
  focusByKey("alloc-add-trigger");
}

async function deleteAlloc(id: string): Promise<void> {
  confirmAlloc = "";
  const before = [...(allocations ?? [])];
  const gone = before.find((a) => a.id === id) ?? null;
  const subject = String(gone?.subject ?? "");
  await mutate({
    key: `alloc:${id}`,
    label: `Couldn't delete budget ${id}`,
    done: `Budget for ${label(subject).name} removed`,
    goneText: `Budget ${id} was already gone.`,
    apply: () => {
      allocations = (allocations ?? []).filter((a) => a.id !== id);
      if (!(allocations ?? []).some((a) => String(a.subject ?? "") === subject)) markOwnAllocation(subject, false);
    },
    rollback: () => {
      allocations = before;
      markOwnAllocation(subject, true);
    },
    run: () =>
      api(`/api/admin/utb/allocations/${encodeURIComponent(id)}?${scopeQuery()}`, { method: "DELETE" }).then(
        () => undefined,
      ),
    sync: () => {
      void syncAllocations();
      void syncPeople();
      void syncDetail();
    },
  });
}

function breakdownList(rows: BreakdownRow[], title: string): TemplateResult {
  const top = [...rows].sort((a, b) => n(b.costUsd) - n(a.costUsd)).slice(0, 6);
  const max = Math.max(...top.map((r) => n(r.costUsd)), 0.000001);
  return html`<div class="gov-break">
    <div class="gov-break-title">${title}</div>
    ${
      top.length
        ? top.map(
            (r) =>
              html`<div class="gov-break-row">
                <span class="gov-break-key" title=${r.key}>${r.key}</span>
                ${meter(n(r.costUsd) / max, "wide")}
                <span class="gov-break-cost">${moneyTight(r.costUsd)}</span>
              </div>`,
          )
        : html`<div class="gov-break-none">No spend recorded.</div>`
    }
  </div>`;
}

function outcomeMix(d: PersonDetail): TemplateResult {
  const by = d.outcomes?.byOutcome ?? {};
  const entries = Object.entries(by).filter(([, v]) => n(v) > 0);
  const total = entries.reduce((a, [, v]) => a + n(v), 0) || 1;
  return html`<div class="gov-break gov-outcomes">
    <div class="gov-break-title">Outcome mix</div>
    ${
      entries.length
        ? html`
            <div class="usage-phase-bar">
              ${entries.map(
                ([k, v], i) =>
                  html`<span
                    class=${`usage-seg-${Math.min(i, 5)}`}
                    style=${`flex:${((n(v) / total) * 100).toFixed(2)} 1 0%`}
                    title=${`${k} · ${v}`}
                  ></span>`,
              )}
            </div>
            <div class="usage-phase-legend">
              ${entries.map(
                ([k, v], i) =>
                  html`<span class="usage-phase-item"
                    ><i class=${`usage-seg-${Math.min(i, 5)}`}></i>${k}<b>${v}</b></span
                  >`,
              )}
            </div>
            <div class="gov-outcome-foot">
              ${fmtCalls(d.outcomes?.runs)} runs · ${fmtCalls(d.outcomes?.produced)} produced ·
              <b>${d.outcomes?.costPerOutcomeUsd == null ? "—" : money(d.outcomes.costPerOutcomeUsd)}</b> per outcome
              <span class="gov-basis">run cost</span>
              ${
                d.outcomes?.ledgerCostPerOutcomeUsd == null
                  ? nothing
                  : html`· ${money(d.outcomes.ledgerCostPerOutcomeUsd)} per outcome
                      <span class="gov-basis">ledger cost</span>`
              }
            </div>
          `
        : html`<div class="gov-break-none">No runs closed out yet.</div>`
    }
  </div>`;
}

function timeToExhaustionMs(a: Allocation): number {
  const limit = n(a.limitUsd);
  const spent = a.spentUsd == null ? null : n(a.spentUsd);
  if (spent === null || !(limit > 0)) return Number.POSITIVE_INFINITY;
  if (a.exceeded === true || spent >= limit) return 0;
  const burnPerMs = spent / (n(a.windowMs) || 86_400_000);
  if (!(burnPerMs > 0)) return Number.POSITIVE_INFINITY;
  return (limit - spent) / burnPerMs;
}

function budgetStack(rows: Allocation[]): TemplateResult {
  if (!rows.length) {
    return html`<div class="gov-break-none gov-nobudget">No budget governs this person — spend is uncapped.</div>`;
  }
  const hard = [...rows.filter((a) => a.hard === true)].sort((a, b) => {
    const x = timeToExhaustionMs(a);
    const y = timeToExhaustionMs(b);
    return x === y ? 0 : x < y ? -1 : 1;
  });
  const soft = rows.filter((a) => a.hard !== true);
  const first = hard[0] ?? null;
  const binding =
    first && (hard.length === 1 || timeToExhaustionMs(first) < timeToExhaustionMs(hard[1]!)) ? first : null;
  return html`
    ${
      hard.length
        ? nothing
        : html`<div class="gov-nohard">No hard cap governs this person — nothing below can refuse a turn.</div>`
    }
    <div class="gov-stack">
      ${[...hard, ...soft].map((a) => {
        const limit = n(a.limitUsd);
        const spent = a.spentUsd == null ? null : n(a.spentUsd);
        const used = spent !== null && limit > 0 ? Math.min(1, spent / limit) : 0;
        const over = a.exceeded === true || (spent !== null && limit > 0 && spent >= limit);
        const level = meterLevel(over, used);
        const isBinding = binding !== null && a.id === binding.id;
        const window = windowLabel(n(a.windowMs) || 86_400_000);
        const remaining = a.remainingUsd == null ? limit : n(a.remainingUsd);
        const remainingText = remaining < 0 ? `over by ${money(-remaining)}` : `${money(remaining)} left`;
        return html`<div class=${`gov-stack-row ${level} ${a.hard ? "" : "is-soft"} ${isBinding ? "is-binding" : ""}`}>
          <div class="gov-stack-head">
            <span class="gov-stack-kind ${a.kind ?? ""}">${subjectKind(String(a.subject ?? ""))}</span>
            <span class="gov-stack-name">${subjectCell(String(a.subject ?? ""))}</span>
            <span class="usage-alloc-kind ${a.hard ? "hard" : ""}">${a.hard ? "HARD" : "SOFT"}</span>
            <span class="gov-stack-amounts">
              ${spent === null ? "—" : money(spent)} <span class="usage-alloc-of">of</span> ${money(limit)}
              <span class="usage-alloc-window">${window}</span>
            </span>
          </div>
          ${meter(used, level)}
          <div class="gov-stack-foot">
            ${
              over
                ? html`<b class="gov-over">Refused at this cap</b>`
                : html`${a.remainingUsd == null ? "" : remainingText}`
            }
            ${spent === null ? nothing : html`<span>${pct(used)} used</span>`}
            ${
              isBinding
                ? html`<span class="gov-binding-badge"
                    >refuses first — ${remainingText} of ${money(limit)} ${window}</span
                  >`
                : nothing
            }
            ${a.hard ? nothing : html`<span class="gov-soft-badge">warn only, never refuses</span>`}
          </div>
        </div>`;
      })}
    </div>
  `;
}

function drillDown(person: Person): TemplateResult {
  if (detailLoading || !detail) {
    return html`<div class="gov-drill"><div class="gov-drill-loading">Reading the ledger…</div></div>`;
  }
  const t = detail.totals ?? {};
  const b = detail.breakdowns ?? {};
  const own = (detail.allocations ?? []).find((a) => a.kind === "principal") ?? null;
  return html`<div class="gov-drill">
    <div class="gov-drill-top">
      <div class="gov-drill-title">
        <span>${detail.displayName ?? person.principalId}</span>
        <em>${detail.teamAncestry?.length ? detail.teamAncestry.map((x) => x.name ?? x.id).join(" ← ") : "No team"}</em>
      </div>
      <button
        class="gov-ghost"
        type="button"
        @click=${(e: Event) => {
          e.stopPropagation();
          togglePerson(person.principalId);
        }}
      >
        ${icon(X, 14)}<span>Close</span>
      </button>
    </div>
    <div class="gov-drill-stats">
      ${tile("Spend · 30d", money(t.costUsd))} ${tile("Tokens", fmtTokens(t.totalTokens))}
      ${tile("Calls", fmtCalls(t.calls))} ${tile("$ / Mtok", money(t.effectiveUsdPerMtok))}
    </div>
    <div class="gov-drill-section">
      <div class="gov-drill-kicker">Budgets governing this person</div>
      ${budgetStack(detail.allocations ?? [])}
      ${
        own
          ? html`<button
              class="gov-ghost gov-inline-add"
              type="button"
              @click=${(e: Event) => {
                e.stopPropagation();
                editAlloc(own);
                document.querySelector<HTMLElement>(".gov-alloc-form")?.scrollIntoView({ block: "center" });
              }}
            >
              ${icon(Pencil, 14)}<span>Edit personal budget</span>
            </button>`
          : html`<button
              class="gov-ghost gov-inline-add"
              type="button"
              @click=${(e: Event) => {
                e.stopPropagation();
                openAllocForm(`principal:${person.principalId}`);
              }}
            >
              ${icon(Plus, 14)}<span>Personal budget</span>
            </button>`
      }
    </div>
    <div class="gov-drill-section">
      <div class="gov-drill-kicker">Recent receipts</div>
      ${receiptList(detailReceipts ?? [], { showWho: false })}
    </div>
    <div class="gov-drill-section">
      <div class="gov-drill-kicker">Where the spend went</div>
      <div class="gov-break-grid">
        ${breakdownList(b.byModel ?? [], "By model")} ${breakdownList(b.byHarness ?? [], "By harness")}
        ${breakdownList(b.byPhase ?? [], "By phase")} ${breakdownList(b.bySource ?? [], "By source")}
      </div>
      ${outcomeMix(detail)}
    </div>
  </div>`;
}

function troubleStrip(key: string, cls = ""): TemplateResult | typeof nothing {
  const t = trouble.get(key);
  if (!t) return nothing;
  return html`<div class=${`gov-trouble ${t.tone} ${cls}`} role="alert">
    ${t.tone === "error" ? icon(AlertTriangle, 13) : nothing}
    <span class="gov-trouble-text">${t.text}</span>
    ${
      t.retry
        ? html`<button class="gov-ghost tiny" type="button" ?disabled=${busy(key)} @click=${() => t.retry?.()}>
            ${icon(RefreshCw, 12)}<span>Retry</span>
          </button>`
        : nothing
    }
    ${t.discard ? html`<button class="gov-ghost tiny" type="button" @click=${() => t.discard?.()}>Discard</button>` : nothing}
    <button
      class="gov-ghost tiny gov-icon-only"
      type="button"
      aria-label="Dismiss this message"
      @click=${() => clearTrouble(key)}
    >
      ${icon(X, 12)}
    </button>
  </div>`;
}

function personForm(): TemplateResult {
  const submit = (): void => void addPerson({ ...personDraft });
  return html`<div
    class="gov-form gov-person-form"
    @keydown=${(e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePersonForm();
        return;
      }
      if (e.key !== "Enter") return;
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      e.preventDefault();
      submit();
    }}
  >
    <input
      class="gov-input gov-person-id"
      data-focus-key="person-new-id"
      placeholder="principal-id or email"
      aria-label="Principal id"
      .value=${personDraft.principalId}
      @input=${(e: Event) => (personDraft.principalId = (e.target as HTMLInputElement).value)}
    />
    <input
      class="gov-input gov-person-name"
      data-focus-key="person-new-name"
      placeholder="Display name"
      aria-label="Display name"
      .value=${personDraft.displayName}
      @input=${(e: Event) => (personDraft.displayName = (e.target as HTMLInputElement).value)}
    />
    <select
      class="gov-select"
      data-focus-key="person-new-team"
      aria-label="Team"
      .value=${personDraft.teamId}
      @change=${(e: Event) => (personDraft.teamId = (e.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${!personDraft.teamId}>No team</option>
      ${(teams ?? []).map((t) => html`<option value=${t.id} ?selected=${t.id === personDraft.teamId}>${t.name}</option>`)}
    </select>
    <button
      class=${`web-only-toggle gov-switch labeled ${personDraft.isAdmin ? "on" : ""}`}
      type="button"
      role="switch"
      data-focus-key="person-new-admin"
      aria-checked=${personDraft.isAdmin ? "true" : "false"}
      aria-label="Grant org admin"
      title=${personDraft.isAdmin ? "Grants an org_admin role" : "No admin grant"}
      @click=${() => {
        personDraft.isAdmin = !personDraft.isAdmin;
        draw();
      }}
    >
      <span>Admin</span><span class="mini-switch"><span class="mini-knob"></span></span>
    </button>
    <label class="gov-amount">
      <span>$</span>
      <input
        class="gov-input gov-person-amount"
        data-focus-key="person-new-amount"
        type="number"
        min="1"
        step="1"
        placeholder="budget"
        aria-label="Starting budget"
        .value=${personDraft.amount}
        @input=${(e: Event) => (personDraft.amount = (e.target as HTMLInputElement).value)}
      />
    </label>
    <select
      class="gov-select"
      data-focus-key="person-new-window"
      aria-label="Budget window"
      .value=${personDraft.window}
      @change=${(e: Event) => (personDraft.window = (e.target as HTMLSelectElement).value)}
    >
      ${WINDOWS.map((w) => html`<option value=${w.key} ?selected=${w.key === personDraft.window}>${w.label}</option>`)}
    </select>
    <button
      class=${`web-only-toggle gov-switch labeled ${personDraft.hard ? "on" : ""}`}
      type="button"
      role="switch"
      data-focus-key="person-new-hard"
      aria-checked=${personDraft.hard ? "true" : "false"}
      aria-label=${personDraft.hard ? "Hard budget" : "Soft budget"}
      title=${personDraft.hard ? "Hard: refuse the turn at the cap" : "Soft: warn but allow"}
      @click=${() => {
        personDraft.hard = !personDraft.hard;
        draw();
      }}
    >
      <span>${personDraft.hard ? "Hard" : "Soft"}</span><span class="mini-switch"><span class="mini-knob"></span></span>
    </button>
    <button class="gov-primary gov-person-save" type="button" ?disabled=${busy("person:new")} @click=${submit}>
      Add person
    </button>
    <button class="gov-ghost tiny" type="button" @click=${() => closePersonForm()}>Cancel</button>
  </div>`;
}

const ROW_CONTROLS = "button, select, input, textarea, a, label, .gov-confirm";

function budgetCell(person: Person, who: string, former: boolean): TemplateResult {
  if (former) return html`<span class="gov-dim">—</span>`;
  if (person.hasOwnAllocation) return html`<span class="gov-chip on">Own cap</span>`;
  return html`<button
    class="gov-ghost tiny"
    type="button"
    title=${`Set a personal budget for ${who}`}
    @click=${() => openAllocForm(`principal:${person.principalId}`)}
  >
    ${icon(Plus, 13)}<span>Budget</span>
  </button>`;
}

function openRemoveConfirm(person: Person): void {
  confirmPerson = person.principalId;
  draw();
  focusByKey(`confirm-keep:${person.principalId}`);
}

function closeRemoveConfirm(person: Person): void {
  confirmPerson = "";
  draw();
  focusByKey(`kill-of:${person.principalId}`);
}

function removalConsequences(person: Person): string[] {
  const team = person.teamName ?? person.teamId ?? "";
  return [
    "Signs them out — no new turns, and their session capability stops issuing.",
    ...(person.isAdmin ? ["Revokes their org_admin grant."] : []),
    ...(person.hasOwnAllocation ? ["Deletes their personal budget."] : []),
    ...(team ? [`Removes them from ${team}, so their past spend stops counting against that team's cap.`] : []),
    "Keeps their spend in the org total — they move to Former members.",
  ];
}

function removeConfirm(person: Person, who: string): TemplateResult {
  return html`<div
    class="gov-confirm gov-confirm-pop"
    role="alertdialog"
    aria-label=${`Remove ${who} from the roster`}
    @keydown=${(e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRemoveConfirm(person);
    }}
  >
    <strong class="gov-confirm-title">Remove ${who}?</strong>
    <ul class="gov-confirm-list">
      ${removalConsequences(person).map((line) => html`<li>${line}</li>`)}
    </ul>
    <div class="gov-confirm-actions">
      <button
        class="gov-ghost tiny"
        type="button"
        data-focus-key=${`confirm-keep:${person.principalId}`}
        @click=${() => closeRemoveConfirm(person)}
      >
        Keep
      </button>
      <button
        class="gov-danger"
        type="button"
        data-focus-key=${`confirm-remove:${person.principalId}`}
        aria-label=${`Remove ${who} from the roster`}
        @click=${() => void removePerson(person)}
      >
        Remove
      </button>
    </div>
  </div>`;
}

function peopleTable(rows: Person[]): TemplateResult {
  const maxSpend = Math.max(...rows.map((p) => n(p.costUsd)), 0.000001);
  const self = appState.me?.user ?? "";
  return html`<div class="usage-table-scroll" data-scroll-key="roster">
    <table class="usage-table gov-table">
      <thead>
        <tr>
          <th>Person</th>
          <th class="gov-col-team">Team</th>
          <th class="gov-col-admin">Admin</th>
          <th>Spend · 30d</th>
          <th class="gov-col-calls">Calls</th>
          <th class="gov-col-budget">Budget</th>
          <th class="gov-col-active">Last active</th>
          <th class="gov-col-kill"></th>
          <th class="gov-col-chev"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((p) => {
          const open = openPerson === p.principalId;
          const isSelf = p.principalId === self;
          const key = `person:${p.principalId}`;
          const working = busy(key);
          const who = p.displayName ?? p.principalId;
          const former = p.status === "former";
          return html`
            <tr
              class=${`gov-row ${open ? "open" : ""} ${working ? "is-pending" : ""} ${p.unsaved ? "is-unsaved" : ""} ${former ? "is-former" : ""}`}
              tabindex="0"
              data-focus-key=${`row:${p.principalId}`}
              aria-busy=${working ? "true" : "false"}
              @click=${(e: Event) => {
                if ((e.target as HTMLElement)?.closest?.(ROW_CONTROLS)) return;
                togglePerson(p.principalId);
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  togglePerson(p.principalId);
                }
              }}
            >
              <td class="gov-person-cell">
                <span class="gov-person">
                  ${avatar(p.principalId, who)}
                  <span class="gov-person-text">
                    <span class="gov-person-name">
                      <b>${who}</b>
                      ${isSelf ? html`<span class="gov-you">you</span>` : nothing}
                      ${former ? html`<span class="gov-chip">former</span>` : nothing}
                      ${working ? html`<span class="gov-pending-dot" title="Saving…"></span>` : nothing}
                      ${!working && p.unsaved ? html`<span class="gov-chip warn">not saved</span>` : nothing}
                    </span>
                    <em>${p.principalId}</em>
                  </span>
                </span>
              </td>
              <td class="gov-col-team">
                ${
                  former
                    ? html`<span class="gov-dim">—</span>`
                    : html`<select
                        class="gov-select"
                        data-focus-key=${`team-of:${p.principalId}`}
                        aria-label=${`Team for ${who}`}
                        ?disabled=${working}
                        .value=${p.teamId ?? ""}
                        @change=${(e: Event) => void assignTeam(p, (e.target as HTMLSelectElement).value)}
                      >
                        <option value="">Unassigned</option>
                        ${(teams ?? []).map((t) => html`<option value=${t.id} ?selected=${t.id === p.teamId}>${t.name}</option>`)}
                        ${
                    p.teamId && !(teams ?? []).some((t) => t.id === p.teamId)
                      ? html`<option value=${p.teamId} selected>${p.teamName ?? p.teamId} (unknown)</option>`
                      : nothing
                  }
                      </select>`
                }
              </td>
              <td class="gov-col-admin">
                ${
                  former
                    ? html`<span class="gov-dim">—</span>`
                    : html`<button
                        class=${`web-only-toggle gov-switch ${p.isAdmin ? "on" : ""}`}
                        type="button"
                        role="switch"
                        data-focus-key=${`admin-of:${p.principalId}`}
                        aria-checked=${p.isAdmin ? "true" : "false"}
                        aria-label=${`Admin for ${who}`}
                        ?disabled=${working || (isSelf && p.isAdmin === true)}
                        title=${adminTitle(isSelf, p.isAdmin === true)}
                        @click=${() => void toggleAdmin(p)}
                      >
                        <span class="mini-switch"><span class="mini-knob"></span></span>
                      </button>`
                }
              </td>
              <td class="usage-cost gov-spend">
                <span class="gov-spend-inner">${meter(n(p.costUsd) / maxSpend, "inline")}${money(p.costUsd)}</span>
              </td>
              <td class="gov-col-calls">${fmtCalls(p.calls)}</td>
              <td class="gov-col-budget">${budgetCell(p, who, former)}</td>
              <td class="gov-dim gov-col-active">${p.lastActiveAt ? relTime(n(p.lastActiveAt)) : "never"}</td>
              <td class="gov-col-kill">
                ${
                  former
                    ? html`<button
                        class="gov-ghost tiny"
                        type="button"
                        data-focus-key=${`readd-of:${p.principalId}`}
                        title=${`Put ${who} back on the roster`}
                        aria-label=${`Re-add ${who}`}
                        ?disabled=${working}
                        @click=${() =>
                            openPersonForm({
                              principalId: p.principalId,
                              displayName: p.displayName ?? p.principalId,
                            })}
                      >
                        ${icon(Plus, 13)}<span>Re-add</span>
                      </button>`
                    : html`<button
                        class="gov-ghost tiny gov-icon-only"
                        type="button"
                        data-focus-key=${`kill-of:${p.principalId}`}
                        title=${isSelf ? "You can't remove yourself" : `Remove ${who} from the roster`}
                        aria-label=${`Remove ${who}`}
                        aria-expanded=${confirmPerson === p.principalId ? "true" : "false"}
                        ?disabled=${working || isSelf}
                        @click=${() => openRemoveConfirm(p)}
                      >
                        ${icon(Trash2, 14)}
                      </button>`
                }
              </td>
              <td class="gov-col-chev">
                <span class=${`gov-chev ${open ? "open" : ""}`}>${icon(ChevronDown, 15)}</span>
              </td>
            </tr>
            ${
              confirmPerson === p.principalId && !former
                ? html`<tr class="gov-confirm-row">
                    <td colspan="9">${removeConfirm(p, who)}</td>
                  </tr>`
                : nothing
            }
            ${
              trouble.has(key)
                ? html`<tr class="gov-trouble-row">
                    <td colspan="9">${troubleStrip(key)}</td>
                  </tr>`
                : nothing
            }
            ${
              open
                ? html`<tr class="gov-drill-row">
                    <td class="gov-drill-cell" colspan="9">${drillDown(p)}</td>
                  </tr>`
                : nothing
            }
          `;
        })}
      </tbody>
    </table>
  </div>`;
}

function rosterCard(rows: Person[]): TemplateResult {
  const head = html`<button
    class="gov-ghost"
    type="button"
    data-focus-key="person-add-trigger"
    aria-expanded=${personFormOpen ? "true" : "false"}
    @click=${() => (personFormOpen ? closePersonForm() : openPersonForm())}
  >
    ${icon(personFormOpen ? X : Plus, 14)}<span>${personFormOpen ? "Cancel" : "Add person"}</span>
  </button>`;
  const active = rows.filter((p) => p.status !== "former");
  const formerRows = rows.filter((p) => p.status === "former");
  const formerSpend = formerRows.reduce((sum, p) => sum + n(p.costUsd), 0);
  const body = html`
    ${personFormOpen ? personForm() : nothing} ${troubleStrip("person:new", "gov-trouble-card")}
    ${
      active.length
        ? peopleTable(active)
        : emptyPlayground(
            "pulse",
            "Nobody on the meter",
            "Add someone above, or they appear here as soon as they spend a token.",
          )
    }
    ${
      formerRows.length
        ? html`<details class="gov-former">
            <summary>Former members · ${formerRows.length} · spend retained ${money(formerSpend)}</summary>
            <p class="gov-former-note">
              Off the roster and signed out. Their spend stays in the org total and no longer counts against a team cap.
            </p>
            ${peopleTable(formerRows)}
          </details>`
        : nothing
    }
  `;
  return card("Roster", "Click a row to see why a turn would be refused.", head, body);
}

function teamDepth(team: Team, seen: string[] = []): number {
  if (!team.parentId || seen.includes(team.id)) return 0;
  const parent = (teams ?? []).find((t) => t.id === team.parentId);
  if (!parent) return 0;
  return 1 + teamDepth(parent, [...seen, team.id]);
}

function teamTree(): Team[] {
  const rows = teams ?? [];
  const out: Team[] = [];
  const walk = (parentId: string | null): void => {
    for (const team of rows.filter((t) => (t.parentId ?? null) === parentId)) {
      out.push(team);
      walk(team.id);
    }
  };
  walk(null);
  for (const team of rows) if (!out.includes(team)) out.push(team);
  return out;
}

function parentOptions(forTeamId: string): Team[] {
  const blocked = new Set<string>();
  if (forTeamId) {
    blocked.add(forTeamId);
    const rows = teams ?? [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const team of rows) {
        if (team.parentId && blocked.has(team.parentId) && !blocked.has(team.id)) {
          blocked.add(team.id);
          grew = true;
        }
      }
    }
  }
  return (teams ?? []).filter((t) => !blocked.has(t.id));
}

function teamForm(): TemplateResult {
  return html`<div
    class="gov-form gov-team-form"
    @keydown=${(e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeTeamForm();
        return;
      }
      if (e.key !== "Enter" || (e.target as HTMLElement).tagName === "BUTTON") return;
      e.preventDefault();
      void saveTeam();
    }}
  >
    <input
      class="gov-input gov-team-id"
      data-focus-key="team-new-id"
      placeholder="team-id"
      aria-label="Team id"
      ?disabled=${teamDraft.editing}
      .value=${teamDraft.id}
      @input=${(e: Event) => (teamDraft.id = (e.target as HTMLInputElement).value)}
    />
    <input
      class="gov-input gov-team-name"
      data-focus-key="team-new-name"
      placeholder="Display name"
      aria-label="Team display name"
      .value=${teamDraft.name}
      @input=${(e: Event) => (teamDraft.name = (e.target as HTMLInputElement).value)}
    />
    <select
      class="gov-select"
      data-focus-key="team-new-parent"
      aria-label="Parent team"
      .value=${teamDraft.parentId}
      @change=${(e: Event) => (teamDraft.parentId = (e.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${!teamDraft.parentId}>No parent</option>
      ${parentOptions(teamDraft.editing ? teamDraft.id : "").map(
        (t) => html`<option value=${t.id} ?selected=${t.id === teamDraft.parentId}>Under ${t.name}</option>`,
      )}
    </select>
    <button class="gov-primary" type="button" ?disabled=${busy("team:form")} @click=${() => void saveTeam()}>
      ${teamDraft.editing ? "Save team" : "Create team"}
    </button>
    <button class="gov-ghost tiny" type="button" @click=${() => closeTeamForm()}>Cancel</button>
  </div>`;
}

function teamsCard(): TemplateResult {
  const rows = teamTree();
  const spendOf = (id: string) => (people ?? []).filter((p) => p.teamId === id).reduce((a, p) => a + n(p.costUsd), 0);
  const head = html`<button
    class="gov-ghost"
    type="button"
    data-focus-key="team-add-trigger"
    aria-expanded=${teamFormOpen ? "true" : "false"}
    @click=${() => {
      if (teamFormOpen && !teamDraft.editing) {
        closeTeamForm();
        return;
      }
      openTeamForm(null);
    }}
  >
    ${icon(teamFormOpen && !teamDraft.editing ? X : Plus, 14)}
    <span>${teamFormOpen && !teamDraft.editing ? "Cancel" : "New team"}</span>
  </button>`;
  const body = html`
    ${teamFormOpen ? teamForm() : nothing} ${troubleStrip("team:form", "gov-trouble-card")}
    ${
      rows.length
        ? html`<div class="gov-teams">
            ${rows.map((t) => {
              const members = teamMembers(t.id);
              const depth = Math.min(4, teamDepth(t));
              const key = `team:${t.id}`;
              const working = busy(key);
              return html`<div
                class=${`gov-team ${working ? "is-pending" : ""}`}
                style=${`--gov-depth:${depth}`}
                aria-busy=${working ? "true" : "false"}
              >
                <div class="gov-team-row">
                  <div class="gov-team-main">
                    <span class="gov-team-name"
                      >${depth ? html`<i class="gov-team-branch"></i>` : nothing}${t.name}${working ? html`<span class="gov-pending-dot" title="Saving…"></span>` : nothing}</span
                    >
                    <span class="usage-key gov-dim"
                      >${t.id}${t.parentId ? html` <span class="gov-team-parent">under ${t.parentId}</span>` : nothing}</span
                    >
                  </div>
                  <span class="gov-team-stat">${members.length} ${members.length === 1 ? "member" : "members"}</span>
                  <span class="gov-team-stat gov-team-spend">${money(spendOf(t.id))}</span>
                  <button
                    class="gov-ghost tiny"
                    type="button"
                    ?disabled=${working}
                    title=${`Rename or reparent ${t.name}`}
                    @click=${() => openTeamForm(t)}
                  >
                    Edit
                  </button>
                  <button
                    class="gov-ghost tiny gov-icon-only"
                    type="button"
                    data-focus-key=${`team-kill:${t.id}`}
                    ?disabled=${working}
                    title=${`Delete ${t.name}`}
                    aria-label=${`Delete ${t.name}`}
                    aria-expanded=${confirmTeam === t.id ? "true" : "false"}
                    @click=${() => openTeamConfirm(t.id)}
                  >
                    ${icon(Trash2, 14)}
                  </button>
                </div>
                ${confirmTeam === t.id ? teamConfirm(t, members.length, spendOf(t.id)) : nothing} ${troubleStrip(key)}
              </div>`;
            })}
          </div>`
        : teams === null
          ? skeleton()
          : emptyPlayground("cube", "No teams yet", "Group people into teams to roll budgets up a hierarchy.")
    }
  `;
  return card("Teams", "Membership rolls spend and budgets up the tree.", head, body);
}

function allocForm(): TemplateResult {
  const annotate = (value: string, base: string): string => {
    const held = allocFor(value);
    if (!held) return base;
    return `${base} — ${moneyTight(held.limitUsd)} ${windowLabel(n(held.windowMs) || 86_400_000)} set`;
  };
  const subjects: { value: string; label: string }[] = [
    { value: "org", label: annotate("org", "Whole organization") },
    ...(teams ?? []).map((t) => ({ value: `team:${t.id}`, label: annotate(`team:${t.id}`, `Team · ${t.name}`) })),
    ...(people ?? []).map((p) => ({
      value: `principal:${p.principalId}`,
      label: annotate(`principal:${p.principalId}`, `Person · ${p.displayName ?? p.principalId}`),
    })),
  ];
  return html`<div
    class="gov-form gov-alloc-form"
    @keydown=${(e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAllocForm();
        return;
      }
      if (e.key !== "Enter" || (e.target as HTMLElement).tagName === "BUTTON") return;
      e.preventDefault();
      void saveAlloc();
    }}
  >
    <select
      class="gov-select grow"
      data-focus-key="alloc-subject"
      aria-label="Budget subject"
      ?disabled=${allocDraft.editing}
      .value=${allocDraft.subject}
      @change=${(e: Event) => (allocDraft.subject = (e.target as HTMLSelectElement).value)}
    >
      ${subjects.map((s) => html`<option value=${s.value} ?selected=${s.value === allocDraft.subject}>${s.label}</option>`)}
    </select>
    <label class="gov-amount">
      <span>$</span>
      <input
        class="gov-input gov-alloc-amount"
        data-focus-key="alloc-amount"
        type="number"
        min="1"
        step="1"
        placeholder="25"
        aria-label="Budget amount"
        .value=${allocDraft.amount}
        @input=${(e: Event) => (allocDraft.amount = (e.target as HTMLInputElement).value)}
      />
    </label>
    <select
      class="gov-select"
      aria-label="Budget window"
      .value=${allocDraft.window}
      @change=${(e: Event) => (allocDraft.window = (e.target as HTMLSelectElement).value)}
    >
      ${WINDOWS.map((w) => html`<option value=${w.key} ?selected=${w.key === allocDraft.window}>${w.label}</option>`)}
    </select>
    <button
      class=${`web-only-toggle gov-switch labeled ${allocDraft.hard ? "on" : ""}`}
      type="button"
      role="switch"
      aria-checked=${allocDraft.hard ? "true" : "false"}
      title=${allocDraft.hard ? "Hard: refuse the turn at the cap" : "Soft: warn but allow"}
      @click=${() => {
        allocDraft.hard = !allocDraft.hard;
        draw();
      }}
    >
      <span>${allocDraft.hard ? "Hard" : "Soft"}</span><span class="mini-switch"><span class="mini-knob"></span></span>
    </button>
    <button class="gov-primary" type="button" ?disabled=${busy("alloc:form")} @click=${() => void saveAlloc()}>
      ${allocDraft.editing ? "Save" : "Set budget"}
    </button>
    <button class="gov-ghost tiny" type="button" @click=${() => closeAllocForm()}>Cancel</button>
  </div>`;
}

function budgetsCard(): TemplateResult {
  const rows = allocations ?? [];
  const head = html`<button
    class="gov-ghost"
    type="button"
    data-focus-key="alloc-add-trigger"
    aria-expanded=${allocFormOpen ? "true" : "false"}
    @click=${() => {
      if (allocFormOpen) {
        closeAllocForm();
        return;
      }
      openAllocForm("org");
    }}
  >
    ${icon(allocFormOpen ? X : Plus, 14)}<span>${allocFormOpen ? "Cancel" : "New budget"}</span>
  </button>`;
  const body = html`
    ${allocFormOpen ? allocForm() : nothing} ${troubleStrip("alloc:form", "gov-trouble-card")}
    ${
      rows.length
        ? html`<div class="usage-allocs gov-allocs">
            ${rows.map((a) => {
              const limit = n(a.limitUsd);
              const spent = a.spentUsd == null ? null : n(a.spentUsd);
              const used = spent !== null && limit > 0 ? Math.min(1, spent / limit) : 0;
              const over = spent !== null && limit > 0 && spent >= limit;
              const level = meterLevel(over, used);
              const subject = String(a.subject ?? "");
              const key = `alloc:${String(a.id ?? "")}`;
              const working = busy(key);
              return html`<div
                class=${`usage-alloc ${level} ${working ? "is-pending" : ""}`}
                aria-busy=${working ? "true" : "false"}
              >
                <div class="usage-alloc-head">
                  <span class="gov-stack-kind">${subjectKind(subject)}</span>
                  <span class="usage-alloc-subject">${subjectCell(subject)}</span>
                  <span class="usage-alloc-kind ${a.hard ? "hard" : ""}">${a.hard ? "HARD" : "SOFT"}</span>
                  <span class="usage-alloc-amounts">
                    ${spent === null ? "—" : money(spent)} <span class="usage-alloc-of">of</span> ${money(limit)}
                    <span class="usage-alloc-window">${windowLabel(n(a.windowMs) || 86_400_000)}</span>
                  </span>
                  <span class="gov-alloc-actions">
                    <button class="gov-ghost tiny" type="button" ?disabled=${working} @click=${() => editAlloc(a)}>
                      Edit
                    </button>
                    <button
                      class="gov-ghost tiny gov-icon-only"
                      type="button"
                      data-focus-key=${`alloc-kill:${String(a.id ?? "")}`}
                      ?disabled=${working}
                      title="Delete budget"
                      aria-label="Delete budget"
                      aria-expanded=${confirmAlloc === a.id ? "true" : "false"}
                      @click=${() => openAllocConfirm(String(a.id ?? ""))}
                    >
                      ${icon(Trash2, 14)}
                    </button>
                  </span>
                </div>
                ${confirmAlloc === a.id ? allocConfirm(a) : nothing} ${meter(used, level)} ${troubleStrip(key)}
              </div>`;
            })}
          </div>`
        : allocations === null
          ? skeleton()
          : emptyPlayground(
              "key",
              "Nothing is capped",
              "Every principal can spend without limit until you set a budget.",
            )
    }
  `;
  return card("Budgets", "Hard budgets refuse the turn at the cap; soft ones only warn.", head, body);
}

function noticeBanner(): TemplateResult {
  const n0 = notice!;
  return html`<div class=${`gov-notice ${n0.tone}`} role="alert">
    ${n0.tone === "error" ? icon(AlertTriangle, 15) : nothing}
    <span class="gov-notice-text">${n0.text}</span>
    ${
      n0.retry
        ? html`<button class="gov-ghost tiny" type="button" ?disabled=${pending.size > 0} @click=${() => n0.retry?.()}>
            ${icon(n0.actionLabel ? Pencil : RefreshCw, 13)}<span>${n0.actionLabel ?? "Retry"}</span>
          </button>`
        : nothing
    }
    <button
      class="gov-ghost tiny gov-icon-only"
      type="button"
      aria-label="Dismiss"
      @click=${() => {
        notice = null;
        draw();
      }}
    >
      ${icon(X, 13)}
    </button>
  </div>`;
}

function skeleton(): TemplateResult {
  return html`<div class="gov-skeleton" aria-busy="true" aria-label="Loading governance">
    ${[0, 1, 2, 3, 4].map((i) => html`<div class="gov-skeleton-row" style=${`--i:${i}`}></div>`)}
  </div>`;
}

function forbiddenState(): TemplateResult {
  return emptyPlayground(
    "key",
    "Governance needs an admin grant",
    "Ask an org admin to grant you access, and people, teams and budgets will show up here.",
  );
}

function announce(text: string): void {
  const doc = document;
  let region = doc.getElementById("gov-live");
  if (!region) {
    region = doc.createElement("div");
    region.id = "gov-live";
    region.className = "gov-live";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    doc.body.appendChild(region);
  }
  region.textContent = text;
}

function scrollKeys(root: HTMLElement): Map<string, number> {
  const out = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-scroll-key]")) {
    out.set(el.dataset.scrollKey ?? "", el.scrollLeft);
  }
  return out;
}

function draw(loading = false): void {
  if (appState.currentView !== "governance" || !appState.mainEl) return;
  const main = appState.mainEl;
  const pane = main.querySelector<HTMLElement>(".gov-page");
  const scrolled = pane?.scrollTop ?? 0;
  const mainScrolled = main.scrollTop;
  const pageScrolled = document.scrollingElement?.scrollTop ?? 0;
  const held = scrollKeys(main);
  const rows = people ?? [];
  const onRoster = rows.filter((p) => p.status !== "former");
  const admins = onRoster.filter((p) => p.isAdmin).length;
  const host = document.createElement("div");
  host.className = "pane usage-page gov-page";
  render(
    html`
      <header class="usage-hero">
        <div>
          <span class="usage-eyebrow">Access &amp; budgets</span>
          <h1>Governance</h1>
          <p>Who is on the meter, which team they answer to, and exactly what would refuse their next turn.</p>
        </div>
        <button
          class="pane-refresh"
          type="button"
          aria-label="Refresh governance"
          title="Refresh governance"
          @click=${() => void renderGovernance()}
        >
          ${icon(RefreshCw, 17)}
        </button>
      </header>
      ${notice ? noticeBanner() : nothing}
      ${stale && people ? html`<div class="gov-stale">Showing the last data that loaded.</div>` : nothing}
      ${loading && !people ? skeleton() : nothing} ${forbidden ? forbiddenState() : nothing}
      ${
        !forbidden && people
          ? html`
              <section class="usage-section">
                ${kicker("People · last 30 days")}
                <div class="usage-stats gov-stats">
                  ${tile("People", String(onRoster.length), html`<div class="usage-tile-sub">on the roster</div>`)}
                  ${tile("Spend", money(peopleTotal), html`<div class="usage-tile-sub">org-wide, 30 days</div>`)}
                  ${tile("Admins", String(admins), html`<div class="usage-tile-sub">hold an org_admin grant</div>`)}
                  ${tile(
                    "Budgets",
                    String((allocations ?? []).length),
                    html`<div class="usage-tile-sub">caps in force</div>`,
                  )}
                </div>
                ${rosterCard(rows)}
              </section>
              <section class="usage-section">${kicker("Structure")} ${teamsCard()} ${budgetsCard()}</section>
            `
          : nothing
      }
    `,
    host,
  );
  replacePanePreservingFocus(host);
  if (scrolled) host.scrollTop = scrolled;
  if (mainScrolled) main.scrollTop = mainScrolled;
  if (document.scrollingElement && pageScrolled) document.scrollingElement.scrollTop = pageScrolled;
  for (const el of main.querySelectorAll<HTMLElement>("[data-scroll-key]")) {
    const value = held.get(el.dataset.scrollKey ?? "");
    if (value !== undefined) el.scrollLeft = value;
  }
  if (live) announce(live);
}

export async function renderGovernance(): Promise<void> {
  if (appState.currentView !== "governance") return;
  notice = null;
  draw(true);
  await reload();
}
