# ADR: Unified Token Budget (UTB) — enterprise token governance, attribution, and efficiency leaderboards

Status: proposed
Date: 2026-08-01

## Problem

Per-token prices keep falling while tokens-per-task explodes (agentic pipelines,
context accumulation, retries, tool-description overhead, frontier-model
misallocation). The result is the now-familiar enterprise paradox: cheaper tokens,
bigger bills. QM already meters spend, but coarsely:

- Every harness adapter normalizes exact per-call usage into `LlmCallUsage`
  (`src/sessions/session-store.ts:109`): `input`, `output`, `cacheRead`,
  `cacheWrite`, `totalTokens`, `costUsd`. This is the ground truth — and today it
  is mostly discarded for accounting purposes.
- `BudgetTracker` (`src/ratelimit/budget.ts`, `src/ratelimit/postgres-budget.ts`)
  tracks a rolling USD window for `principalId` plus a single `@org` key. Cost is
  *estimated* from input tokens at one flat USD/MTok rate
  (`estimateCostUsd(rec.inputTokens)` at `src/core/orchestrator.ts:1528` and
  friends) — output tokens, cache economics, and the actual per-model price are
  ignored, even though harnesses report exact `costUsd`.
- `ModelGateway` (`src/model/model-gateway.ts`) records `{model, inputTokens}`
  per call in a 1,000-entry in-memory ring — no durability, no output tokens.
- `MetricsSink` (`src/admin/metrics-sink.ts`) keeps per-turn latency/cache
  samples; the Postgres variant is durable but has no cost dimensions.
- The directory (`src/directory/`) maps people to Slack/web principals; there is
  **no team/org-unit hierarchy** anywhere in core.

So: the org can cap spend per person and org-wide per day, but cannot answer
"which team spent what, on which models, for which kind of work, and what did we
get for it?" — let alone enforce those answers before the spend happens.

## Decision

Introduce a first-class **Unified Token Budget** subsystem (`src/budget/`) with
four parts: a durable **ledger**, a hierarchical **allocation model**, a
**pre-spend authorization gate**, and an **attribution/leaderboard** layer.

### 1. Token ledger (ground truth, durable)

A Postgres-backed append table `token_ledger`, one row per model call:

```
at, org_id, principal_id, team_id, scope_id, session_id, run_id, harness_id,
model_id, provider, tier, input_tokens, output_tokens, cache_read, cache_write,
cost_usd, phase (turn|detect|compact|screen|cron|watch), origin_kind
```

Wiring: the orchestrator already has the values in hand at every
`recordModelCall` site — replace the four `estimateCostUsd` call sites with a
single `ledger.record(...)` that receives the full `LlmCallUsage` from the
harness (fall back to catalog pricing from `src/model/model-catalog.ts` only
when a harness reports `costUsd: 0`, as codex does). The existing
`BudgetTracker` becomes a thin read over the ledger, preserving its interface
so `orchestrator.ts:328` (`budget.check`) keeps working.

Aggregation: a `token_ledger_rollup` materialized hourly per
(day, team, principal, model, phase) keeps dashboard queries O(small).

### 2. Teams and hierarchical allocations

Add `team_id` to the directory (`src/directory/directory-store.ts`): teams are a
flat table `teams(id, name, parent_id)` giving an org tree; each person gets an
optional `teamId`. Admin CRUD lives under the existing scoped-admin routes
(`src/api/routes/admin/users.ts` pattern).

Budget allocations become a tree that mirrors it:

```
allocations(id, subject: org|team:<id>|principal:<id>, window: day|week|month,
            limit_usd, limit_tokens, model_class_limits jsonb, hard: bool)
```

Semantics: a spend must fit within *every* enclosing allocation (principal →
team → parent team → org). `model_class_limits` lets an org ration frontier
tokens specifically (e.g. `{"frontier": {"limit_usd": 50}}`) — the single
highest-leverage control, given how much waste is frontier-model misallocation.
Soft limits warn (delivery via existing notifier plumbing); hard limits refuse
the turn exactly like today's `block("over-budget")`.

### 3. Pre-spend authorization (governance before the invoice)

The lesson from the token-paradox literature: reporting after the fact is not
governance. Two additions:

- **Model-routing policy per allocation**: an optional `routing` field —
  `{"default": "budget-tier", "frontier_requires": "justification"}`. When a
  turn requests a frontier model outside its allowance, core either downgrades
  (configurable) or pauses with the same approval machinery the Strict posture
  already uses for tool calls (`src/api/routes/turns.ts` approvals) — the user
  supplies a one-line justification which lands in the audit log.
- **Turn cost preflight**: before dispatch, estimate the turn's context size
  (session token counts are already tracked per session) and refuse/warn when a
  single turn would exceed a per-turn ceiling — this catches context-accumulation
  and retry-loop blowups at the door instead of on the invoice.

### 4. Attribution and the efficiency leaderboard

Every run already ends with a delivery and an audit trail. Add a lightweight
**outcome classifier** that tags each run with what the work *produced*:

- `code-pushed` — sandbox git activity is already brokered
  (`src/api/git-http-broker.ts`); a push through the broker tags the run.
- `sent-internal` — delivery to a Slack channel/group or shared scope.
- `doc/artifact` — file artifact persisted or web app deployed.
- `research` — read-heavy runs (web fetches, connector reads, no artifact).
- `chat` — none of the above.

Classification is mostly *mechanical* (derived from tool/delivery events, not an
LLM), so it costs zero tokens for the common cases; an optional cheap-model
classifier (the `src/classify` machinery exists) can refine ambiguous runs.
Project attribution rides the same rails: runs in a project scope inherit the
project id; personal-scope runs get a nullable `project_id` refined by the same
classifier against the org's declared project list. That gives the org the
"is this work on internal projects?" signal as an *aggregate* (per team,
per project, percentage unattributed) — surfaced in the admin panel, with the
run-level drill-down already gated behind the existing scoped-admin + audit
mechanism, so looking at an individual's runs itself leaves an audit trail.
(Employees can see their own attribution; org-level metrics are aggregates
first. Surveillance-shaped features earn trust only when they are symmetric
and auditable.)

**Leaderboard** (admin panel + optional org-visible page): per team and per
person over a window —

- tokens and USD per *outcome* (not per message): cost per merged push, per
  shipped artifact, per research brief
- efficiency score: outcome-weighted output per frontier-tier token
- cache hygiene: cache-read share (already computable via `cacheHitRatio`,
  `src/admin/metrics-sink.ts:40`)
- misallocation index: share of tokens on frontier models for runs classified
  `chat`/`sent-internal`
- retry overhead: tokens in runs that ended `refused`/`error`/aborted

### Surfaces

- Admin panel (`plugins/admin`): budgets tree editor, live burn-down per
  allocation, leaderboard, misallocation report.
- Web UI: a personal "usage" pane (own spend vs allocation, own efficiency) —
  people should see their own meter before the meter is used to rank them.
- Slack: budget warnings as DMs via existing delivery plumbing; `/qm usage`.
- API: `/v1/admin/utb/*` read endpoints following the observability route
  pattern (`src/api/routes/admin/observability.ts`).

## Consequences

- The flat-rate `estimateCostUsd` path dies; accounting becomes exact where
  harnesses report cost and catalog-priced where they don't.
- New tables: `teams`, `allocations`, `token_ledger`, `token_ledger_rollup`,
  `run_outcomes`. All follow the existing `createPgPool` bootstrap-DDL pattern.
- In-memory fallbacks (dev mode) mirror today's memory/postgres store split, so
  the feature degrades gracefully without `DATABASE_URL`.
- The approval-based frontier gate reuses Strict-posture machinery rather than
  inventing a second pause path.
- Privacy stance: outcome classification is metadata-only (event kinds, not
  content); individual drill-down is admin-scoped and audited; aggregates are
  the default view.

## Benchmark: rival Ramp's AI cost monitoring, structurally better

Ramp's product (ramp.com/ai-cost-monitoring) attributes spend by provider,
model, user, API key, and department; shows a unified dashboard with $/MTok and
trends; alerts on spikes with per-key monthly caps and weekly briefings; and
benchmarks per-employee-per-month (PEPM, their 2026 median: $46). Its ceiling
is architectural: it ingests **provider admin-API metadata after the fact**, so
it can only observe and notify — a cap in Ramp is an email, not a stop.

LOS sits in the execution path, which yields three structural advantages:

1. **Enforcement, not observation.** Budgets here refuse the turn
   (`block("over-budget")`), gate frontier models behind justification, and
   preflight per-turn cost — Ramp's "per-workflow cost ceilings" recommendation,
   implemented as an actual ceiling.
2. **Ground-truth attribution.** Ramp bottoms out at API key/user. The ledger
   records run, session, phase, and (phase 3) outcome — cost per merged PR, per
   research brief, per shipped artifact. Cost-per-workflow is native, not
   inferred from key naming conventions.
3. **Cache economics per call.** Ramp recommends "implement caching (5×)";
   the ledger's cacheRead/cacheWrite per call makes cache hygiene a measurable,
   rankable metric (`cacheReadShare` in `/v1/admin/utb`).

Parity items to match outright: spike/anomaly alerts and weekly briefings
(phase 2 delivery-plumbing digests — LOS can generate them agentically, with
narrative), PEPM normalization (directory headcount / ledger spend), and
cheaper-model suggestions (phase 4 routing policy reports). Ramp's one real
edge — visibility into AI spend *outside* the platform (Cursor seats, direct
API keys, subscriptions) — is closed in phase 5 with provider admin-API
ingestion connectors (OpenAI/Anthropic/Gemini usage APIs) merging external
usage rows into the same ledger under `origin: external`, giving one pane for
both governed and ungoverned spend, something Ramp cannot reciprocate.

## Phasing

1. Ledger + exact costs + per-model dimension (replace estimate sites). Small,
   immediately useful, no schema politics.
2. Teams + allocation tree + hard/soft enforcement in `budget.check`.
3. Mechanical outcome tagging + rollups + admin dashboards/leaderboard.
4. Routing policy + frontier justification approvals + turn cost preflight.
5. Optional classifier refinement + project attribution reports.
