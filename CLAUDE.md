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
- Cytoscape.js for graph visualization (fcose layout)
- Custom Oravia design system (CSS variables, no external UI library)

**Data Sources:**
- Allium (primary): Pre-decoded blockchain data via SQL
- Etherscan API (fallback): Ad-hoc lookups, ABI fetching
- Erigon node (fallback): Full historical replay

## Project Structure

```
chain-analysis/
├── docker-compose.yml          # Neo4j, Postgres, Redis, MinIO, Backend, Frontend
├── .env.example                # Environment variables template
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
│       │       ├── entities.py # Entity CRUD + neighbors + paths + /transactions/{hash}
│       │       ├── stats.py    # Graph stats (node_count, transaction_count, etc.)
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
    ├── src/
    │   ├── App.tsx             # App shell: ToastContext provider + tab navbar
    │   ├── context/
    │   │   └── ToastContext.tsx # Global toast context
    │   ├── hooks/
    │   │   ├── useToast.ts     # Toast state manager (success/error/loading/info)
    │   │   ├── useGraph.ts
    │   │   ├── useGraphStats.ts
    │   │   └── useHealth.ts
    │   ├── components/
    │   │   ├── Toaster.tsx     # Fixed bottom-right toast stack (portal)
    │   │   ├── GraphCanvas.tsx # Cytoscape.js wrapper
    │   │   ├── NodePanel.tsx   # Selected-node side panel
    │   │   └── SearchBar.tsx   # Address search input
    │   ├── pages/
    │   │   ├── GraphExplorerPage.tsx  # Main graph view
    │   │   ├── ETLPage.tsx            # ETL pipeline management (full page)
    │   │   └── DashboardPage.tsx      # System health + graph stats (full page)
    │   ├── api/client.ts       # Fetch wrappers for all backend endpoints
    │   └── types/index.ts      # TypeScript interfaces
    └── index.css               # Oravia design tokens + all component styles
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

**Key Constraints & Indexes:**
```cypher
CREATE CONSTRAINT entity_address FOR (e:Entity) REQUIRE e.address IS UNIQUE;
CREATE CONSTRAINT tx_hash FOR (t:Transaction) REQUIRE t.hash IS UNIQUE;
CREATE INDEX tx_block FOR (t:Transaction) ON (t.block_number);
CREATE INDEX tx_ts    FOR (t:Transaction) ON (t.timestamp);
```

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

### TypeScript (Frontend)
- All user feedback via `useToastContext()` — never inline error divs
- Cytoscape.js: lazy-load 1-2 hop neighborhoods, never load entire graph
- Entity nodes: colored circles by `entity_type`; Transaction nodes: diamonds (`#3b82f6`)
- Edges: `SENT` (entity→tx) and `RECEIVED` (tx→entity) rendered separately
- Pages are full-page routed (not modal overlays), switched via navbar tabs

### Neo4j Queries
- Always parameterize queries (prevent injection)
- Use `LIMIT` clauses to prevent runaway queries
- Multi-hop traversals use quantified path patterns: `((-[:SENT]->(:Transaction)-[:RECEIVED]->){1..N})`

## Environment Variables

Set in `docker-compose.yml` for local dev; required in `.env` for external deployments:
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REDIS_URL`
- `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_SECURE`
- `ALLIUM_API_KEY` (for production ETL)

## Documentation

Full system documentation: `docs/chain-analysis_system_overview.pdf`
