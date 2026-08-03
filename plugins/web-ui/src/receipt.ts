import { html, nothing, render, type TemplateResult } from "lit";
import { Copy, GitCommitHorizontal, MessageSquare, Package, Send, X } from "lucide";
import { api, ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { copyText, icon } from "./ui";
import { emptyPlayground } from "./playground";
import { trapDialogFocus } from "./dialog-focus";

export interface ReceiptRow {
  runId: string;
  principalId: string;
  displayName?: string;
  outcome: string;
  outcomeCostUsd?: number;
  costUsd?: number;
  calls?: number;
  totalTokens?: number;
  model?: string;
  harness?: string;
  estimated?: boolean;
  at?: number;
}

interface ReceiptItem {
  phase: string;
  model: string;
  harness: string;
  source: string;
  calls?: number;
  totalTokens?: number;
  costUsd?: number;
  estimatedCalls?: number;
}

interface ReceiptAllocation {
  id?: string;
  subject?: string;
  kind?: string;
  limitUsd?: number;
  windowMs?: number;
  hard?: boolean;
  spentUsd?: number | null;
  remainingUsd?: number | null;
  exceeded?: boolean | null;
}

interface Receipt {
  runId?: string;
  principalId?: string;
  displayName?: string;
  sessionId?: string | null;
  at?: number;
  firstAt?: number;
  lastAt?: number;
  outcome?: { kind: string; costUsd?: number; at?: number } | null;
  totals?: {
    calls?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    costUsd?: number;
    estimatedCalls?: number;
    totalTokens?: number;
    effectiveUsdPerMtok?: number | null;
  };
  items?: ReceiptItem[];
  sources?: string[];
  team?: { id?: string; name?: string } | null;
  teamAncestry?: { id: string; name?: string }[];
  allocations?: ReceiptAllocation[];
}

const OUTCOME_HEADLINE: Record<string, string> = {
  "code-pushed": "Pushed code",
  artifact: "Shipped an artifact",
  "sent-internal": "Sent to a channel",
  chat: "Conversation",
};

const OUTCOME_ICON = {
  "code-pushed": GitCommitHorizontal,
  artifact: Package,
  "sent-internal": Send,
  chat: MessageSquare,
} as const;

const PHASE_WORDS: Record<string, string> = {
  turn: "Answered the turn",
  external: "Worked in the harness",
  detect: "Read the room",
  compact: "Compacted context",
  screen: "Screened the ask",
  other: "Other work",
};

let open: string | null = null;
let receipt: Receipt | null = null;
let loading = false;
let failure = "";
let opener: HTMLElement | null = null;
let layer: HTMLElement | null = null;

export function resetReceiptState(): void {
  open = null;
  receipt = null;
  loading = false;
  failure = "";
  opener = null;
  if (layer) render(nothing, layer);
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function fixed(v: unknown, digits: number): string {
  return `$${n(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function money(v: unknown): string {
  const value = n(v);
  return fixed(value, value > 0 && value < 0.01 ? 4 : 2);
}

function amountDigits(r: Receipt): number {
  const values = [...(r.items ?? []).map((i) => n(i.costUsd)), n(r.totals?.costUsd)].filter((v) => v > 0);
  return values.some((v) => v < 0.01) ? 4 : 2;
}

function tokens(v: unknown): string {
  const value = n(v);
  const one = (x: number) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ""));
  if (value >= 1e9) return `${one(value / 1e9)}B`;
  if (value >= 1e6) return `${one(value / 1e6)}M`;
  if (value >= 1e3) return `${one(value / 1e3)}k`;
  return String(Math.round(value));
}

function exact(v: unknown): string {
  return Math.round(n(v)).toLocaleString("en-US");
}

function headline(kind: string | undefined): string {
  return OUTCOME_HEADLINE[kind ?? ""] ?? "Metered work";
}

function outcomeIcon(kind: string | undefined): TemplateResult {
  const node = OUTCOME_ICON[(kind ?? "chat") as keyof typeof OUTCOME_ICON] ?? MessageSquare;
  return html`${icon(node, 15)}`;
}

function stamp(at: unknown): string {
  const d = new Date(n(at));
  if (Number.isNaN(d.getTime())) return "—";
  return d
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(",", "");
}

function windowLabel(windowMs: number): string {
  if (windowMs >= 27 * 86_400_000) return "per month";
  if (windowMs >= 6 * 86_400_000) return "per week";
  if (windowMs >= 86_400_000) return "per day";
  return `per ${Math.max(1, Math.round(windowMs / 3_600_000))}h`;
}

function budgetName(a: ReceiptAllocation, r: Receipt): string {
  const subject = String(a.subject ?? "");
  if (subject === "org") return "Whole organization";
  if (subject.startsWith("team:")) {
    const id = subject.slice(5);
    return r.teamAncestry?.find((t) => t.id === id)?.name || id;
  }
  if (subject.startsWith("principal:")) {
    const id = subject.slice(10);
    return id === r.principalId ? (r.displayName ?? id) : id;
  }
  return subject;
}

function budgetKind(a: ReceiptAllocation): string {
  if (a.kind === "org") return "ORG";
  if (a.kind === "team") return "TEAM";
  return "PERSONAL";
}

function orderedBudgets(r: Receipt): ReceiptAllocation[] {
  const rank = (a: ReceiptAllocation) => (a.kind === "principal" ? 0 : a.kind === "team" ? 1 : 2);
  return [...(r.allocations ?? [])].sort((a, b) => rank(a) - rank(b) || n(a.limitUsd) - n(b.limitUsd));
}

function itemLabel(item: ReceiptItem): string {
  return PHASE_WORDS[item.phase] ?? item.phase;
}

const CLIP_QTY = 5;
const CLIP_DESC = 38;
const CLIP_TOKENS = 10;
const CLIP_AMOUNT = 11;
const CLIP_WIDTH = CLIP_QTY + CLIP_DESC + CLIP_TOKENS + CLIP_AMOUNT;

function clip(s: string, w: number): string {
  if (s.length > w) return `${s.slice(0, w - 2)}… `;
  return s + " ".repeat(w - s.length);
}

function clipRight(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

export function plainReceipt(r: Receipt): string {
  const digits = amountDigits(r);
  const rule = "-".repeat(CLIP_WIDTH);
  const row = (qty: string, desc: string, tok: string, amount: string) =>
    clip(qty, CLIP_QTY) + clip(desc, CLIP_DESC) + clipRight(tok, CLIP_TOKENS) + clipRight(amount, CLIP_AMOUNT);
  const lines: string[] = [];
  lines.push(`LOS RECEIPT   ${r.runId ?? ""}`);
  lines.push(stamp(r.at));
  lines.push("");
  lines.push(`${r.displayName ?? r.principalId ?? ""} — ${headline(r.outcome?.kind)}`);
  const trail = [
    ...(r.teamAncestry ?? []).map((t) => t.name ?? t.id),
    ...[...new Set((r.items ?? []).map((i) => i.harness))].map((h) => `via ${h}`),
    ...(r.sessionId ? [`thread ${r.sessionId}`] : []),
  ];
  if (trail.length) lines.push(trail.join(" · "));
  lines.push("");
  lines.push(row("QTY", "DESCRIPTION", "TOKENS", "AMOUNT"));
  lines.push(rule);
  for (const item of r.items ?? []) {
    lines.push(
      row(
        `${n(item.calls)} x`,
        `${itemLabel(item)} · ${item.model}`,
        exact(item.totalTokens),
        fixed(item.costUsd, digits),
      ),
    );
  }
  lines.push(rule);
  lines.push(row("", "TOTAL", exact(r.totals?.totalTokens), fixed(r.totals?.costUsd, digits)));
  lines.push(`${n(r.totals?.calls)} model calls · ${money(r.totals?.effectiveUsdPerMtok)} per Mtok`);
  lines.push("");
  lines.push("DRAWN DOWN FROM");
  const budgets = orderedBudgets(r);
  if (!budgets.length) lines.push("  no budget governs this person — this spend was never refusable");
  for (const a of budgets) {
    const remaining = a.remainingUsd == null ? null : n(a.remainingUsd);
    const left = remaining === null ? "—" : remaining < 0 ? `over by ${money(-remaining)}` : `${money(remaining)} left`;
    lines.push(
      "  " +
        clip(`${budgetKind(a)} ${budgetName(a, r)}`, 26) +
        clip(`${money(a.spentUsd)} of ${money(a.limitUsd)} ${windowLabel(n(a.windowMs) || 86_400_000)}`, 30) +
        clip(left, 16) +
        (a.hard ? "refuses the turn" : "warns only"),
    );
  }
  const estimated = n(r.totals?.estimatedCalls);
  if (estimated > 0) {
    lines.push("");
    lines.push(
      `~ ${estimated} of ${n(r.totals?.calls)} calls were priced by estimate, not by a provider-reported cost.`,
    );
  }
  return lines.join("\n");
}

function itemRow(item: ReceiptItem, digits: number): TemplateResult {
  return html`<tr>
    <td class="rcpt-qty">${n(item.calls)}<span>×</span></td>
    <td class="rcpt-desc">
      <span class="rcpt-desc-main">${itemLabel(item)}</span>
      <span class="rcpt-desc-sub">${item.model}${item.source === "los" ? "" : ` · ${item.source}`}</span>
    </td>
    <td class="rcpt-num">${tokens(item.totalTokens)}</td>
    <td class="rcpt-num rcpt-amount">
      ${fixed(item.costUsd, digits)}${n(item.estimatedCalls) > 0 ? html`<i class="rcpt-tilde" title="priced by estimate">~</i>` : nothing}
    </td>
  </tr>`;
}

function budgetRow(a: ReceiptAllocation, r: Receipt): TemplateResult {
  const limit = n(a.limitUsd);
  const spent = a.spentUsd == null ? null : n(a.spentUsd);
  const used = spent !== null && limit > 0 ? Math.min(1, spent / limit) : 0;
  const over = a.exceeded === true || (spent !== null && limit > 0 && spent >= limit);
  const level = over ? "is-over" : used >= 0.8 ? "is-warn" : "";
  const remaining = a.remainingUsd == null ? null : n(a.remainingUsd);
  return html`<div class=${`rcpt-budget ${level}`}>
    <div class="rcpt-budget-top">
      <span class="rcpt-budget-kind">${budgetKind(a)}</span>
      <span class="rcpt-budget-name">${budgetName(a, r)}</span>
      <span class="rcpt-budget-left">
        ${
          remaining === null
            ? "—"
            : remaining < 0
              ? html`<b>over by ${money(-remaining)}</b>`
              : html`<b>${money(remaining)}</b> left`
        }
      </span>
    </div>
    <div class="rcpt-budget-meter"><span style=${`width:${(used * 100).toFixed(1)}%`}></span></div>
    <div class="rcpt-budget-foot">
      <span>${money(a.spentUsd)} of ${money(limit)} ${windowLabel(n(a.windowMs) || 86_400_000)}</span>
      <span class=${`rcpt-budget-rule ${a.hard ? "hard" : ""}`}>${a.hard ? "refuses the turn" : "warns only"}</span>
    </div>
  </div>`;
}

function receiptBody(r: Receipt): TemplateResult {
  const chain = (r.teamAncestry ?? []).map((t) => t.name ?? t.id);
  const engines = [...new Set((r.items ?? []).map((i) => i.harness))];
  const estimated = n(r.totals?.estimatedCalls);
  const budgets = orderedBudgets(r);
  const digits = amountDigits(r);
  return html`
    <div class="rcpt-word">Receipt</div>
    <div class="rcpt-stub">
      <span class="rcpt-runid">${r.runId}</span>
      <span class="rcpt-stamp">${stamp(r.at)}</span>
    </div>
    <div class="rcpt-headline">
      <div class="rcpt-who">${r.displayName ?? r.principalId}</div>
      <div class="rcpt-did">${outcomeIcon(r.outcome?.kind)}<span>${headline(r.outcome?.kind)}</span></div>
      <div class="rcpt-meta">
        ${chain.length ? html`<span>${chain.join(" / ")}</span>` : nothing}
        ${engines.length ? html`<span>via <b class="rcpt-engine">${engines.join(" + ")}</b></span>` : nothing}
        ${r.sessionId ? html`<span>thread ${r.sessionId}</span>` : nothing}
      </div>
    </div>
    <table class="rcpt-items">
      <thead>
        <tr>
          <th class="rcpt-qty">Qty</th>
          <th>Description</th>
          <th class="rcpt-num">Tokens</th>
          <th class="rcpt-num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${(r.items ?? []).map((item) => itemRow(item, digits))}
      </tbody>
    </table>
    <div class="rcpt-total">
      <div class="rcpt-total-label">Total</div>
      <div class="rcpt-total-tokens">${exact(r.totals?.totalTokens)}<span>tokens</span></div>
      <div class="rcpt-total-amount">${fixed(r.totals?.costUsd, digits)}</div>
    </div>
    <div class="rcpt-total-foot">
      ${n(r.totals?.calls)} model calls · ${money(r.totals?.effectiveUsdPerMtok)} per Mtok · ${exact(r.totals?.output)}
      output tokens
    </div>
    <div class="rcpt-drawn">
      <div class="rcpt-section-title">Drawn down from</div>
      ${
        budgets.length
          ? budgets.map((a) => budgetRow(a, r))
          : html`<div class="rcpt-uncapped">No budget governs this person — this spend was never refusable.</div>`
      }
    </div>
    ${
      estimated > 0
        ? html`<div class="rcpt-footnote">
            <i>~</i> ${estimated} of ${n(r.totals?.calls)} calls were priced by estimate, not by a provider-reported
            cost.
          </div>`
        : nothing
    }
  `;
}

function draw(): void {
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "rcpt-layer";
    document.body.appendChild(layer);
  }
  if (!open) {
    render(nothing, layer);
    return;
  }
  const r = receipt;
  render(
    html`<div class="rcpt-backdrop" @click=${(e: MouseEvent) => e.target === e.currentTarget && closeReceipt()}>
      <div
        class="rcpt-paper"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        aria-label=${`Receipt for run ${open}`}
        @keydown=${(e: KeyboardEvent) => trapDialogFocus(e, closeReceipt)}
      >
        <div class="rcpt-actions">
          ${
            r
              ? html`<button
                  class="rcpt-btn"
                  type="button"
                  title="Copy a plain-text receipt"
                  @click=${(e: Event) => void copyText(plainReceipt(r), e.currentTarget as HTMLButtonElement)}
                >
                  ${icon(Copy, 14)}<span>Copy</span>
                </button>`
              : nothing
          }
          <button
            class="rcpt-btn rcpt-close"
            type="button"
            data-dialog-cancel
            aria-label="Close receipt"
            @click=${closeReceipt}
          >
            ${icon(X, 15)}
          </button>
        </div>
        ${
          loading
            ? html`<div class="rcpt-state">Reading the ledger…</div>`
            : failure
              ? html`<div class="rcpt-state rcpt-failure">${failure}</div>`
              : r
                ? receiptBody(r)
                : nothing
        }
      </div>
    </div>`,
    layer,
  );
  if (!loading) layer.querySelector<HTMLElement>(".rcpt-paper")?.focus({ preventScroll: true });
}

export function closeReceipt(): void {
  open = null;
  receipt = null;
  failure = "";
  loading = false;
  draw();
  if (opener?.isConnected) opener.focus();
  opener = null;
}

export async function openReceipt(runId: string, from?: HTMLElement | null): Promise<void> {
  opener = from ?? null;
  open = runId;
  receipt = null;
  failure = "";
  loading = true;
  draw();
  try {
    const loaded = await api<Receipt>(`/api/admin/receipts/${encodeURIComponent(runId)}`).catch((e) => {
      // Without an admin grant the admin route is refused; a person may still read the
      // receipt for their own run, and it is the identical document.
      if (status(e) !== 403 && status(e) !== 401) throw e;
      return api<Receipt>(`/api/receipts/${encodeURIComponent(runId)}`);
    });
    if (open !== runId) return;
    receipt = loaded;
  } catch (e) {
    if (open !== runId) return;
    failure = errMessage(e, "That receipt could not be read.");
  }
  loading = false;
  draw();
}

function status(e: unknown): number | null {
  return e instanceof ApiError ? e.status : null;
}

export async function loadReceipts(opts: { principalId?: string; limit?: number } = {}): Promise<ReceiptRow[]> {
  const qs = new URLSearchParams();
  if (opts.principalId) qs.set("principalId", opts.principalId);
  qs.set("limit", String(opts.limit ?? 8));
  const body = await api<{ receipts?: ReceiptRow[] }>(`/api/admin/receipts?${qs.toString()}`).catch((e) => {
    if (status(e) !== 403 && status(e) !== 401) throw e;
    const self = new URLSearchParams({ limit: String(opts.limit ?? 8) });
    return api<{ receipts?: ReceiptRow[] }>(`/api/receipts?${self.toString()}`);
  });
  return body.receipts ?? [];
}

export function receiptList(rows: readonly ReceiptRow[], opts: { showWho?: boolean } = {}): TemplateResult {
  if (!rows.length) {
    return emptyPlayground(
      "file",
      "No receipts yet",
      "The moment a run spends tokens and lands something, its receipt shows up here.",
    );
  }
  return html`<div class="rcpt-list">
    ${rows.map(
      (row) =>
        html`<button
          class="rcpt-list-row"
          type="button"
          title=${`Open the receipt for ${row.runId}`}
          @click=${(e: Event) => void openReceipt(row.runId, e.currentTarget as HTMLElement)}
        >
          <span class="rcpt-list-mark">${outcomeIcon(row.outcome)}</span>
          <span class="rcpt-list-main">
            <span class="rcpt-list-title">
              ${headline(row.outcome)}${opts.showWho === false ? "" : ` · ${row.displayName ?? row.principalId}`}
            </span>
            <span class="rcpt-list-sub">${row.model} · ${row.harness} · ${tokens(row.totalTokens)} tokens</span>
          </span>
          <span class="rcpt-list-cost">
            ${money(row.costUsd)}${row.estimated ? html`<i class="rcpt-tilde">~</i>` : nothing}
          </span>
          <span class="rcpt-list-when">${stamp(row.at).slice(0, 11)}</span>
        </button>`,
    )}
  </div>`;
}
