# Chain Analysis

A blockchain transaction analysis platform for detecting and investigating money laundering patterns on Ethereum and EVM-compatible chains.

## Overview

Chain Analysis models blockchain activity as a property graph. Analysts can explore transaction flows visually, label suspicious entities, group related addresses, run AML detection algorithms, queue targeted ingestion jobs, and monitor the whole pipeline from a browser.

**Key capabilities:**
- Interactive graph explorer with 1–2 hop neighborhood traversal
- Path finding between any two addresses
- Entity labeling with risk levels (unknown / low / medium / high / critical)
- Group management — tag related addresses into named investigation groups
- AML pattern detection (peel chains, structuring, round trips, fan-out/fan-in, mixer interactions)
- Human-in-the-loop labeling — queue targeted fetches, review tasks, submit annotations
- Rust ETL workers (Redis Streams) writing to both Neo4j+PostgreSQL and ClickHouse
- Dagster orchestration (backfills, reprocess schedules, Redis-queue sensor)
- Observability — Prometheus metrics, Grafana dashboards, Alertmanager routing
- Dashboard with system health and quick links to every operator tool
- MCP server for agent access to graph, group, feature, and labeling tools

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Graph DB | Neo4j 5.x + GDS plugin |
| Relational DB | PostgreSQL 17 |
| OLAP | ClickHouse |
| Message Queue | Redis Streams |
| Object Storage | MinIO (S3-compatible) |
| ETL Workers | Rust (tokio, reqwest, neo4rs, sqlx, clickhouse-rs) |
| Orchestration | Dagster (webserver + daemon) |
| Observability | Prometheus, Grafana, Alertmanager |
| Backend API | Python, FastAPI, SQLAlchemy async, Alembic |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, React Router v6 |
| Graph Visualization | Cytoscape.js (fcose layout) |

## Getting Started

### Prerequisites

- Docker + Docker Compose

### Run

```bash
git clone <repo>
cd chain-analysis
cp compose/secrets.dev.env.example compose/secrets.dev.env
docker compose up -d
```

On first start the backend automatically:
1. Runs PostgreSQL migrations (`alembic upgrade head`)
2. Seeds known Ethereum labels into PostgreSQL
3. Seeds default auth users
4. Creates Neo4j constraints and indexes
5. Seeds sample entities and transactions into Neo4j

### Service URLs

| Service | URL |
|---------|-----|
| Frontend (Vite dev) | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| MCP Endpoint | http://localhost:8000/mcp |
| API Docs (Swagger) | http://localhost:8000/docs |
| Neo4j Browser | http://localhost:7474 |
| Dagster UI | http://localhost:3000 |
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Alertmanager | http://localhost:9093 |
| MinIO Console | http://localhost:9001 |
| ClickHouse HTTP | http://localhost:8123 |

Every operator tool above also appears as a tile on the in-app **Dashboard**.

Default local Neo4j credentials: `neo4j` / `changeme`.

### Rebuild after code changes

```bash
docker compose build backend && docker compose up -d backend
docker compose build frontend && docker compose up -d frontend
```

### Frontend dev server (hot reload)

```bash
cd frontend
npm install
npm run dev   # http://localhost:5173 — proxies API to localhost:8000
```

### Backend dev server

```bash
cd backend
uvicorn src.api.main:app --reload --port 8000
```

### Rust ETL workers

```bash
cd etl-rs
cargo build --release
# → target/release/ingest
# → target/release/process
# → target/release/clickhouse-process
```

See `etl-rs/README.md` for subcommands, env vars, orchestration, and observability details.

### MCP usage

The backend now exposes an MCP server in two forms:

- Streamable HTTP: `http://localhost:8000/mcp`
- Stdio: `cd backend && pip install -e . && chain-analysis-mcp`

Authentication:

- Streamable HTTP reuses the existing API bearer auth. First obtain a JWT from `/api/auth/login` or `/api/auth/register`, then send `Authorization: Bearer <token>` with MCP HTTP requests.
- Stdio does not use HTTP bearer auth; it relies on local process access instead.

Typical agent/client configuration examples:

```json
{
  "mcpServers": {
    "chain-analysis": {
      "command": "chain-analysis-mcp"
    }
  }
}
```

```json
{
  "mcpServers": {
    "chain-analysis": {
      "transport": "http",
      "url": "http://localhost:8000/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

## Project Structure

```
chain-analysis/
├── docker-compose.yml
├── compose/                    # Modular compose includes (infra, app, etl, dagster, prometheus, grafana)
│   ├── prometheus.config.yml   # Prometheus scrape config
│   └── grafana/                # Grafana provisioning + dashboard JSON
├── scripts/                    # Init + seed scripts (run by backend on startup)
├── etl-rs/                     # Rust ETL workspace (types, config, sources, sinks, pipeline, ingest, process)
├── backend/
│   └── src/
│       ├── api/
│       │   ├── routes/         # FastAPI route handlers (entities, groups, labels, pipeline, stats, health, auth)
│       │   └── models/         # Pydantic request/response schemas
│       ├── core/
│       │   ├── ports/          # Database + storage interfaces (protocols)
│       │   └── adapters/       # Neo4j, PostgreSQL, Redis, MinIO implementations
│       ├── etl/                # Dagster assets, ops, jobs, sensors, schedules
│       ├── graph/              # AML Cypher detection queries
│       └── db/                 # SQLAlchemy models + Alembic migrations
└── frontend/
    └── src/
        ├── pages/              # HomePage, LoginPage, SignupPage, GraphExplorerPage, GroupsPage,
        │                       # LabelsPage, ETLPage, DashboardPage, AdminUsersPage
        ├── components/         # Shared UI (Nav, GraphCanvas, NodePanel, TxPanel, SearchBar, ...)
        ├── hooks/              # useHealth, useGraphStats, useToast
        ├── api/client.ts       # Typed API client
        └── types/index.ts      # TypeScript interfaces
```

## API Reference

### Entities

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/entities/{address}` | Fetch entity |
| PUT | `/api/entities/{address}` | Upsert entity |
| PATCH | `/api/entities/{address}` | Partial update |
| DELETE | `/api/entities/{address}` | Delete entity |
| GET | `/api/entities/{address}/neighbors` | 1–3 hop neighbors |
| GET | `/api/entities/{src}/paths/{tgt}` | Find paths |
| GET | `/api/transactions/{hash}` | Fetch transaction |
| PUT | `/api/transactions/{hash}` | Upsert transaction |
| DELETE | `/api/transactions/{hash}` | Delete transaction |

### Groups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/groups` | List all groups |
| POST | `/api/groups` | Create group |
| GET | `/api/groups/{address}` | Get group + members |
| PATCH | `/api/groups/{address}` | Update group |
| DELETE | `/api/groups/{address}` | Delete group |
| GET | `/api/entities/{address}/members` | List members |
| POST | `/api/entities/{address}/members` | Add member |
| DELETE | `/api/entities/{address}/members/{member}` | Remove member |

### Labeling

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/labels/fetch` | Queue targeted fetch (addresses / hashes / neighborhood) |
| GET | `/api/labels/tasks` | List label tasks (optional `status` filter) |
| GET | `/api/labels/tasks/{task_id}` | Get single task |
| POST | `/api/labels/annotations` | Submit annotation (flips task to `completed`) |
| GET | `/api/labels/annotations/{address}` | Annotations for an address |

### Pipeline & Ingestion

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/pipeline/ingest-address` | Fetch address via Etherscan → Neo4j + PG |
| GET | `/api/ingestion-runs` | List ingestion runs |
| GET | `/api/ingestion-runs/{run_id}` | Get single run |

### Auth & Admin

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | JWT login |
| POST | `/api/auth/register` | Register user |
| GET | `/api/auth/me` | Current user |
| GET | `/api/admin/users` | List users (admin) |
| POST | `/api/admin/users` | Create user (admin) |
| PATCH | `/api/admin/users/{id}` | Update user (admin) |
| DELETE | `/api/admin/users/{id}` | Delete user (admin) |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe (Neo4j + PG) |
| GET | `/health` | Full health check |
| GET | `/api/stats` | Graph statistics |

## Neo4j Graph Schema

```
(from:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(to:Entity)

(member:Entity)-[:IN_GROUP]->(group:Entity)

(:Trace)           -- call-level detail with unique `uid`
(:TokenTransfer)   -- ERC-20 transfer events with unique `uid`
```

**Entity labels:** `EOA`, `Contract`, `Mixer`, `LendingPool`, `Bridge`, `DEX`, `CEXHotWallet`, `Application`

**Risk levels:** `unknown`, `low`, `medium`, `high`, `critical`

## AML Detection Patterns

Parameterized Cypher queries in `backend/src/graph/queries.py`:

| Pattern | Description |
|---------|-------------|
| Peel chain | Linear chain of single-output hops — common in layering |
| Structuring | Fan-out to many receivers within a block window |
| Round trip | Funds return to originating address |
| Fan-out / fan-in | Layering through intermediary addresses |
| Mixer interaction | Direct sends to/from known Mixer-labeled nodes |

## Labeling Workflow

1. **Queue a fetch** — on `/labels`, operators submit addresses, transaction hashes, or a neighborhood seed. The backend LPUSHes jobs to the Redis list `ingest:targeted_queue` and creates pending `label_tasks` rows.
2. **Dagster drains the queue** — the `targeted_queue_sensor` ticks every 30s and spawns `targeted_drain_job`, which shells out to `ingest targeted from-label-tasks`.
3. **Analysts annotate** — pending tasks appear in the task table on `/labels`. Submitting the annotation form writes to the `annotations` table and flips task status to `completed`.
4. **Deep link from the explorer** — the graph explorer's NodePanel has a **Label this entity** button that opens `/labels?address=0x…` with the address prefilled.

## Groups

Groups tag a flat set of addresses under a named label (e.g. "Tornado Cash Protocol", "Suspect Cluster A"). Rules:

- An address can belong to at most one group
- A group cannot contain itself
- Deleting a group requires removing all members first
- Membership is stored as `(member)-[:IN_GROUP]->(group)` in Neo4j

## Orchestration (Dagster)

Dagster runs alongside the stack (webserver on `:3000`, plus a daemon). It wraps the Rust `ingest` binary as subprocess-executed jobs.

| Job | Trigger |
|---|---|
| `backfill_job` | Launchpad (manual block range) |
| `reprocess_job` | Hourly schedules (etherscan :00, alchemy :15) |
| `targeted_drain_job` | Redis sensor on `INGEST_TARGETED_QUEUE` (30s) |
| `targeted_addresses_job` | Launchpad (ad-hoc) |
| `targeted_neighborhood_job` | Launchpad (ad-hoc) |

Schedules and the sensor default to **stopped** — enable them in the Dagster UI.

## Observability

All three Rust workers expose Prometheus metrics on `:${METRICS_PORT:-9100}/metrics`. Prometheus scrapes them every 15s; Grafana ships with a provisioned `ETL Overview` dashboard; Alertmanager routes rule violations.

| Tool | URL | Role |
|---|---|---|
| Prometheus | http://localhost:9090 | Metrics + rule evaluation |
| Grafana | http://localhost:3001 | Dashboards (anonymous Viewer) |

Scrape config lives in `compose/prometheus.config.yml`. Grafana
provisioning + dashboard JSON lives in `compose/grafana/`.
See `etl-rs/README.md` for the full metric catalog.

## Environment Variables

For Docker Compose, copy `compose/secrets.dev.env.example` to
`compose/secrets.dev.env` before starting services. The real
`compose/secrets.dev.env` file is ignored by Git so each developer can keep
local secrets out of version control.

Copy `.env.example` to `.env` for non-Docker deployments. Core keys:

```
# Graph / OLTP
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=chain_analysis
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres123

# OLAP
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_DATABASE=chain_analysis
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=

# Queue + storage
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
MINIO_BUCKET=chain-analysis

# Ingest provider — pick one
INGEST_SOURCE=etherscan           # or: alchemy | mock
ETHERSCAN_API_KEY=
ALCHEMY_API_KEY=

# Auth
JWT_SECRET_KEY=change-me-in-production
```

The Rust workers accept additional `INGEST_*`, `PROCESS_*`, `CLICKHOUSE_*`, and `DAGSTER_*` knobs — documented in `etl-rs/README.md`.

## Testing

```bash
# Backend
cd backend && pytest

# Rust ETL (unit only — no services required)
cd etl-rs && cargo test --workspace --lib --bins

# Rust ETL (integration — needs Redis + ClickHouse)
E2E_REDIS_URL=redis://localhost:6379 \
E2E_CLICKHOUSE_URL=http://localhost:8123 \
  cargo test --workspace

# Frontend type-check + build
cd frontend && npm run build
```
