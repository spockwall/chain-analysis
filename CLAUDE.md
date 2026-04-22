# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Project Overview

Chain-Analysis is a blockchain transaction analysis platform for detecting and investigating money laundering patterns on Ethereum and EVM-compatible chains. The system models blockchain entities as a property graph, enables human analysts to label suspicious activity, and provides a visual interface for exploring transaction flows.

## Technology Stack

**Backend (Python):**
- FastAPI (REST API), Dagster (dormant — only `reprocess_job` + `backfill_job`; targeted ingestion goes through the Rust `worker`)
- Neo4j 5.x + GDS plugin: Graph database with Cypher queries
- PostgreSQL 17: Entity features, ingestion run history, labeling workflows
- Redis Streams: Message queue for decoupling ingestion
- SQLAlchemy (async) + asyncpg + Alembic: PostgreSQL ORM and migrations
- JWT auth: `python-jose`, stored in `localStorage`, 24h expiry

**Frontend:**
- React 18 + TypeScript (Vite)
- React Router v6: URL-based page routing
- Cytoscape.js for graph visualization (fcose layout)
- Tailwind CSS v3: Utility-first styling

**Data Sources:**
- Etherscan API (primary): Address transaction history via `txlist` + `txlistinternal`
- Etherscan API (Rust `ingest`): Block-range ingestion via proxy API; falls back to deterministic mock data when no API key is set

## Project Structure

```
chain-analysis/
├── docker-compose.yml          # Neo4j, Postgres, Redis, ClickHouse, Backend, Frontend + optional profiles
├── .env.example                # Environment variables template
├── etl-rs/                     # Rust ETL workspace (see Rust section below for crate list)
│   ├── Cargo.toml              # Workspace manifest
│   └── crates/                 # types, config, sources, sinks, pipeline, consumer, ingest, worker, clickhouse
├── scripts/                    # Utility scripts (run by backend entrypoint on startup)
│   ├── init_neo4j.py           # Creates Neo4j constraints + indexes (idempotent)
│   ├── seed_neo4j.py           # Seeds sample Transaction nodes and entities
│   ├── seed_known_labels.py    # Seeds PostgreSQL known_labels table
│   └── seed_users.py           # Seeds default auth users
├── docs/
│   └── etl-ts.md               # Full demo and operations guide
├── backend/
│   ├── pyproject.toml          # Python deps (uv)
│   ├── alembic.ini             # Alembic config (uses async asyncpg driver)
│   ├── alembic/env.py          # Async Alembic runner (asyncio + create_async_engine)
│   ├── entrypoint.sh           # Container startup: migrations → seeds → uvicorn
│   ├── Dockerfile              # Multi-stage build; build context is repo root
│   └── src/
│       ├── api/
│       │   ├── main.py         # FastAPI app + lifespan
│       │   ├── models/         # Pydantic response models
│       │   └── routes/
│       │       ├── auth.py      # JWT login/register/me (HTTPBearer)
│       │       ├── entities.py  # Entity CRUD + neighbors + paths + transactions + group members
│       │       ├── features.py  # GET/PUT /entities/{address}/features (entity_features table)
│       │       ├── groups.py    # Group entity CRUD (list, create, get, patch, delete)
│       │       ├── health.py    # /health + /health/live + /health/ready
│       │       ├── ingestion.py # GET /ingestion-runs (read-only run history)
│       │       ├── labels.py    # Labeling workflow: tasks + annotations
│       │       ├── pipeline.py  # POST /pipeline/ingest-address (Etherscan → Neo4j + PG)
│       │       └── stats.py     # Graph stats (node_count, transaction_count, edge_count, ...)
│       ├── core/
│       │   ├── config.py       # Settings (Pydantic BaseSettings, @lru_cache)
│       │   ├── ports/
│       │   │   └── graph_db.py # GraphDatabase protocol + Node/Transaction/Path/Subgraph dataclasses
│       │   └── adapters/
│       │       ├── neo4j_adapter.py    # Neo4j implementation
│       │       ├── postgres_adapter.py
│       │       └── redis_adapter.py
│       ├── services/
│       │   └── auth.py         # Password hashing, JWT token creation/decode
│       ├── libs/
│       │   └── logger.py       # Structured logging setup
│       ├── etl/                # Dagster assets, resources, jobs (optional)
│       ├── graph/
│       │   └── queries.py      # AML detection Cypher queries
│       └── db/                 # SQLAlchemy models + Alembic migrations
└── frontend/
    ├── Dockerfile
    ├── tailwind.config.js      # Tailwind config with custom keyframes (toast-slide-in, slide-in)
    └── src/
        ├── App.tsx             # App shell: AuthProvider + ToastContext + React Router + ProtectedRoute
        ├── context/
        │   ├── ToastContext.tsx # Global toast context
        │   └── AuthContext.tsx  # Auth state (login/logout/register, JWT token management)
        ├── hooks/
        │   ├── useToast.ts     # Toast state manager
        │   ├── useGraphStats.ts
        │   └── useHealth.ts
        ├── components/         # GraphCanvas, NodePanel, TxPanel, SearchBar, Nav, CopyButton, etc.
        ├── pages/
        │   ├── HomePage.tsx
        │   ├── LoginPage.tsx          # JWT login form
        │   ├── SignupPage.tsx         # User registration form
        │   ├── GraphExplorerPage.tsx  # Search, path finder, filter panel
        │   ├── GroupsPage.tsx         # Group management
        │   ├── ETLPage.tsx            # Ingestion trigger, run history, entity features lookup
        │   ├── LabelsPage.tsx         # Queue targeted-fetch jobs + analyst annotation form
        │   └── DashboardPage.tsx      # System health + graph stats
        ├── api/client.ts       # Fetch wrappers for all backend endpoints
        ├── types/index.ts      # TypeScript interfaces
        └── index.css           # CSS reset, design tokens (:root), grid-bg, app-shell, scrollbar
```

## Development Commands

```bash
# Start all services (runs migrations + seeds automatically via entrypoint.sh)
docker compose up -d

# Rebuild a specific service after code changes
docker compose build backend && docker compose up -d backend
docker compose build frontend && docker compose up -d frontend

# Frontend dev (from frontend/)
npm install
npm run dev                     # Vite dev server on :5173, proxies to localhost:8000

# Backend dev (from backend/)
uvicorn src.api.main:app --reload --port 8000

# Testing
pytest                          # Backend tests (from backend/)
```

## Architecture Notes

### Neo4j Graph Schema (Transaction-as-Node)

**Pattern:** `(from:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(to:Entity)`

**Entity Node Labels:** `:Entity` (base), `:EOA`, `:Contract`, `:Mixer`, `:LendingPool`, `:Bridge`, `:DEX`, `:CEXHotWallet`, `:Application`

**Transaction Node Properties:** `hash` (UNIQUE), `value` (wei str), `block_number`, `timestamp`, `gas_used`, `gas_price` (wei str), `from_address`, `to_address`

**Trace Node Properties:** `uid` (UNIQUE), `transaction_hash`, `block_number`, `from_address`, `to_address`, `value`, `call_type`

**TokenTransfer Node Properties:** `uid` (UNIQUE), `transaction_hash`, `block_number`, `token_address`, `from_address`, `to_address`, `amount`

**Group Membership:** `(member:Entity)-[:IN_GROUP]->(group:Entity)` — flat set, no hierarchy. Groups are flagged with `is_group = true` on the Entity node.

**Key Constraints & Indexes:**
```cypher
-- Entity
CREATE CONSTRAINT entity_address FOR (e:Entity) REQUIRE e.address IS UNIQUE;
CREATE INDEX entity_type FOR (e:Entity) ON (e.entity_type);
CREATE INDEX entity_risk FOR (e:Entity) ON (e.risk_level);
CREATE FULLTEXT INDEX entity_name_search FOR (e:Entity) ON EACH [e.name, e.label];

-- Transaction
CREATE CONSTRAINT tx_hash FOR (t:Transaction) REQUIRE t.hash IS UNIQUE;
CREATE INDEX tx_block FOR (t:Transaction) ON (t.block_number);
CREATE INDEX tx_ts    FOR (t:Transaction) ON (t.timestamp);
CREATE INDEX tx_from  FOR (t:Transaction) ON (t.from_address);
CREATE INDEX tx_to    FOR (t:Transaction) ON (t.to_address);

-- Trace & TokenTransfer
CREATE CONSTRAINT trace_uid FOR (n:Trace) REQUIRE n.uid IS UNIQUE;
CREATE CONSTRAINT token_transfer_uid FOR (n:TokenTransfer) REQUIRE n.uid IS UNIQUE;
```

### Group Entities

Groups are ordinary Entity nodes (`is_group = true`). Rules:
- A group cannot be a member of itself
- An address can only belong to one group at a time (409 if already a member)
- A group with members cannot be deleted (409; remove all members first)

### Container Startup Sequence (`entrypoint.sh`)

On every container start the backend runs these steps before serving:
1. `alembic upgrade head` — PostgreSQL schema migrations
2. `seed_known_labels.py` — Seeds known Ethereum addresses into `known_labels`
3. `seed_users.py` — Seeds default auth users
4. `init_neo4j.py` — Creates Neo4j constraints and indexes (idempotent)
5. `seed_neo4j.py` — Seeds sample Transaction + Entity nodes (idempotent MERGE)
6. `uvicorn` — Starts the API server

### Backend API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Full service health check (Neo4j, PG, Redis) |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe (Neo4j + PG only; 503 if not ready) |
| POST | `/api/auth/login` | JWT login → `{ access_token }` |
| POST | `/api/auth/register` | Register new user |
| GET | `/api/auth/me` | Get current user |
| GET | `/api/stats` | Graph stats (node_count, transaction_count, edge_count, entity_types, risk_levels) |
| GET | `/api/entities/{address}` | Fetch entity node |
| PUT | `/api/entities/{address}` | Upsert entity |
| PATCH | `/api/entities/{address}` | Partial update entity |
| DELETE | `/api/entities/{address}` | Delete entity |
| GET | `/api/entities/{address}/neighbors` | 1–3 hop neighbors (query params: `depth`, `direction`, `limit`) |
| GET | `/api/entities/{src}/paths/{tgt}` | Find paths (query params: `max_depth`, `limit`) |
| GET | `/api/entities/{address}/features` | Get computed features from PostgreSQL |
| PUT | `/api/entities/{address}/features` | Upsert computed features |
| GET | `/api/entities/{address}/members` | List group members |
| POST | `/api/entities/{address}/members` | Add member to group |
| DELETE | `/api/entities/{address}/members/{member}` | Remove member from group |
| GET | `/api/transactions/{hash}` | Fetch transaction node |
| PUT | `/api/transactions/{hash}` | Upsert transaction + SENT/RECEIVED edges |
| DELETE | `/api/transactions/{hash}` | Delete transaction + its relationships |
| GET | `/api/groups` | List all groups (with member counts) |
| POST | `/api/groups` | Create group (auto-generates address) |
| GET | `/api/groups/{address}` | Get group with members |
| PATCH | `/api/groups/{address}` | Update group (name, risk_level, description) |
| DELETE | `/api/groups/{address}` | Delete group (409 if has members) |
| POST | `/api/pipeline/ingest-address` | Fetch address from Etherscan → Neo4j + PostgreSQL |
| GET | `/api/ingestion-runs` | List runs (query params: `limit`, `offset`) |
| GET | `/api/ingestion-runs/{run_id}` | Get single run |
| POST | `/api/labels/tasks` | Create a label task |
| GET | `/api/labels/tasks` | List tasks (optional `status` filter) |
| GET | `/api/labels/tasks/{task_id}` | Get single task |
| POST | `/api/labels/annotations` | Submit annotation (sets task status to `completed`) |
| GET | `/api/labels/annotations/{address}` | Get all annotations for an address |

### PostgreSQL Tables

| Table | Purpose |
|-------|---------|
| `entity_features` | Computed on-chain behavioral metrics per address (degree, volume, AML indicators) |
| `ingestion_runs` | ETL pipeline execution history (status, counts, timing, error) |
| `raw_transactions` | Raw blockchain transaction archive (hash-partitioned) |
| `known_labels` | Seeded known Ethereum addresses with entity type and risk level |
| `label_tasks` | Human labeling workflow: tasks assigned per address |
| `annotations` | Human-submitted labels for task records |
| `users` | Auth users (email, hashed_password) |

### Two-Tier Storage Strategy

| Tier | Storage | Purpose |
|------|---------|---------|
| Hot | Neo4j | Active investigation subgraphs, GDS algorithms |
| Warm | PostgreSQL | Entity features, labeling data, ingestion history |

(A cold tier via MinIO/S3 was removed 2026-04-22; see Milestones below.
ClickHouse is provisioned for future OLAP use — see Phase N.)

### Custom AML Queries (`graph/queries.py`)

All queries use the Transaction-as-Node pattern:
- `detect_peel_chain` — linear chain of single-output hops
- `detect_structuring` — fan-out to many receivers in a block window
- `detect_round_trip` — funds return to origin
- `detect_fan_out_fan_in` — layering through intermediaries
- `detect_mixer_interaction` — direct sends to/from Mixer-labeled nodes
- `find_high_risk_paths` — paths through high-risk labeled entities

## Code Conventions

### Python (Backend)
- Use async Neo4j driver with session-per-request pattern
- Pydantic models for all API request/response schemas
- SQLAlchemy async + asyncpg for PostgreSQL (no psycopg2)
- Alembic env.py uses `asyncio.run(run_async_migrations())` pattern
- 204 No Content responses: use raw `fetch` or `noContent=True` flag — never call `.json()` on empty body
- Auth: JWT in `Authorization: Bearer <token>` header; `HTTPBearer` dependency in `routes/auth.py`

### TypeScript (Frontend)
- All user feedback via `useToastContext()` — never inline error divs
- Cytoscape.js: lazy-load 1-2 hop neighborhoods, never load entire graph
- Entity nodes: colored circles by `entity_type`; Transaction nodes: diamonds (`#3b82f6`)
- Edges: `SENT` (entity→tx) and `RECEIVED` (tx→entity) rendered separately
- Pages are full-page routed via React Router v6, switched via `<NavLink>` tabs in `Nav.tsx`
- All styling uses Tailwind CSS utility classes — `index.css` contains only reset, `:root` tokens, `.grid-bg`, `.app-shell`, scrollbar
- API client `request()` helper attaches JWT from `localStorage`; accepts `noContent = true` for 204 endpoints

### Tailwind Patterns
- Local const strings for repeated class sets: `btnPrimary`, `btnPrimarySm`, `btnGhost`, `btnDangerSm`, `inputCls`, `sectionLabel`
- Custom animations defined in `tailwind.config.js` `theme.extend.keyframes`: `toast-slide-in`, `slide-in`
- Risk badge colors use explicit lookup objects (`RISK_BADGE_CLASSES`) rather than CSS custom properties

### Neo4j Queries
- Always parameterize queries (prevent injection)
- Use `LIMIT` clauses to prevent runaway queries
- Multi-hop traversals use quantified path patterns: `((-[:SENT]->(:Transaction)-[:RECEIVED]->){1..N})`

### Rust ETL Workers (`etl-rs/`)

Two long-running binaries plus one CLI, communicating via Redis:

```
[Etherscan API]
      │   ← ingest binary (one-shot CLI) / worker task A (continuous)
      ▼
[Redis]  streams: ingested_txs / ingested_traces / ingested_transfers
         list:    ingest:targeted_queue  (BRPOPped by worker task A)
      │   ← worker task C (stream consumer)
      ▼
[Neo4j + PostgreSQL]
```

**Workspace crates:**

| Crate | Role |
|---|---|
| `types` | Shared value types (`Transaction`, `Trace`, `Transfer`) |
| `config` | Env-based `Config` + `ProcessConfig` |
| `sources` | `BlockSource` trait + Etherscan / Alchemy / Mock impls |
| `sinks` | Redis Streams writer/consumer, Neo4j/Postgres/ClickHouse writers |
| `pipeline` | Retry, DLQ, shutdown handle, progress reporters |
| `consumer` | `read_batch` + `process_read_batch` (used by `worker` task C) |
| `ingest` | `ingest` binary — one-shot CLI for backfills / ad-hoc targeted fetches |
| `worker` | `worker` binary — long-running, three tokio tasks (targeted queue + refresh + stream consumer) |
| `clickhouse` | `clickhouse-process` binary — independent OLAP consumer group |

**`ingest` CLI:**
```
ingest block --start N --end M [--with-traces] [--with-transfers]
ingest address 0x... [--with-traces] [--with-transfers]
ingest reprocess-failed --source {etherscan,alchemy}
ingest targeted addresses --addrs 0xaaa,0xbbb
ingest targeted neighborhood 0xseed --hops 1
```

**`worker` binary:**
```
worker               # continuous — task A (BRPOP targeted_queue),
                     #              task B (refresh known_labels + high-risk),
                     #              task C (stream consumer → Neo4j + Postgres)
```

**Build:**
```bash
cd etl-rs
cargo build --release   # produces target/release/{ingest, worker, clickhouse-process}
```

**Reset stuck consumer group:**
```bash
docker exec chain-analysis-redis redis-cli XGROUP SETID ingested_txs chain-analysis-process 0
```
(The consumer group name is still `chain-analysis-process` for
backwards compatibility — only the binary name changed.)

## Environment Variables

Set in `docker-compose.yml` for local dev; override in `.env` for external deployments:
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REDIS_URL`
- `ETHERSCAN_API_KEY` — required for real blockchain data (free at etherscan.io/apis)
- `JWT_SECRET_KEY` — secret for signing JWT tokens

## Documentation

Operations and demo guide: `docs/etl-ts.md`
