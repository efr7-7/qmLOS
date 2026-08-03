# Workforce metering and EU compliance

LOS meters AI usage attributed to named employees. That is powerful and, handled
carelessly, legally dangerous in the EU. This page states what LOS collects, the
defaults that keep deployments defensible, and the operator's obligations.

## What the ledger contains — and what it never contains

Every row is metadata: timestamp, principal, scope, model, phase, source, token
counts, cost. The ledger never stores prompt or response content. The OTel
ingestion endpoint (`/v1/ingest/otel`) extracts the same metadata fields from
external telemetry and discards everything else.

## Product defaults (worker-protective by design)

- **Self-view first.** Every person can see their own meter at `GET /v1/usage`,
  which returns the same values the admin drill-down
  (`GET /v1/admin/utb/people/:id`) returns about them: total spend and the folded
  token totals, the model / phase / harness / source breakdowns, the outcome mix,
  the cost-per-outcome ratio, the team chain, last-active, and every allocation
  governing them. Per-run detail has the same shape: `GET /v1/receipts/:runId` is
  self-scoped and returns the identical document the admin route returns, for the
  caller's own runs.

  This is not a policy statement. `test/governance-endpoints.test.ts` asserts the
  two responses are equal field by field — enumerating the admin response's
  dimensions rather than a fixed list, so a newly added admin-only metric fails
  the build rather than slipping through — and asserts that a person's receipt
  equals the admin's receipt for the same run. Transparency to the data subject is
  the foundation of GDPR Art. 5(1)(a) and Art. 88 workplace processing.

  **Scope of the guarantee.** It covers the metered record of a person's own work.
  It does not cover org-wide aggregates, other people's rows, the cross-person
  leaderboard, or administrative facts about grants and roster state — those are
  admin surfaces by design. If you extend LOS with a new per-person metric, that
  test is where you keep this promise true.

- **Team-level ranking by default.** The leaderboard aggregates to teams unless
  the operator explicitly sets `UTB_LEADERBOARD=named`. Ranking identified
  individuals by productivity metrics is the configuration most likely to
  require works-council agreement (e.g. German BetrVG §87(1)(6) — technical
  systems capable of monitoring performance) and a DPIA; make that a conscious,
  documented decision, not a default.
- **Reading someone else is admin-gated and audited.** Reading another person's
  usage or receipts requires a scoped admin grant, and the read itself lands in
  the audit log (`utb.read`, `utb.leaderboard.read`, `fleet.read`,
  `receipts.read`), so oversight is itself overseen. A person reading their own
  meter or their own receipt needs no grant, and is recorded separately
  (`receipts.self.read`).

  Be aware that the drill-down and the per-run receipt do include
  productivity-shaped metrics — outcomes produced and cost-per-outcome — which is
  precisely why the same values are available on the person's own meter and their
  own receipts. `UTB_LEADERBOARD=named` governs _cross-person ranking_, not the
  existence of these per-person metrics; if your works-council agreement turns on
  whether individual performance data exists at all, this is the section to read
  to them.

- **Shared-channel disclosure is blocked.** Per-principal spend endpoints are on
  the capability-token denial list for shared scopes — an agent cannot be
  tricked into posting someone's spend into a channel.
- **Budgets refuse turns; they do not report people.** Hard allocations act on
  the request, not the person; soft ones warn operators.

## Operator obligations (not optional in the EU)

1. **Inform employees before deployment**: what is metered, why (cost
   allocation and capacity planning are legitimate interests; covert
   performance evaluation is not), retention, and who can see what. Update the
   privacy notice / Art. 13 information.
2. **Involve the works council where one exists** before enabling
   `UTB_LEADERBOARD=named` or using ledger data in any evaluation context.
3. **Run a DPIA** if usage data will feed decisions about individuals
   (Art. 35 — systematic monitoring).
4. **Retention**: set the retention policy for `token_ledger`, `run_outcomes`,
   and the audit log to what your notice states. Cost data rarely needs
   identified retention beyond 12–24 months; aggregate afterwards.
5. **AI Act Article 12/26**: for high-risk uses, deployers must retain
   automatically generated logs. `GET /v1/admin/audit/export` produces the
   lifecycle log export; ledger and audit rows carry timestamps and actor
   identity for traceability.

## The stance in one sentence

Meter the work, not the worker: spend attribution exists to allocate budgets
and prove value, employees always see their own data first, and any
configuration that ranks named individuals is an explicit, documented,
works-council-cleared choice.
