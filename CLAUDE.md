# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Roadmap

Open phases teammates can pick up. Ordered by user-facing value.

### Phase H — ETL end-to-end cooperation (COMPLETE)
Single Rust-driven ingestion path, async run tracking via `ingestion_runs`,
Dagster sensor on by default, run-status pill in the footer, graph + run
state persisted across refresh. Follow-up H.9 added UI surfaces for the
remaining Rust capabilities: NodePanel "Deep trace (2 hops)", ETLPage
"Ingest Transactions by Hash" card, and an admin-gated Dagster Launchpad
deep-link on `/etl`. Plan archived at
`/Users/spockwall/.claude/plans/read-readme-md-now-glowing-toast.md`.

### Phase I — Pure-Rust worker + UI primitives (COMPLETE)
Replaced the Dagster targeted-queue sensor with a long-running Rust
`worker` binary that holds three tokio tasks: (A) BRPOPs
`ingest:targeted_queue` for user-triggered fetches (sub-second latency
vs 30s sensor tick), (B) periodic refresh of known_labels ∪ high-risk
entities, (C) XREADGROUP drain of `ingested_*` streams into Neo4j +
Postgres (absorbs the former `process` binary). Added
`entity_features.last_synced_block` for delta-refresh semantics.
Deleted the `process` crate, `targeted_queue_sensor`,
`targeted_drain_job`, and `ingest targeted from-label-tasks`. UI sweep
replaced pastel-fill badges with `<Badge>`/`<Pill>` primitives.
Dagster now dormant (only `reprocess_job` schedules remain).

### Phase J — AML Detections UI
The Cypher queries in `backend/src/graph/queries.py` (peel chain, structuring,
round trip, fan-out/fan-in, mixer interaction) exist but have no API route
and no UI. Build `/api/detections/{pattern}?address=…` endpoints and a
Detections tab that highlights matching subgraphs on the Cytoscape canvas.
Highest analyst-facing value after Phase I.

### Phase L — E2E test coverage
No Playwright/Cypress suite. Add a smoke journey: login → ingest address →
explore → queue label → annotate. Wire into CI alongside existing
`backend/pytest` and `etl-rs/cargo test`.

### Phase M — Dagster hardening (DORMANT)
Dagster stack is retained but inactive. Open items:
(a) migrate run storage from SQLite to the shared Postgres,
(b) scrape Dagster's `/metrics` endpoint into Prometheus,
(c) model always-on stream consumers as Dagster assets for lineage.
The `ingest-builder` one-shot is gone (2026-04-22) — the `ingest` binary is
now baked into the Dagster image directly (see `backend/Dockerfile`).

### Phase N — ClickHouse activation
OLAP store is provisioned in `compose/infra.yml` and the
`clickhouse-process` binary + `clickhouse` sink + migrations
(`etl-rs/crates/etl/migrations/clickhouse/`) all exist, but no compose
service runs the consumer. Add a `clickhouse-process` service under
`compose/etl.yml`, add a Prometheus scrape job, and verify the
`chain-analysis-clickhouse` consumer group drains
`ingested_txs/traces/transfers` into the `clickhouse_data` volume.

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
