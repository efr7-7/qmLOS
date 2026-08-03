import { html, nothing, render, type TemplateResult } from "lit";
import { AlertTriangle, ChevronDown, Pencil, Plus, RefreshCw, Trash2, X } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { subjectLabel } from "./subject-label";
import { icon, initials, relTime } from "./ui";
import { playHue } from "./playground";
import { emptyPlayground } from "./playground";
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
}

interface PeopleResponse {
  since?: number;
  totalCostUsd?: number;
  total?: number;
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

interface Notice {
  tone: "error" | "info";
  text: string;
  retry: (() => void) | null;
  actionLabel?: string;
}

const WINDOWS: { key: string; label: string; ms: number }[] = [
  { key: "day", label: "Per day", ms: 86_400_000 },
  { key: "week", label: "Per week", ms: 7 * 86_400_000 },
  { key: "month", label: "Per month", ms: 30 * 86_400_000 },
];

let people: Person[] | null = null;
let peopleTotal = 0;
let teams: Team[] | null = null;
let allocations: Allocation[] | null = null;
let detail: PersonDetail | null = null;
let openPerson: string | null = null;
let detailLoading = false;
let forbidden = false;
let notice: Notice | null = null;
let stale = false;
let busyKey = "";
let teamDraft = { id: "", name: "", parentId: "", membersVersion: "", editing: false };
let teamFormOpen = false;
let confirmTeam = "";
let confirmAlloc = "";
let allocFormOpen = false;
let allocDraft: AllocDraft = { id: "", subject: "org", amount: "", window: "month", hard: true, editing: false };

export function resetGovernanceState(): void {
  people = null;
  peopleTotal = 0;
  teams = null;
  allocations = null;
  detail = null;
  openPerson = null;
  detailLoading = false;
  forbidden = false;
  notice = null;
  stale = false;
  busyKey = "";
  teamDraft = { id: "", name: "", parentId: "", membersVersion: "", editing: false };
  teamFormOpen = false;
  confirmTeam = "";
  confirmAlloc = "";
  allocFormOpen = false;
  allocDraft = { id: "", subject: "org", amount: "", window: "month", hard: true, editing: false };
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

async function write(
  key: string,
  action: string,
  fn: () => Promise<unknown>,
  opts: { goneText?: string } = {},
): Promise<boolean> {
  if (busyKey) return false;
  busyKey = key;
  notice = null;
  draw();
  let ok = true;
  try {
    await fn();
  } catch (e) {
    if (status(e) === 404 && opts.goneText) {
      notice = { tone: "info", text: opts.goneText, retry: null };
    } else {
      ok = false;
      notice = {
        tone: "error",
        text: `${action} — ${errMessage(e, "the server refused the change")}`,
        retry: () => void write(key, action, fn, opts),
      };
    }
  }
  busyKey = "";
  await reload();
  return ok;
}

async function reload(): Promise<void> {
  const [p, t, a] = await Promise.allSettled([
    api<PeopleResponse>(`/api/admin/utb/people?${scopeQuery()}`),
    api<{ teams?: Team[] }>(`/api/admin/utb/teams?${scopeQuery()}`),
    api<{ allocations?: Allocation[] }>(`/api/admin/utb/allocations?${scopeQuery()}`),
  ]);
  if (appState.currentView !== "governance") return;
  if (p.status === "fulfilled") {
    people = p.value.people ?? [];
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
    const d = await api<PersonDetail>(`/api/admin/utb/people/${encodeURIComponent(principalId)}?${scopeQuery()}`);
    if (openPerson !== principalId) return;
    detail = d;
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
    draw();
    return;
  }
  openPerson = principalId;
  detail = null;
  void loadDetail(principalId);
}

function teamMembers(teamId: string): string[] {
  return (people ?? []).filter((p) => p.teamId === teamId).map((p) => p.principalId);
}

async function assignTeam(person: Person, teamId: string): Promise<void> {
  const current = person.teamId ?? "";
  if (current === teamId) return;
  const who = person.displayName ?? person.principalId;
  if (!teamId) {
    await write(
      `team:${person.principalId}`,
      `Couldn't unassign ${who}`,
      () =>
        api(
          `/api/admin/utb/teams/${encodeURIComponent(current)}/members/${encodeURIComponent(person.principalId)}?${scopeQuery()}`,
          { method: "DELETE" },
        ),
      { goneText: `${who} was already off that team.` },
    );
    return;
  }
  const target = teams?.find((t) => t.id === teamId);
  if (!target) return;
  await write(`team:${person.principalId}`, `Couldn't move ${who} to ${target.name}`, () =>
    api(
      `/api/admin/utb/teams/${encodeURIComponent(target.id)}/members/${encodeURIComponent(person.principalId)}?${scopeQuery()}`,
      { method: "PUT" },
    ),
  );
}

async function toggleAdmin(person: Person): Promise<void> {
  const key = `admin:${person.principalId}`;
  const who = person.displayName ?? person.principalId;
  if (person.isAdmin) {
    await write(
      key,
      `Couldn't revoke admin for ${who}`,
      () =>
        api(`/api/admin/grants/${encodeURIComponent(person.principalId)}?${scopeQuery()}&role=org_admin`, {
          method: "DELETE",
        }),
      { goneText: `${who} was already not an admin.` },
    );
    return;
  }
  await write(key, `Couldn't grant admin to ${who}`, () =>
    api(`/api/admin/grants?${scopeQuery()}`, {
      method: "POST",
      body: JSON.stringify({ principalId: person.principalId, role: "org_admin", scopeId: orgScope() }),
    }),
  );
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

async function saveTeam(): Promise<void> {
  const id = teamDraft.id.trim();
  const name = teamDraft.name.trim() || id;
  const parentId = teamDraft.parentId.trim() || null;
  if (!id) {
    notice = { tone: "error", text: "A team needs an id.", retry: null };
    draw();
    return;
  }
  const clash = teamDraft.editing ? null : ((teams ?? []).find((t) => t.id === id) ?? null);
  if (clash) {
    notice = {
      tone: "error",
      text: `A team ${id} already exists — edit it instead?`,
      retry: () => openTeamForm(clash),
      actionLabel: "Edit it",
    };
    draw();
    return;
  }
  const ifMatch = teamDraft.editing ? teamDraft.membersVersion : "";
  const ok = await write(
    "team:save",
    `Couldn't ${teamDraft.editing ? "save" : "create"} team ${id}`,
    () =>
      api(`/api/admin/utb/teams?${scopeQuery()}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(ifMatch ? { "if-match": ifMatch } : {}) },
        body: JSON.stringify({ id, name, parentId }),
      }),
  );
  if (!ok) return;
  teamDraft = { id: "", name: "", parentId: "", membersVersion: "", editing: false };
  teamFormOpen = false;
  draw();
}

async function deleteTeam(id: string): Promise<void> {
  confirmTeam = "";
  await write(
    `team:del:${id}`,
    `Couldn't delete team ${id}`,
    () => api(`/api/admin/utb/teams/${encodeURIComponent(id)}?${scopeQuery()}`, { method: "DELETE" }),
    { goneText: `Team ${id} was already gone — the list is refreshed.` },
  );
}

function allocFor(subject: string, windowMs?: number): Allocation | null {
  const rows = (allocations ?? []).filter((a) => String(a.subject ?? "") === subject);
  const match =
    windowMs === undefined ? rows[0] : rows.find((a) => (n(a.windowMs) || 86_400_000) === windowMs);
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

async function saveAlloc(): Promise<void> {
  const limitUsd = Number(allocDraft.amount);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
    notice = { tone: "error", text: "Enter a budget above zero.", retry: null };
    draw();
    return;
  }
  const win = WINDOWS.find((w) => w.key === allocDraft.window) ?? WINDOWS[2]!;
  const existing = allocDraft.editing ? null : allocFor(allocDraft.subject, win.ms);
  const id = allocDraft.id || existing?.id || draftAllocationId(allocDraft.subject, win.key);
  const ok = await write("alloc:save", `Couldn't save the budget for ${label(allocDraft.subject).name}`, () =>
    api(`/api/admin/utb/allocations?${scopeQuery()}`, {
      method: "PUT",
      body: JSON.stringify({ id, subject: allocDraft.subject, limitUsd, windowMs: win.ms, hard: allocDraft.hard }),
    }),
  );
  if (!ok) return;
  allocFormOpen = false;
  allocDraft = { id: "", subject: "org", amount: "", window: "month", hard: true, editing: false };
  draw();
}

async function deleteAlloc(id: string): Promise<void> {
  confirmAlloc = "";
  await write(
    `alloc:del:${id}`,
    `Couldn't delete budget ${id}`,
    () => api(`/api/admin/utb/allocations/${encodeURIComponent(id)}?${scopeQuery()}`, { method: "DELETE" }),
    { goneText: `Budget ${id} was already gone — the list is refreshed.` },
  );
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
        : html`<div class="gov-nohard">
            No hard cap governs this person — nothing below can refuse a turn.
          </div>`
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
      <div class="gov-drill-kicker">Where the spend went</div>
      <div class="gov-break-grid">
        ${breakdownList(b.byModel ?? [], "By model")} ${breakdownList(b.byHarness ?? [], "By harness")}
        ${breakdownList(b.byPhase ?? [], "By phase")} ${breakdownList(b.bySource ?? [], "By source")}
      </div>
      ${outcomeMix(detail)}
    </div>
  </div>`;
}

function peopleTable(rows: Person[]): TemplateResult {
  const maxSpend = Math.max(...rows.map((p) => n(p.costUsd)), 0.000001);
  const self = appState.me?.user ?? "";
  return html`<div class="usage-table-scroll">
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
          <th class="gov-col-chev"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((p) => {
          const open = openPerson === p.principalId;
          const isSelf = p.principalId === self;
          return html`
            <tr
              class=${`gov-row ${open ? "open" : ""}`}
              tabindex="0"
              @click=${() => togglePerson(p.principalId)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  togglePerson(p.principalId);
                }
              }}
            >
              <td class="gov-person-cell">
                <span class="gov-person">
                  ${avatar(p.principalId, p.displayName ?? p.principalId)}
                  <span class="gov-person-text">
                    <span class="gov-person-name">
                      <b>${p.displayName ?? p.principalId}</b>
                      ${isSelf ? html`<span class="gov-you">you</span>` : nothing}
                    </span>
                    <em>${p.principalId}</em>
                  </span>
                </span>
              </td>
              <td class="gov-col-team" @click=${(e: Event) => e.stopPropagation()}>
                <select
                  class="gov-select"
                  aria-label=${`Team for ${p.displayName ?? p.principalId}`}
                  ?disabled=${busyKey !== ""}
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
                </select>
              </td>
              <td class="gov-col-admin" @click=${(e: Event) => e.stopPropagation()}>
                <button
                  class=${`web-only-toggle gov-switch ${p.isAdmin ? "on" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked=${p.isAdmin ? "true" : "false"}
                  aria-label=${`Admin for ${p.displayName ?? p.principalId}`}
                  ?disabled=${busyKey !== "" || (isSelf && p.isAdmin === true)}
                  title=${adminTitle(isSelf, p.isAdmin === true)}
                  @click=${() => void toggleAdmin(p)}
                >
                  <span class="mini-switch"><span class="mini-knob"></span></span>
                </button>
              </td>
              <td class="usage-cost gov-spend">
                <span class="gov-spend-inner">${meter(n(p.costUsd) / maxSpend, "inline")}${money(p.costUsd)}</span>
              </td>
              <td class="gov-col-calls">${fmtCalls(p.calls)}</td>
              <td class="gov-col-budget" @click=${(e: Event) => e.stopPropagation()}>
                ${
                  p.hasOwnAllocation
                    ? html`<span class="gov-chip on">Own cap</span>`
                    : html`<button
                        class="gov-ghost tiny"
                        type="button"
                        title=${`Set a personal budget for ${p.displayName ?? p.principalId}`}
                        @click=${() => openAllocForm(`principal:${p.principalId}`)}
                      >
                        ${icon(Plus, 13)}<span>Budget</span>
                      </button>`
                }
              </td>
              <td class="gov-dim gov-col-active">${p.lastActiveAt ? relTime(n(p.lastActiveAt)) : "never"}</td>
              <td class="gov-col-chev">
                <span class=${`gov-chev ${open ? "open" : ""}`}>${icon(ChevronDown, 15)}</span>
              </td>
            </tr>
            ${
              open
                ? html`<tr class="gov-drill-row">
                    <td class="gov-drill-cell" colspan="8">${drillDown(p)}</td>
                  </tr>`
                : nothing
            }
          `;
        })}
      </tbody>
    </table>
  </div>`;
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
  return html`<div class="gov-form gov-team-form">
    <input
      class="gov-input gov-team-id"
      placeholder="team-id"
      ?disabled=${teamDraft.editing}
      .value=${teamDraft.id}
      @input=${(e: Event) => (teamDraft.id = (e.target as HTMLInputElement).value)}
    />
    <input
      class="gov-input gov-team-name"
      placeholder="Display name"
      .value=${teamDraft.name}
      @input=${(e: Event) => (teamDraft.name = (e.target as HTMLInputElement).value)}
    />
    <select
      class="gov-select"
      aria-label="Parent team"
      .value=${teamDraft.parentId}
      @change=${(e: Event) => (teamDraft.parentId = (e.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${!teamDraft.parentId}>No parent</option>
      ${parentOptions(teamDraft.editing ? teamDraft.id : "").map(
        (t) => html`<option value=${t.id} ?selected=${t.id === teamDraft.parentId}>Under ${t.name}</option>`,
      )}
    </select>
    <button class="gov-primary" type="button" ?disabled=${busyKey !== ""} @click=${() => void saveTeam()}>
      ${teamDraft.editing ? "Save team" : "Create team"}
    </button>
  </div>`;
}

function teamsCard(): TemplateResult {
  const rows = teamTree();
  const spendOf = (id: string) => (people ?? []).filter((p) => p.teamId === id).reduce((a, p) => a + n(p.costUsd), 0);
  const head = html`<button
    class="gov-ghost"
    type="button"
    @click=${() => {
      if (teamFormOpen && !teamDraft.editing) {
        teamFormOpen = false;
        draw();
        return;
      }
      openTeamForm(null);
    }}
  >
    ${icon(teamFormOpen && !teamDraft.editing ? X : Plus, 14)}
    <span>${teamFormOpen && !teamDraft.editing ? "Cancel" : "New team"}</span>
  </button>`;
  const body = html`
    ${teamFormOpen ? teamForm() : nothing}
    ${
      rows.length
        ? html`<div class="gov-teams">
            ${rows.map((t) => {
              const members = teamMembers(t.id);
              const depth = Math.min(4, teamDepth(t));
              return html`<div class="gov-team" style=${`--gov-depth:${depth}`}>
                <div class="gov-team-main">
                  <span class="gov-team-name">${depth ? html`<i class="gov-team-branch"></i>` : nothing}${t.name}</span>
                  <span class="usage-key gov-dim">${t.id}${t.parentId ? html` <span class="gov-team-parent">under ${t.parentId}</span>` : nothing}</span>
                </div>
                <span class="gov-team-stat">${members.length} ${members.length === 1 ? "member" : "members"}</span>
                <span class="gov-team-stat gov-team-spend">${money(spendOf(t.id))}</span>
                ${
                  confirmTeam === t.id
                    ? html`<span class="gov-confirm">
                        <span>Delete ${t.name}?</span>
                        <button class="gov-danger" type="button" @click=${() => void deleteTeam(t.id)}>Delete</button>
                        <button
                          class="gov-ghost tiny"
                          type="button"
                          @click=${() => {
                            confirmTeam = "";
                            draw();
                          }}
                        >
                          Keep
                        </button>
                      </span>`
                    : html`<button
                          class="gov-ghost tiny"
                          type="button"
                          title=${`Rename or reparent ${t.name}`}
                          @click=${() => openTeamForm(t)}
                        >
                          Edit
                        </button>
                        <button
                          class="gov-ghost tiny gov-icon-only"
                          type="button"
                          title=${`Delete ${t.name}`}
                          aria-label=${`Delete ${t.name}`}
                          @click=${() => {
                            confirmTeam = t.id;
                            draw();
                          }}
                        >
                          ${icon(Trash2, 14)}
                        </button>`
                }
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
  return html`<div class="gov-form gov-alloc-form">
    <select
      class="gov-select grow"
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
        type="number"
        min="1"
        step="1"
        placeholder="25"
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
    <button class="gov-primary" type="button" ?disabled=${busyKey !== ""} @click=${() => void saveAlloc()}>
      ${allocDraft.editing ? "Save" : "Set budget"}
    </button>
  </div>`;
}

function budgetsCard(): TemplateResult {
  const rows = allocations ?? [];
  const head = html`<button
    class="gov-ghost"
    type="button"
    @click=${() => {
      if (allocFormOpen) {
        allocFormOpen = false;
        draw();
        return;
      }
      openAllocForm("org");
    }}
  >
    ${icon(allocFormOpen ? X : Plus, 14)}<span>${allocFormOpen ? "Cancel" : "New budget"}</span>
  </button>`;
  const body = html`
    ${allocFormOpen ? allocForm() : nothing}
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
              return html`<div class="usage-alloc ${level}">
                <div class="usage-alloc-head">
                  <span class="gov-stack-kind">${subjectKind(subject)}</span>
                  <span class="usage-alloc-subject">${subjectCell(subject)}</span>
                  <span class="usage-alloc-kind ${a.hard ? "hard" : ""}">${a.hard ? "HARD" : "SOFT"}</span>
                  <span class="usage-alloc-amounts">
                    ${spent === null ? "—" : money(spent)} <span class="usage-alloc-of">of</span> ${money(limit)}
                    <span class="usage-alloc-window">${windowLabel(n(a.windowMs) || 86_400_000)}</span>
                  </span>
                  <span class="gov-alloc-actions">
                    ${
                      confirmAlloc === a.id
                        ? html`<span class="gov-confirm">
                            <span>Remove this cap?</span>
                            <button class="gov-danger" type="button" @click=${() => void deleteAlloc(String(a.id))}>
                              Delete
                            </button>
                            <button
                              class="gov-ghost tiny"
                              type="button"
                              @click=${() => {
                                confirmAlloc = "";
                                draw();
                              }}
                            >
                              Keep
                            </button>
                          </span>`
                        : html`<button class="gov-ghost tiny" type="button" @click=${() => editAlloc(a)}>Edit</button>
                            <button
                              class="gov-ghost tiny gov-icon-only"
                              type="button"
                              title="Delete budget"
                              aria-label="Delete budget"
                              @click=${() => {
                                confirmAlloc = String(a.id ?? "");
                                draw();
                              }}
                            >
                              ${icon(Trash2, 14)}
                            </button>`
                    }
                  </span>
                </div>
                ${meter(used, level)}
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
        ? html`<button class="gov-ghost tiny" type="button" ?disabled=${busyKey !== ""} @click=${() => n0.retry?.()}>
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

function draw(loading = false): void {
  if (appState.currentView !== "governance" || !appState.mainEl) return;
  const rows = people ?? [];
  const admins = rows.filter((p) => p.isAdmin).length;
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
      ${loading && !people ? skeleton() : nothing}
      ${forbidden ? forbiddenState() : nothing}
      ${
        !forbidden && people
          ? html`
              <section class="usage-section">
                ${kicker("People · last 30 days")}
                <div class="usage-stats gov-stats">
                  ${tile("People", String(rows.length), html`<div class="usage-tile-sub">on the meter</div>`)}
                  ${tile("Spend", money(peopleTotal), html`<div class="usage-tile-sub">org-wide, 30 days</div>`)}
                  ${tile("Admins", String(admins), html`<div class="usage-tile-sub">hold an org_admin grant</div>`)}
                  ${tile(
                    "Budgets",
                    String((allocations ?? []).length),
                    html`<div class="usage-tile-sub">caps in force</div>`,
                  )}
                </div>
                ${
                  rows.length
                    ? card("Roster", "Click a row to see why a turn would be refused.", nothing, peopleTable(rows))
                    : emptyPlayground(
                        "pulse",
                        "Nobody on the meter",
                        "People appear here as soon as they spend a token.",
                      )
                }
              </section>
              <section class="usage-section">${kicker("Structure")} ${teamsCard()} ${budgetsCard()}</section>
            `
          : nothing
      }
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export async function renderGovernance(): Promise<void> {
  if (appState.currentView !== "governance") return;
  notice = null;
  draw(true);
  await reload();
}
