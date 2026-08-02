import { html, nothing, render, type TemplateResult } from "lit";
import { RefreshCw } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { emptyPlayground } from "./playground";
import { appState, replacePanePreservingFocus } from "./shell";

interface UsageRow {
  key: string;
  calls?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  estimatedCalls?: number;
  totalTokens?: number;
  effectiveUsdPerMtok?: number;
  cacheReadShare?: number;
  estimatedShare?: number;
}

interface UsageSummary {
  since?: string | number;
  totalCostUsd?: number;
  totals?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  cacheReadShare?: number;
  byModel?: UsageRow[];
  byPhase?: UsageRow[];
}

interface OrgUtb {
  totalCostUsd?: number;
  headcount?: number;
  pepmUsd?: number;
  groups?: Record<string, UsageRow[] | undefined>;
}

interface LeaderboardRow {
  teamId?: string;
  key?: string;
  members?: number;
  calls?: number;
  totalTokens?: number;
  costUsd?: number;
  costPerOutcomeUsd?: number;
  cacheReadShare?: number;
  outcomesProduced?: number;
}

interface Leaderboard {
  mode?: string;
  rows?: LeaderboardRow[];
}

let usage: UsageSummary | null = null;
let org: OrgUtb | null = null;
let leaderboard: Leaderboard | null = null;
let notice = "";

export function resetUsageState(): void {
  usage = null;
  org = null;
  leaderboard = null;
  notice = "";
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function money(v: unknown): string {
  return `$${n(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function fmtSince(since: unknown): string {
  const d = typeof since === "number" || typeof since === "string" ? new Date(since) : null;
  if (!d || Number.isNaN(d.getTime())) return "this month";
  return `since ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function rowTokens(r: UsageRow): number {
  return r.totalTokens !== undefined
    ? n(r.totalTokens)
    : n(r.input) + n(r.output) + n(r.cacheRead) + n(r.cacheWrite);
}

function meter(value: number, cls = ""): TemplateResult {
  return html`<div class="usage-meter ${cls}">
    <span style=${`width:${(share(value) * 100).toFixed(1)}%`}></span>
  </div>`;
}

function tile(label: string, value: string, sub: unknown = nothing): TemplateResult {
  return html`<div class="usage-tile">
    <div class="usage-tile-label">${label}</div>
    <div class="usage-tile-value">${value}</div>
    ${sub}
  </div>`;
}

function kicker(text: string): TemplateResult {
  return html`<div class="usage-kicker"><span class="usage-kicker-mark"></span>${text}</div>`;
}

function card(title: string, blurb: string, body: unknown): TemplateResult {
  return html`<section class="usage-card">
    <div class="usage-card-head">
      <h2>${title}</h2>
      <p>${blurb}</p>
    </div>
    ${body}
  </section>`;
}

function estChip(r: UsageRow): unknown {
  const est = n(r.estimatedCalls);
  if (est <= 0) return nothing;
  return html`<span class="usage-est" title=${`${fmtCalls(est)} calls priced by estimate`}>~est</span>`;
}

function cacheCell(value: number): TemplateResult {
  return html`<span class="usage-cache-cell">${meter(value, "inline")}<span>${pct(value)}</span></span>`;
}

function myModelTable(rows: UsageRow[]): TemplateResult {
  return html`<div class="usage-table-scroll">
    <table class="usage-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Calls</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache read</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) => html`<tr>
            <td><span class="usage-key">${r.key}</span>${estChip(r)}</td>
            <td>${fmtCalls(r.calls)}</td>
            <td>${fmtTokens(r.input)}</td>
            <td>${fmtTokens(r.output)}</td>
            <td>${fmtTokens(r.cacheRead)}</td>
            <td class="usage-cost">${money(r.costUsd)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function orgModelTable(rows: UsageRow[]): TemplateResult {
  return html`<div class="usage-table-scroll">
    <table class="usage-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Calls</th>
          <th>Tokens</th>
          <th>$ / Mtok</th>
          <th>Cache read</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) => html`<tr>
            <td><span class="usage-key">${r.key}</span>${estChip(r)}</td>
            <td>${fmtCalls(r.calls)}</td>
            <td>${fmtTokens(rowTokens(r))}</td>
            <td>${money(r.effectiveUsdPerMtok)}</td>
            <td>${cacheCell(n(r.cacheReadShare))}</td>
            <td class="usage-cost">${money(r.costUsd)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function phaseStrip(rows: UsageRow[]): TemplateResult {
  const weights = rows.map((r) => (n(r.costUsd) > 0 ? n(r.costUsd) : rowTokens(r)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return html`<div class="usage-phase">
    <div class="usage-phase-bar">
      ${rows.map(
        (r, i) =>
          html`<span
            class=${`usage-seg-${Math.min(i, 5)}`}
            style=${`flex:${((weights[i]! / total) * 100).toFixed(2)} 1 0%`}
            title=${`${r.key} · ${money(r.costUsd)}`}
          ></span>`,
      )}
    </div>
    <div class="usage-phase-legend">
      ${rows.map(
        (r, i) =>
          html`<span class="usage-phase-item">
            <i class=${`usage-seg-${Math.min(i, 5)}`}></i>${r.key}<b>${money(r.costUsd)}</b>
          </span>`,
      )}
    </div>
  </div>`;
}

function sourceSplit(rows: UsageRow[]): TemplateResult {
  const total = rows.reduce((a, r) => a + n(r.costUsd), 0) || 1;
  return html`<div class="usage-source-list">
    ${rows.map((r) => {
      const s = n(r.costUsd) / total;
      return html`<div class="usage-source-row">
        <span class="usage-key">${r.key}</span>
        ${meter(s, "wide")}
        <span class="usage-source-cost">${money(r.costUsd)}</span>
        <span class="usage-source-share">${pct(s)}</span>
      </div>`;
    })}
  </div>`;
}

function leaderboardTable(board: Leaderboard): TemplateResult {
  const teams = board.mode !== "named";
  const rows = [...(board.rows ?? [])].sort(
    (a, b) => (a.costPerOutcomeUsd ?? Infinity) - (b.costPerOutcomeUsd ?? Infinity),
  );
  return html`<div class="usage-table-scroll">
    <table class="usage-table">
      <thead>
        <tr>
          <th>#</th>
          <th class="usage-team">${teams ? "Team" : "Principal"}</th>
          ${teams ? html`<th>Members</th>` : nothing}
          <th>Tokens</th>
          <th>Outcomes</th>
          <th>Cache read</th>
          <th>Cost</th>
          <th>$ / outcome</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (r, i) => html`<tr class=${i === 0 ? "usage-rank-1" : ""}>
            <td class="usage-rank">${i + 1}</td>
            <td class="usage-team"><span class="usage-key">${r.teamId ?? r.key ?? "—"}</span></td>
            ${teams ? html`<td>${fmtCalls(r.members)}</td>` : nothing}
            <td>${fmtTokens(r.totalTokens)}</td>
            <td>${fmtCalls(r.outcomesProduced)}</td>
            <td>${cacheCell(n(r.cacheReadShare))}</td>
            <td>${money(r.costUsd)}</td>
            <td class="usage-cost">${money(r.costPerOutcomeUsd)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function personalSection(u: UsageSummary): TemplateResult {
  const totals = u.totals ?? {};
  const totalTokens = n(totals.input) + n(totals.output) + n(totals.cacheRead) + n(totals.cacheWrite);
  const models = u.byModel ?? [];
  const phases = u.byPhase ?? [];
  const calls = models.reduce((a, r) => a + n(r.calls), 0);
  return html`<section class="usage-section">
    ${kicker(`Your usage · ${fmtSince(u.since)}`)}
    <div class="usage-stats">
      ${tile(
        "Spend this month",
        money(u.totalCostUsd),
        html`<div class="usage-tile-sub">${fmtCalls(calls)} model calls</div>`,
      )}
      ${tile(
        "Total tokens",
        fmtTokens(totalTokens),
        html`<div class="usage-tile-sub">${fmtTokens(totals.input)} in · ${fmtTokens(totals.output)} out</div>`,
      )}
      ${tile(
        "Cache read share",
        pct(u.cacheReadShare),
        html`${meter(n(u.cacheReadShare))}
          <div class="usage-tile-sub">of reads served from cache</div>`,
      )}
    </div>
    ${models.length ? card("By model", "Where your spend went, per model.", myModelTable(models)) : nothing}
    ${phases.length ? card("By phase", "Cost split across the agent's working phases.", phaseStrip(phases)) : nothing}
  </section>`;
}

function orgSection(o: OrgUtb, board: Leaderboard | null): TemplateResult {
  const models = o.groups?.model ?? [];
  const sources = o.groups?.source ?? [];
  const orgTokens = models.reduce((a, r) => a + rowTokens(r), 0);
  return html`<section class="usage-section">
    ${kicker("Organization · this month")}
    <div class="usage-stats">
      ${tile(
        "Org spend",
        money(o.totalCostUsd),
        html`<div class="usage-tile-sub">${fmtTokens(orgTokens)} tokens org-wide</div>`,
      )}
      ${tile("PEPM", money(o.pepmUsd), html`<div class="usage-tile-sub">per employee, per month</div>`)}
      ${tile("Headcount", String(n(o.headcount)), html`<div class="usage-tile-sub">people on the meter</div>`)}
    </div>
    ${models.length ? card("By model", "Effective rate and spend across the org.", orgModelTable(models)) : nothing}
    ${sources.length ? card("By source", "Which surfaces the tokens flow through.", sourceSplit(sources)) : nothing}
    ${
      board?.rows?.length
        ? card("Team leaderboard", "Ranked by cost per outcome — lower is better.", leaderboardTable(board))
        : nothing
    }
  </section>`;
}

function usageIsEmpty(): boolean {
  return Boolean(usage) && !usage?.byModel?.length && !usage?.byPhase?.length && n(usage?.totalCostUsd) <= 0;
}

function drawUsage(loading = false): void {
  if (appState.currentView !== "usage" || !appState.mainEl) return;
  const host = document.createElement("div");
  host.className = "pane usage-page";
  render(
    html`
      <header class="usage-hero">
        <div>
          <span class="usage-eyebrow">Metered spend</span>
          <h1>Usage</h1>
          <p>What the agent consumed and what it cost — yours first, then the whole organization.</p>
        </div>
        <button
          class="pane-refresh"
          type="button"
          aria-label="Refresh usage"
          title="Refresh usage"
          @click=${() => void renderUsage()}
        >
          ${icon(RefreshCw, 17)}
        </button>
      </header>
      ${notice || loading ? html`<div class="status">${notice || "Loading…"}</div>` : nothing}
      ${usageIsEmpty() && !loading ? emptyPlayground("pulse", "All quiet on the meter", "Tokens will show up here the moment work starts.") : nothing}
      ${usage && !usageIsEmpty() ? personalSection(usage) : nothing} ${org ? orgSection(org, leaderboard) : nothing}
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export async function renderUsage(): Promise<void> {
  if (appState.currentView !== "usage") return;
  const seq = appState.viewRenderSeq;
  notice = "";
  drawUsage(true);
  const orgScope = `org:${appState.me?.org ?? ""}`;
  const [mine, utb, board] = await Promise.allSettled([
    api<UsageSummary>("/api/usage"),
    api<OrgUtb>(`/api/admin/utb?scope=${encodeURIComponent(orgScope)}`),
    api<Leaderboard>("/api/admin/utb/leaderboard"),
  ]);
  if (seq !== appState.viewRenderSeq || appState.currentView !== "usage") return;
  if (mine.status === "fulfilled") usage = mine.value;
  else {
    usage = null;
    notice = errMessage(mine.reason, "Failed to load usage.");
  }
  org = utb.status === "fulfilled" ? utb.value : null;
  leaderboard = board.status === "fulfilled" ? board.value : null;
  drawUsage();
}
