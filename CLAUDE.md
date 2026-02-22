# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chain-Analysis is a blockchain transaction analysis platform for detecting and investigating money laundering patterns on Ethereum and EVM-compatible chains. The system models blockchain entities as a property graph, enables human analysts to label suspicious activity, and provides a visual interface for exploring transaction flows.

## Technology Stack

**Backend (Python):**
- Python: FastAPI (REST API), Dagster (ETL orchestration)
- Neo4j 5.x + GDS plugin: Graph database with Cypher queries
- PostgreSQL 16: Labeling workflows, metadata, known entity references
- Redis Streams: Message queue for decoupling ingestion
- MinIO: S3-compatible object storage
- SQLAlchemy (async) + asyncpg + Alembic: PostgreSQL ORM and migrations

**Frontend:**
- React 18 + TypeScript (Vite)
- React Router v6: URL-based page routing
- Cytoscape.js for graph visualization (fcose layout)
- Tailwind CSS v3: Utility-first styling (fully migrated from custom CSS)

**Data Sources:**
- Allium (primary): Pre-decoded blockchain data via SQL
- Etherscan API (fallback): Ad-hoc lookups, ABI fetching
- Erigon node (fallback): Full historical replay

## Project Structure

```
chain-analysis/
├── docker-compose.yml          # Neo4j, Postgres, Redis, MinIO, Backend, Frontend
├── .env.example                # Environment variables template
├── etl-rs/                     # Rust ingestion worker (see Rust ETL section)
│   ├── Cargo.toml              # Workspace manifest
│   ├── chain-analysis-common/  # Shared types: Transaction, Trace, Entity, IngestionMessage
│   └── chain-analysis-ingest/  # `ingest` binary: Allium HTTP client → Redis Streams writer
├── scripts/                    # Utility scripts (run by backend entrypoint on startup)
│   ├── init_neo4j.py           # Creates Neo4j constraints + indexes
│   ├── seed_neo4j.py           # Seeds sample Transaction nodes and entities
│   └── seed_known_labels.py    # Seeds PostgreSQL known_labels table
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
│       │       ├── entities.py # Entity CRUD + neighbors + paths + /transactions/{hash} + group members
│       │       ├── groups.py   # Group entity CRUD (list, create, get, patch, delete)
│       │       ├── stats.py    # Graph stats (node_count, transaction_count, entity_types, risk_levels)
│       │       ├── health.py   # /health/live + /health
│       │       └── labels.py   # Known labels
│       ├── core/
│       │   ├── ports/
│       │   │   └── graph_db.py # GraphDatabase protocol + Entity/Transaction/Edge dataclasses
│       │   └── adapters/
│       │       ├── neo4j_adapter.py    # Neo4j implementation
│       │       ├── postgres_adapter.py
│       │       ├── redis_adapter.py
│       │       └── minio_adapter.py
│       ├── etl/                # Dagster assets, resources, jobs
│       ├── graph/
│       │   └── queries.py      # AML detection Cypher queries
│       └── db/                 # SQLAlchemy models + Alembic migrations
└── frontend/
    ├── Dockerfile
    ├── tailwind.config.js      # Tailwind config with custom keyframes (toast-slide-in, slide-in)
    └── src/
        ├── App.tsx             # App shell: ToastContext + React Router routes + Nav
        ├── context/
        │   └── ToastContext.tsx # Global toast context
        ├── hooks/
        │   ├── useToast.ts     # Toast state manager (success/error/loading/info)
        │   ├── useGraph.ts
        │   ├── useGraphStats.ts
        │   └── useHealth.ts
        ├── components/
        │   ├── Nav.tsx         # Top navbar with React Router NavLink tabs
        │   ├── Footer.tsx      # App footer
        │   ├── NavIcons.tsx    # SVG icon set for nav
        │   ├── Toaster.tsx     # Fixed bottom-right toast stack (portal)
        │   ├── GraphCanvas.tsx # Cytoscape.js wrapper
        │   ├── NodePanel.tsx   # Selected-node side panel
        │   ├── EdgePanel.tsx   # Selected-edge side panel
        │   ├── SearchBar.tsx   # Address search input
        │   └── graph/
        │       ├── colors.ts   # Entity type → color map
        │       ├── layouts.ts  # Cytoscape layout configs
        │       └── stylesheet.ts # Cytoscape CSS stylesheet
        ├── pages/
        │   ├── HomePage.tsx           # Landing/home page
        │   ├── GraphExplorerPage.tsx  # Main graph view (search, path finder, filter panel)
        │   ├── GroupsPage.tsx         # Group management (collapsible sidebar + detail panel)
        │   ├── ETLPage.tsx            # ETL pipeline management
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

This replaces the old `(Entity)-[:TRANSFER]->(Entity)` edge model. Transactions are first-class nodes.

**Entity Node Labels:** `:Entity` (base), `:EOA`, `:Contract`, `:Mixer`, `:LendingPool`, `:Bridge`, `:DEX`, `:CEXHotWallet`, `:Application`

**Transaction Node Properties:** `hash` (UNIQUE), `value` (wei str), `block_number`, `timestamp`, `gas_used`, `gas_price` (wei str), `from_address`, `to_address`

**Group Membership:** `(member:Entity)-[:IN_GROUP]->(group:Entity)` — flat set, no parent/child hierarchy. Groups are plain entity nodes; membership is tracked via `IN_GROUP` relationships.

**Key Constraints & Indexes:**
```cypher
CREATE CONSTRAINT entity_address FOR (e:Entity) REQUIRE e.address IS UNIQUE;
CREATE CONSTRAINT tx_hash FOR (t:Transaction) REQUIRE t.hash IS UNIQUE;
CREATE INDEX tx_block FOR (t:Transaction) ON (t.block_number);
CREATE INDEX tx_ts    FOR (t:Transaction) ON (t.timestamp);
```

### Group Entities

Groups are ordinary Entity nodes that other entities can join via `IN_GROUP` relationships. Rules:
- A group cannot be a member of itself
- An address can only belong to one group at a time (409 if already a member)
- A group with members cannot be deleted (409; remove all members first)
- The `list_groups` query finds all entities that have at least one `IN_GROUP` member

### ETL Pipeline (Dagster Assets)

Asset dependency chain: `raw_transactions` → `resolved_entities` → `computed_features` → `graph_nodes` → `graph_transactions` → `gds_algorithms`

**Critical patterns:**
- Use `MERGE` (not `CREATE`) for idempotent upserts
- Batch Neo4j writes using `UNWIND` for 10-100x performance
- Store token amounts as strings (wei) to avoid floating-point precision loss

### Container Startup Sequence (`entrypoint.sh`)

On every container start the backend runs these steps before serving:
1. `alembic upgrade head` — PostgreSQL schema migrations (async via asyncpg)
2. `seed_known_labels.py` — Seeds 22 known Ethereum addresses into `known_labels`
3. `init_neo4j.py` — Creates Neo4j constraints and indexes (idempotent)
4. `seed_neo4j.py` — Seeds sample Transaction nodes and Entity nodes (idempotent MERGE)
5. `uvicorn` — Starts the API server

### Backend API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health/live` | Liveness probe |
| GET | `/health` | Full service health check |
| GET | `/api/stats` | Graph stats (node_count, transaction_count, entity_types, risk_levels) |
| GET | `/api/entities/{address}` | Fetch entity node |
| PUT | `/api/entities/{address}` | Upsert entity |
| PATCH | `/api/entities/{address}` | Partial update entity |
| DELETE | `/api/entities/{address}` | Delete entity |
| GET | `/api/entities/{address}/neighbors` | Get 1-hop neighbors (returns nodes + transactions) |
| GET | `/api/entities/{src}/paths/{tgt}` | Find paths between two entities |
| GET | `/api/transactions/{hash}` | Fetch transaction node by hash |
| GET | `/api/entities/{address}/members` | List group members |
| POST | `/api/entities/{address}/members` | Add member to group |
| DELETE | `/api/entities/{address}/members/{member_address}` | Remove member from group |
| GET | `/api/groups` | List all groups |
| POST | `/api/groups` | Create group |
| GET | `/api/groups/{address}` | Get group with members |
| PATCH | `/api/groups/{address}` | Update group (name, risk_level, description) |
| DELETE | `/api/groups/{address}` | Delete group (fails if has members) |

### Three-Tier Storage Strategy

| Tier | Storage | Purpose |
|------|---------|---------|
| Hot | Neo4j | Active investigation subgraphs, GDS algorithms |
| Warm | PostgreSQL | Labeling data, known entities, feature history |
| Cold | MinIO (S3) | Raw data archive, ML training, compliance |

### Graph Algorithms (Neo4j GDS)

- PageRank: High-influence fund aggregators
- Betweenness Centrality: Intermediary/mixer nodes
- Louvain: Community detection for suspicious clusters
- Label Propagation: Risk propagation from known labels

### Custom AML Queries (`graph/queries.py`)

All queries use the Transaction-as-Node pattern:
- `detect_peel_chain` — linear chain of single-output hops
- `detect_structuring` — fan-out to many receivers in a block window
- `detect_round_trip` — funds return to origin
- `detect_fan_out_fan_in` — layering through intermediaries
- `detect_mixer_interaction` — direct sends to/from Mixer-labeled nodes

## Code Conventions

### Python (Backend)
- Use async Neo4j driver with session-per-request pattern
- Pydantic models for all API request/response schemas
- SQLAlchemy async + asyncpg for PostgreSQL (no psycopg2)
- Alembic env.py uses `asyncio.run(run_async_migrations())` pattern
- 204 No Content responses: use raw `fetch` or `noContent=True` flag — never call `.json()` on empty body

### TypeScript (Frontend)
- All user feedback via `useToastContext()` — never inline error divs
- Cytoscape.js: lazy-load 1-2 hop neighborhoods, never load entire graph
- Entity nodes: colored circles by `entity_type`; Transaction nodes: diamonds (`#3b82f6`)
- Edges: `SENT` (entity→tx) and `RECEIVED` (tx→entity) rendered separately
- Pages are full-page routed via React Router v6, switched via `<NavLink>` tabs in `Nav.tsx`
- All styling uses Tailwind CSS utility classes — `index.css` contains only reset, `:root` tokens, `.grid-bg`, `.app-shell`, scrollbar
- API client `request()` helper accepts `noContent = true` for 204 endpoints to skip `.json()` parse

### Tailwind Patterns
- Local const strings for repeated class sets: `btnPrimary`, `btnPrimarySm`, `btnGhost`, `btnDangerSm`, `inputCls`, `sectionLabel`
- Custom animations defined in `tailwind.config.js` `theme.extend.keyframes`: `toast-slide-in`, `slide-in`
- Risk badge colors use explicit lookup objects (`RISK_BADGE_CLASSES`) rather than CSS custom properties
- `!important` modifier (`!bg-gray-900`) used only when overriding hover states on active toggle buttons

### Neo4j Queries
- Always parameterize queries (prevent injection)
- Use `LIMIT` clauses to prevent runaway queries
- Multi-hop traversals use quantified path patterns: `((-[:SENT]->(:Transaction)-[:RECEIVED]->){1..N})`
- Group queries use `IN_GROUP` relationship (migrated from `MEMBER_OF` — run migration if upgrading from old data)

### Rust ETL Ingestion Worker (`etl-rs/`)

The Rust workspace sits at the **extract** stage of the pipeline — before Dagster. It fetches raw blockchain data from Allium and publishes it to Redis Streams, which Dagster then consumes.

```
[Allium API]
     │   ← Rust binary (chain-analysis-ingest)
     ▼
[Redis Streams]
     │   ← Python / Dagster assets
     ▼
[Neo4j + Postgres]
```

**Workspace crates:**

| Crate | Role |
|---|---|
| `chain-analysis-common` | Shared domain types: `Transaction`, `Trace`, `Entity`, `Transfer`, `IngestionMessage`, `Config` |
| `chain-analysis-ingest` | `ingest` CLI binary — Allium HTTP client + Redis Streams writer |

**Key dependencies:** `alloy-primitives` (type-safe `Address`/`B256`/`U256`), `neo4rs`, `redis` (async streams), `tokio`, `serde_json`, `tracing`.

**CLI usage:**
```bash
ingest --start-block 18000000 --end-block 18001000 [--dry-run]
```

**`IngestionMessage` envelope types** (serialised as tagged JSON to Redis):
- `Transactions(Vec<Transaction>)` — raw tx batch
- `Traces(Vec<Trace>)` — internal call traces
- `Entities(Vec<Entity>)` — resolved entities
- `Transfers(Vec<Transfer>)` — computed value transfers
- `Progress { run_id, current_block, total_blocks, transactions_processed }`
- `Complete { run_id, transactions_processed, traces_processed }`
- `Error { run_id, message }`

**Build:**
```bash
cd etl-rs
cargo build --release          # produces target/release/ingest
cargo test                     # unit tests (mock data + message roundtrip)
```

Without `ALLIUM_API_KEY` set the client returns deterministic mock transactions (3 per block) for local development.

---

## Roadmap

### Rust ETL (`etl-rs/`)

| Status | Item |
|---|---|
| ✅ Done | `chain-analysis-common` — shared domain types (`Transaction`, `Trace`, `Entity`, `Transfer`, `IngestionMessage`) |
| ✅ Done | `chain-analysis-ingest` — `ingest` CLI binary: Allium HTTP client + Redis Streams writer + mock data fallback |
| 🔲 TODO | `chain-analysis-process` crate — Redis consumer: decode `IngestionMessage`, resolve entities, classify EOA/Contract, write to Neo4j via `neo4rs` |
| 🔲 TODO | Trace ingestion — fetch and publish `Trace` batches alongside transactions (currently `traces_processed` is hardcoded 0) |
| 🔲 TODO | ERC-20 transfer decoding — parse `Transfer(address,address,uint256)` logs into `Transfer` messages |
| 🔲 TODO | Retry + backoff logic in `ingest` main loop (currently logs error and continues) |
| 🔲 TODO | Docker image for `ingest` binary — add to `docker-compose.yml` as an on-demand job container |
| 🔲 TODO | Dagster `PipesSubprocessClient` integration — launch `ingest` as a Dagster asset op so block ranges are orchestrated by Dagster |

### Backend

| Status | Item |
|---|---|
| ✅ Done | Entity CRUD, neighbors, paths, transactions |
| ✅ Done | Group management (`IN_GROUP` schema, `/api/groups` routes) |
| 🔲 TODO | AML detection endpoint — expose `graph/queries.py` patterns via REST |
| 🔲 TODO | PostgreSQL label sync — write resolved entities back to `known_labels` |

### Frontend

| Status | Item |
|---|---|
| ✅ Done | Graph Explorer, ETL Page, Dashboard, Groups Page |
| ✅ Done | Tailwind CSS migration |
| 🔲 TODO | AML pattern results viewer page |
| 🔲 TODO | ETL Page wired to real Dagster run status |

## Environment Variables

Set in `docker-compose.yml` for local dev; required in `.env` for external deployments:
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REDIS_URL`
- `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_SECURE`
- `ALLIUM_API_KEY` (for production ETL)

## Documentation

Full system documentation: `docs/chain-analysis_system_overview.pdf`

## Notes
- Currently, the entity edges are not used in the live graph data. But the code infrastructure around it still exists in several places. Safe to remove if needed. Maybe it will be used in the future.