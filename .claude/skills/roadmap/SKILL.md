---
name: roadmap
description: Open roadmap issues (#1 observability/Grafana/Alertmanager, #2 ETL stability/integration tests, #3 worker scaling/Etherscan failover, #4 ClickHouse activation, #5 Dagster decision, #6 ops dashboard, #7 structured logging/Loki, #8 backup/DR, #9 frontend graph aggregation/Cytoscape, #10 latest-first ingest with bidirectional fill), smaller refinements (AML Detections UI, E2E tests, auth hardening, rate limiting, secret hygiene, Neo4j migrations, seed data, bundle size, backend typing, ETL gaps, onboarding), and Milestones/removed-tooling history (MinIO, Alertmanager, ingest-builder, process binary, targeted sensors). Invoke when picking up roadmap work, scoping a new issue, or asking why something was removed.
---

## Roadmap — open issues

Discrete, pickup-ready work items. Each has a problem statement, concrete acceptance criteria, and file-level pointers so a teammate can scope and start without a kickoff meeting. Ordered roughly by user-facing value / risk reduction.

---

### #1 — Observability: turn the Grafana / Prometheus / Alertmanager stack on

**Problem.** Prometheus scrapes `worker:9100` and Grafana is provisioned with the `etl-overview` dashboard, but in practice nobody looks at either. Alertmanager was deleted 2026-04-22 because it ran with the null receiver — we need it back with a real routing tree before Phase #3 (scaling workers) lands.

**Acceptance criteria.**
- Grafana home dashboard shows, at a glance: blocks/sec per source, stream lag per consumer group, DLQ depth, Neo4j bolt p95, Postgres connection pool utilisation.
- Prometheus scrapes everything that exposes `/metrics`: `worker`, `clickhouse-process` (Phase #4), backend (add a FastAPI middleware), Dagster webserver (see Phase #5), Redis (via `redis_exporter`), Postgres (`postgres_exporter`), Neo4j (already exposes `/metrics` on 2004).
- Re-introduce Alertmanager with at least three routable rules: DLQ depth > N, stream lag > 5 min, `worker` task C dropped to 0 messages-processed over 10 min. Route to a Slack or Discord webhook (dev) and something escalatable (prod).
- Alert rules version-controlled under `compose/alertmanager/` — do NOT reintroduce the old null-receiver config.

---

### #2 — ETL stability + scale: integration tests, chaos, load profiles

**Problem.** `etl-rs` has unit tests per crate but no end-to-end test that runs `ingest → Redis → worker → Neo4j + Postgres` as a whole. We've had two incidents where a stream consumer silently stalled because an upstream schema drift caused parse failures to accumulate, and neither was caught by `cargo test`.

**Acceptance criteria.**
- Integration test harness under `etl-rs/crates/etl/tests/` that spins up Redis + Postgres + Neo4j via `testcontainers-rs` and exercises: block ingest → stream publish → worker drain → graph + PG assertions. Runs in CI on every push.
- Chaos scenarios: Redis restart mid-batch, Postgres drops the connection during a write transaction, Neo4j returns a transient error. Worker must recover without data loss (idempotency is already built on `MERGE`, so this is mostly about retry / DLQ correctness).
- Load profile: a `cargo bench` target that ingests 10k blocks at fixed concurrency and reports throughput + p99 latency. Commit baseline numbers to `etl-rs/bench/baseline.md` so regressions show up in PR review.
- DLQ inspection CLI: `ingest dlq {list,replay,drop} --stream <name>`. Right now a message in a DLQ is effectively lost — operators need a way to triage.

---

### #3 — Horizontal `worker` scaling + data-source stability

**Problem.** Deep-trace / address-fetch latency is dominated by a single `worker` task A (BRPOP on `ingest:targeted_queue`). One job blocks the next. The Etherscan free-tier limit (5 req/s) is already tight when a single user fires a 2-hop deep trace, and we have no rate-limit coordination across workers.

**Acceptance criteria.**
- `worker` scales to N replicas via `deploy.replicas` in `compose/etl.yml`. Task A uses BRPOP (already safe for multi-reader); task B (refresh loop) needs a distributed lease (Redis `SET NX EX`) so only one replica refreshes at a time; task C (XREADGROUP) is already multi-consumer via the consumer group.
- Pluggable data-source tier: fall back from Etherscan → Alchemy → public RPC when rate-limited or 5xx'd. The `BlockSource` trait exists (`etl-rs/crates/sources/src/lib.rs`) but there's no composite / failover impl — build `FailoverSource`.
- Token-bucket rate limiter shared across worker replicas via Redis (`redis-cell` module or a Lua script). Per-provider budgets, configurable via env.
- Deep-trace UX target: 2-hop trace on a medium-degree address (≤500 neighbours) returns a visible graph delta in ≤5 s p50, ≤15 s p95. Measure via the existing `label_tasks` table — add a `finished_at - pickup_at` histogram to Prometheus.

---

### #4 — ClickHouse activation (OLAP for analytics queries)

**Problem.** `compose/infra.yml` runs ClickHouse, migrations exist at `etl-rs/crates/etl/migrations/clickhouse/`, the `clickhouse-process` binary compiles, but nothing in `docker compose up` actually runs the consumer. Analyst queries like "top 100 CEX counterparties of address X in the last 30 days" are currently impossible without a table scan in Neo4j.

**Acceptance criteria.**
- `clickhouse-process` service added to `compose/etl.yml`, consumer group `chain-analysis-clickhouse` drains `ingested_txs`, `ingested_traces`, `ingested_transfers` into `chain_analysis.transactions / traces / token_transfers`.
- Prometheus scrape job for `clickhouse-process:9100`.
- At least three analytics endpoints exposed from the backend (`/api/analytics/*`): volume-over-time for an address, top counterparties, and per-day tx count histogram. Backed by ClickHouse, not Neo4j.
- Schema migration tooling: ClickHouse migrations currently run once at container init. Wire them into the same Alembic-style "run on every startup" pattern the backend uses, so schema drift is detected in dev.

---

### #5 — Decide Dagster's role (or remove it)

**Problem.** Dagster is dormant. The only thing keeping it alive is `reprocess_job` + `backfill_job`, both manually triggered and both trivially reimplementable as a `ingest reprocess-failed` CLI invocation (which already exists). Meanwhile it consumes ~500 MB of container memory and adds two services to every local stack.

**Acceptance criteria.** Pick ONE of:
- **(a) Commit to Dagster.** Migrate run storage from SQLite → Postgres, scrape `/metrics` into Prometheus, model the always-on stream consumers as assets so lineage shows up in the UI, wire Dagster alerts into the Phase #1 Alertmanager.
- **(b) Remove Dagster.** Delete `compose/dagster.yml`, the `backend/src/etl/` Dagster module, the Rust-builder stage from `backend/Dockerfile`. Replace `reprocess_job`/`backfill_job` with cron-invoked `ingest` CLI runs (or a lightweight `tokio-cron` loop inside `worker`). Update Phase #1 dashboard and Phase N (now #4) accordingly.

Recommendation: (b) unless someone on the team is actively building asset lineage. The current hybrid state is the worst of both worlds.

---

### #6 — Operational dashboard (hard)

**Problem.** Operators currently need three tabs open: Grafana (metrics), Dagster UI (run state), and raw `redis-cli XINFO STREAM`/`LLEN` for queue depth. No single page answers "is the system healthy, and if not, where is the blockage?"

**Acceptance criteria.**
- New `/ops` page in the frontend (admin-gated). Live-updating cards:
  - Data sources: Etherscan / Alchemy health + rate-budget remaining.
  - Queue depths: `ingest:targeted_queue` (LLEN), every `ingested_*` stream (XLEN), every DLQ.
  - Worker fleet: one row per replica, showing heartbeat, messages/sec per task, last-error.
  - Batch pipeline: in-flight `ingestion_runs` + last 10 completed (already exist; just move them here).
  - Storage tier health: Neo4j bolt latency, Postgres pool, Redis memory, ClickHouse (Phase #4).
- Worker heartbeat: add `worker_heartbeat_total{replica="<id>"}` metric + a Postgres `worker_replicas` table that `worker` writes to every 10s. Backend reads the table for the Ops page.
- Everything served from `/api/ops/*` endpoints backed by Prometheus HTTP API (`http://prometheus:9090/api/v1/query`) + direct DB reads. No scraping state in the backend.

This is a multi-week effort — treat it as a separate track from #1 (which sets up the data), not a follow-up.

---

### #7 — Structured system logging

**Problem.** Backend logs via `libs/logger.py` (semi-structured), `etl-rs` via `tracing` (structured), frontend via `console.*` (unstructured). No correlation ID threads across the three. When a user reports "the deep trace didn't finish," there's no way to follow the request from click → API → Redis → worker → Neo4j.

**Acceptance criteria.**
- All services emit JSON logs with a shared schema: `ts`, `service`, `level`, `msg`, `trace_id`, `span_id`, `user_id?`, `request_id?`.
- Frontend generates a `request_id` per user action and threads it through every `fetch` call as `X-Request-Id`. Backend propagates into Redis message payloads (`meta.request_id`). Worker logs it on every stream-message processing log line.
- Centralise logs: Loki + Promtail in the compose stack, dashboard in Grafana next to the Phase #1 metrics. (Do NOT reach for ELK — it's overkill for local dev.)
- OpenTelemetry traces as a stretch goal — start with structured logs + correlation IDs, add `tracing-opentelemetry` + a Jaeger/Tempo backend only if there's demand.

---

### #8 — Data backup + disaster recovery

**Problem.** Neo4j + Postgres + ClickHouse run on named Docker volumes with zero backup. A `docker compose down -v` wipes everything. In prod this is an unacceptable DR posture.

**Acceptance criteria.**
- Nightly backup job (dev: cron container; prod: whatever the deployment target provides):
  - Postgres: `pg_dump -Fc` → compressed archive.
  - Neo4j: `neo4j-admin database dump` → tarball (requires stopping the DB or using online backup on Enterprise — document which).
  - ClickHouse: `BACKUP DATABASE chain_analysis TO Disk('backups')`.
- Retention: 7 daily + 4 weekly, rotation automated.
- Restore runbook in `docs/runbooks/restore.md` with tested commands.
- Quarterly restore drill: spin up a fresh compose stack from yesterday's backups, verify the app boots and `/health` is green. Commit the drill result to `docs/runbooks/drill-log.md`.
- Backup target: an S3-compatible bucket (re-introduces the object store we removed 2026-04-22; that's fine — this is a real need). Encrypt at rest (SSE-S3 or SSE-KMS), short-lived access keys scoped to the backup job only.

---

### #9 — Frontend graph aggregation + UX

**Problem.** `GraphExplorerPage` renders every node + transaction node returned by the backend. Pull in a 2-hop neighborhood of a Binance hot wallet (thousands of neighbours) and Cytoscape chokes — layout takes 10+ s, pan/zoom drops to <10 fps, the panel is unreadable. There's no affordance for "collapse all these smurf EOAs into one group node."

**Acceptance criteria.**
- Auto-aggregation: when a single entity has > N (default 20) neighbours of the same risk_level + entity_type, collapse them into a synthetic "cluster" node that expands on double-click. Cluster nodes render with a count badge.
- Progressive disclosure: on initial neighbour load, show the top 50 by `tx.value`. "Load N more" button, or "Load all (N)" with a confirmation when N > 500.
- Layout strategy per-view: fcose for <200 nodes, concentric / grid for cluster views, dagre for peel-chain detection overlays.
- Transaction-node visual overload: when both edges and tx-nodes are on screen, edges become a blur. Add a view toggle: "Transaction detail" (current behaviour) vs. "Aggregated edges" (collapse tx-nodes into a weighted edge between entities).
- Keyboard shortcuts: `f` = fit, `/` = focus search, `e` = expand selected node, `c` = collapse cluster. Document them in a `?` overlay.
- Performance budget: p95 initial render ≤1 s for a 500-node subgraph on a mid-range laptop. Measure via the React DevTools profiler + Cytoscape's `perf.now()` render hooks; commit numbers to `frontend/perf/baseline.md`.

---

### #10 — User-triggered ingest: latest-first with bidirectional [L, R] fill

**Problem.** `POST /api/pipeline/ingest-address` (Fetch Transactions) and `POST /api/labels/fetch` (Deep Trace) currently let Etherscan default to `sort=asc`, so the first ingest of a whale wallet returns 2017-era txs (oldest 500 within the cap). Users see "ancient activity" instead of "what is this address doing now". The `tx_limit=500` cap from `feature/etl-stability` stops the timeout but doesn't change the chronological direction.

**Proposed scheme.** Track an ingested-block range per address as `(first_synced_block, last_synced_block) = (L, R)`. On each user-triggered ingest:
- If no record: fetch latest 500 (`sort=desc`, no `start`/`end`). Record `L = min(block)`, `R = max(block)`.
- Else, try forward fill: `sort=asc, start_block=R+1, cap=500`. If results, ingest and bump R.
- If forward returned 0, fall back to backward fill: `sort=desc, end_block=L-1, cap=500`. Ingest, lower L. If `L == 1` then fully synced.

Each click costs at most 2 Etherscan calls (forward + maybe backward fallback).

**Acceptance criteria.**
- Alembic migration adds `first_synced_block BIGINT NOT NULL DEFAULT 0` to `entity_features`.
- `etl-rs/crates/etl/src/sources/etherscan/address.rs::fetch_address_transactions` accepts a `sort` parameter (`asc` | `desc`), default preserves current behaviour.
- `effective_from_block` in `etl-rs/crates/etl/src/ingest/targeted.rs` becomes `effective_fetch_window` returning `(sort, start_block, end_block)` based on the per-address [L, R] read from PG.
- `ingest_address_capped` plumbs `sort` through to the source layer; result handler updates both `L = LEAST(existing, batch_min)` and `R = GREATEST(existing, batch_max)` via `postgres_writer`.
- Applies to: `pipeline.py`, `labels.py` deep-trace path, `worker` Task A. **Task B refresh stays on `sort=asc, start=R+1`** — its goal is contiguous catch-up, not latest-first.
- Tests cover three state transitions: first ingest, has-new-txs (forward), no-new-txs (backward fill, `L > 1`), fully-synced (`L == 1`).

**Out of scope.** Frontend "Fetch more" affordance to make the multi-click chain explicit. Good follow-up; not blocking.

**Estimated effort.** ~2 hours including migration + tests. Background context in the 2026-05-08 chat following `feature/etl-stability`'s `tx_limit` cap work.

---

### Other refinements worth picking up

Smaller issues that don't warrant their own phase but shouldn't rot:

- **AML Detections UI** — the Cypher queries in `backend/src/graph/queries.py` (peel chain, structuring, round trip, fan-out/fan-in, mixer interaction) still have no API route and no UI. Build `/api/detections/{pattern}?address=…` endpoints and a Detections tab that highlights matching subgraphs on the Cytoscape canvas. Blocked on #9 if the address has many neighbours.
- **E2E test suite** — no Playwright/Cypress today. Add a smoke journey: login → ingest address → explore → queue label → annotate. Wire into CI alongside `backend/pytest` and `etl-rs/cargo test`. Do this AFTER #9 so selectors don't churn.
- **Auth hardening** — JWT secret is `JWT_SECRET_KEY` env var with no rotation story, tokens live 24 h in `localStorage` (XSS-exfiltratable), no refresh-token flow, no MFA, no password-reset. For a pre-prod tool this is fine; before a real external user touches it, at minimum: rotate-on-deploy, httpOnly cookies, short access + long refresh.
- **API rate limiting** — `/api/pipeline/ingest-address` and `/api/labels/tasks` are unauthenticated against abuse. One user with a loop can saturate the Etherscan budget. Add `slowapi` or equivalent, per-user limits backed by Redis.
- **Secret hygiene** — `.env.example` has real defaults (`password123`, `clickhouse123`). Move all "local dev only" secrets to a single `compose/secrets.dev.env` that's `.gitignore`'d, and fail-fast in prod if any default leaks in.
- **Schema migrations for Neo4j** — `init_neo4j.py` is the current source of truth but runs idempotently on every boot. A real versioned migration system (e.g. `neo4j-migrations`) would make schema changes reviewable. Low priority until schema churns again.
- **Seed data realism** — `scripts/seed_neo4j.py` now uses real mainnet txs (rewrite 2026-04-22) but the old synthetic peel-chain / fan-out / TC-group patterns went away with it. The AML detection queries above won't light up on the new seed. Either re-add a small synthetic "laundering-demo" subgraph under a distinct `:Demo` label, or ingest a known real-world incident (e.g. the Ronin exploiter's peel chain) as part of the demo bootstrap.
- **Frontend bundle size** — `Cytoscape` + `fcose` + `react-router` + Tailwind JIT = ~800 kB gzipped. Code-split the Graph page; lazy-load Cytoscape on route entry.
- **Backend typing** — `backend/src/api/routes/*` has inconsistent Pydantic response-model coverage. Audit and enforce `response_model=` on every route so the OpenAPI schema is trustworthy.
- **ETL observability gaps** — `worker` task B (refresh loop) has no metrics at all. Task A doesn't record "time from enqueue to pickup." Add these in lockstep with #3.
- **Developer onboarding** — first-run setup is "docker compose up" but an Etherscan key is required for anything meaningful. Add a `make bootstrap` that walks through key provisioning, seeds a realistic dataset, and opens the UI.

---

## Milestones — removed tooling

| Date | Tool | Reason |
|---|---|---|
| 2026-04-22 | MinIO object store + `minio-init` | Cold-tier Parquet export (old Phase K) never built; three-tier → two-tier. Re-introduce an object store when ML training / compliance retention lands. |
| 2026-04-22 | Alertmanager + `alerts.yml` | Ran with the null receiver; never routed a real alert. Prometheus alone is sufficient for local dev. |
| 2026-04-22 | `ingest-builder` one-shot + `rust_bin` volume | Rolled into the Dagster image via multi-stage COPY in `backend/Dockerfile`. |
| Phase I    | `process` binary | Absorbed into `worker` task C. |
| Phase I    | `targeted_queue_sensor`, `targeted_drain_job` | Replaced by `worker` task A. |
