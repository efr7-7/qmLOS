# ADR: AI observability strategy — own the ledger, speak OTel, score value

Status: proposed
Date: 2026-08-01

## Context

Deep evaluation of Portkey (acquired by Palo Alto Networks, May 2026), Langfuse
(acquired by ClickHouse, Jan 2026), and Braintrust against LOS's token ledger
and governance layer. Full findings in the research record; decisions below.

## Decisions

### 1. The ledger stays native and synchronous

Hard budget enforcement needs a transactional check in the request path.
Langfuse's pipeline is deliberately async/eventually-consistent (SDK batching →
S3 → Redis → ClickHouse, minutes of lag on some paths) and has no enforcement
primitives; Portkey enforces only at integration×workspace granularity, and its
budget/analytics control plane is SaaS even in "self-hosted" enterprise mode —
now with acquisition risk. LOS's per-call ledger with principal/scope/phase
attribution is strictly finer than either. It is the moat; do not outsource it.

### 2. Emit OpenTelemetry GenAI spans (the strategic interop play)

Add an optional OTLP exporter: every model call and turn becomes an OTel span
following GenAI semantic conventions, with LOS attributes (principal, scope,
phase, run, session, harness) mapped to span attributes. Enterprises point
`OTEL_EXPORTER_OTLP_ENDPOINT` at whatever they already run — self-hosted
Langfuse (generic OTLP backend at /api/public/otel), Datadog, Grafana, Portkey.
This turns every observability vendor into an LOS feature instead of a
competitor, and "works with your existing observability stack" is the enterprise
procurement checkbox. Do NOT embed Langfuse (welds ClickHouse+Redis+S3+Postgres
into the install footprint — often bigger than LOS itself); document a
"Langfuse quickstart" pointing at their MIT Compose file instead.

### 3. Steal Portkey's governance patterns for UTB phases 2–4

- Budget exhaustion flips key/allocation state (O(1) hot-path check), alerts
  fire at thresholds before the hard stop.
- Credential indirection: one physical provider credential → many virtual
  providers per scope, each carrying budget/rate/model-allowlist constraints.
- Metadata as both analytics dimension AND routing predicate (scope/phase can
  drive model selection, not just attribution).
- Gateway-feature provenance in ledger rows: record cache hit/miss, retry
  count, fallback fired — so the ledger can answer what resilience machinery
  costs and saves.
- Guardrail verdict taxonomy: async-advisory vs sync-blocking checks, distinct
  statuses for "failed-open" vs "blocked", verdict-as-routing-signal.

### 4. Embed Braintrust's autoevals (MIT) to score value, not just cost

Cost dashboards without quality signals optimize the wrong thing. autoevals is
MIT, standalone, judge-model pluggable via any OpenAI-compatible endpoint — so
judge calls route through LOS's own configured provider and get metered on the
same ledger. Plan:

- Sampled online scoring of agent runs (LLM-as-judge + heuristic scorers),
  uniform `{name, score 0-1, metadata}` result shape.
- Leaderboard headline metric becomes **value per token**: outcome-weighted
  quality score ÷ cost, not raw spend. Cache hygiene and misallocation stay as
  secondary metrics.
- Human review queue (lightweight) to calibrate judge scores before the
  leaderboard is trusted for anything consequential.
- Flag-a-run → promote to benchmark dataset → replay against future
  configurations: turns the ledger from accounting into an optimization loop.

### 5. Sequencing

OTel exporter and autoevals sampling ride UTB phase 3 (outcome classification);
Portkey-pattern virtual-credential budgets land with UTB phase 2 (allocation
tree). No new stateful infrastructure in any phase — Postgres remains the only
required store.
