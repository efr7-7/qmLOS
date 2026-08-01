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

- **Self-view first.** Every person can see their own complete meter
  (`GET /v1/usage`) — the same numbers any admin would see about them.
  Transparency to the data subject is the foundation of GDPR Art. 5(1)(a) and
  Art. 88 workplace processing.
- **Team-level ranking by default.** The leaderboard aggregates to teams unless
  the operator explicitly sets `UTB_LEADERBOARD=named`. Ranking identified
  individuals by productivity metrics is the configuration most likely to
  require works-council agreement (e.g. German BetrVG §87(1)(6) — technical
  systems capable of monitoring performance) and a DPIA; make that a conscious,
  documented decision, not a default.
- **Individual drill-downs are admin-gated and audited.** Reading a person's
  usage requires a scoped admin grant, and the read itself lands in the audit
  log (`utb.read`, `utb.leaderboard.read`, `fleet.read`), so oversight is
  itself overseen.
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
