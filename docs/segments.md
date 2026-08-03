# Running LOS at your size

LOS runs the same binary for one person and for a thousand. What changes is which
knobs you set and which pages you should ignore. Three playbooks follow — every
env var and endpoint named here exists today in `src/config.ts`, `.env.example`,
or the route tables under `src/api/routes/`.

Whatever your size, you may set `LOS_PROFILE=solo|team|org`. It is advisory
metadata only: it changes no behavior in core, but it is surfaced as `profile`
in `GET /v1/surface-config` so surfaces can adapt their presentation. The web
UI's Usage page additionally adapts on observed headcount (from
`GET /v1/admin/utb`), so a solo instance gets the solo view even without the
profile set.

## Solo founder

You are the org. Run light, meter yourself, skip everything built for other
people.

```bash
HARNESS=claude
ANTHROPIC_API_KEY=sk-ant-...
ORG_ID=me
PORT=8080
LOS_PROFILE=solo
BUDGET_USD_PER_WINDOW=25
BUDGET_WINDOW_MS=86400000
ADMIN_GRANTS=you:org_admin
```

- **Run in-memory.** `SESSION_STORE` and `RUN_STORE` default to `memory` — no
  database, no setup, sessions vanish on restart. That is the right trade until
  you need durability; then set `SESSION_STORE=postgres`, `RUN_STORE=postgres`,
  and `DATABASE_URL`. (There is no SQLite tier — it was removed; memory or
  Postgres are the two stores.)
- **Personal budget as a circuit breaker.** `BUDGET_USD_PER_WINDOW` caps your
  own spend per window (`BUDGET_WINDOW_MS`, default one day). Set it to the
  number that would make you wince, not the number you expect.
- **Meter your Claude Code sessions too.** Point Claude Code's OTLP export at
  LOS and your terminal usage lands in the same ledger as your LOS usage:
  `POST /v1/ingest/otel` accepts OTLP JSON (aliases
  `/v1/ingest/otel/v1/traces` and `/v1/ingest/otel/v1/logs`). It reads
  `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, cache
  token attributes, and attributes you to `los.principal_id` or `user.email`.
  Rows are recorded with phase `external` and the exporter's `service.name` as
  the source, so the Usage page shows the split.
- **What to ignore:** teams (`/v1/admin/utb/teams`), the leaderboard,
  `UTB_LEADERBOARD`, `ORG_BUDGET_USD_PER_WINDOW` (redundant with your personal
  budget when headcount is 1), works-council concerns, chargeback exports. The
  web UI already hides PEPM and the leaderboard and relabels the org section
  "Everything you've spent" when headcount is 1.
- **Want to poke it with zero setup?** `LOS_DEMO=1` seeds an empty instance
  with demo teams, allocations, and 30 days of usage; `WEB_UI_DEMO=1` lets the
  web UI treat unauthenticated visitors as the demo principal. Local demos
  only.

## Team of 2–5

Small enough that everyone knows everyone; big enough that "who spent what"
becomes a real question. Add structure, keep it civil.

```bash
HARNESS=claude
ANTHROPIC_API_KEY=sk-ant-...
ORG_ID=acme
LOS_PROFILE=team
SESSION_STORE=postgres
RUN_STORE=postgres
DATABASE_URL=postgres://...
BUDGET_USD_PER_WINDOW=25
ORG_BUDGET_USD_PER_WINDOW=100
ADMIN_GRANTS=alice:org_admin
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

- **Teams.** Create them via `PUT /v1/admin/utb/teams` with
  `{ "id": "platform", "name": "Platform", "members": ["alice", "bob"] }`.
  Team rollups then appear in the leaderboard and chargeback exports.
- **Hard allocations.** `PUT /v1/admin/utb/allocations` with
  `{ "id": "platform-monthly", "subject": "team:platform", "limitUsd": 250,
  "windowMs": 2592000000, "hard": true }`. Subjects are `org`, `team:<id>`, or
  `principal:<id>`. Hard allocations refuse the turn at the cap; soft ones
  warn. `ORG_BUDGET_USD_PER_WINDOW` is the blunt org-wide backstop underneath.
- **Leaderboard etiquette.** The leaderboard
  (`GET /v1/admin/utb/leaderboard`) aggregates to teams by default and ranks
  by cost per outcome, not raw spend. Leave `UTB_LEADERBOARD` unset. Even at
  five people, `UTB_LEADERBOARD=named` ranks identified individuals — in the
  EU that is the configuration most likely to require works-council agreement
  and a DPIA (see [compliance.md](compliance.md)). At 2–5 you rarely need it:
  you can just ask.
- **Slack surface.** Set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (the default
  socket mode needs both) and the agent lives where the team already talks. Everyone still
  sees their own complete meter at `GET /v1/usage`.

## Enterprise

Everything explicit, everything durable, every read audited.

```bash
NODE_ENV=production
HARNESS=pi
ORG_ID=bigcorp
LOS_PROFILE=org
SESSION_STORE=postgres
RUN_STORE=postgres
DATABASE_URL=postgres://...
SANDBOX_BACKEND=aws
CORE_SIGNING_SECRET=...
CAPABILITY_SECRET=...
PORTAL_IDENTITY_SECRET=...
REQUIRE_SIGNED_PORTAL_IDENTITY=1
ORG_BUDGET_USD_PER_WINDOW=5000
ADMIN_GRANTS=platform-lead:org_admin
```

- **Postgres, explicitly.** Production refuses to guess: `NODE_ENV=production`
  requires an explicit `SANDBOX_BACKEND`, and you want `SESSION_STORE`,
  `RUN_STORE`, and `DATABASE_URL` set rather than defaulted.
- **Signed portal identity.** `PORTAL_IDENTITY_SECRET` plus
  `REQUIRE_SIGNED_PORTAL_IDENTITY=1` makes the core reject any portal identity
  that is not HMAC-signed — the portal (or your identity provider integration
  in front of it) becomes the only door. See
  [getting-started.md](getting-started.md) for the deploy path, including
  swapping the built-in email-link `auth` broker for an external identity
  provider.
- **Audit export.** `GET /v1/admin/audit/export?since=<ms>` streams NDJSON of
  the audit log — the lifecycle log retention that AI Act Article 12/26
  deployers need. Reads of individual usage are themselves audited
  (`utb.read`, `utb.leaderboard.read`).
- **The `UTB_LEADERBOARD=named` decision.** Default is team-level. Flipping to
  `named` ranks identified employees and is exactly the kind of technical
  performance monitoring that triggers works-council co-determination (German
  BetrVG §87(1)(6)) and a DPIA. Make it a documented decision with the works
  council signed off before the env var changes — the full obligations list is
  in [compliance.md](compliance.md).
- **Chargeback CSV to finance.** `GET /v1/admin/utb/chargeback?since=<ms>`
  returns `team,principal,calls,input_tokens,output_tokens,cache_read,
  cache_write,cost_usd,estimated_calls` — one file finance can pivot on,
  attributed to the teams you defined above.
- **Fleet-wide ingest.** The same `POST /v1/ingest/otel` endpoint aggregates
  every engineer's Claude Code telemetry into one org ledger, so the PEPM
  number on the Usage page reflects terminal usage, not just LOS surfaces.
