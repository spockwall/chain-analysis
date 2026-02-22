# Chain Analysis

A blockchain transaction analysis platform for detecting and investigating money laundering patterns on Ethereum and EVM-compatible chains.

## Overview

Chain Analysis models blockchain activity as a property graph. Analysts can explore transaction flows visually, label suspicious entities, group related addresses, and run AML detection algorithms — all from a browser-based interface.

**Key capabilities:**
- Interactive graph explorer with 1-2 hop neighborhood traversal
- Path finding between any two addresses
- Entity labeling with risk levels (unknown / low / medium / high / critical)
- Group management — tag related addresses into named investigation groups
- AML pattern detection (peel chains, structuring, round trips, fan-out/fan-in, mixer interactions)
- ETL pipeline management via Dagster
- System health dashboard

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Graph DB | Neo4j 5.x + GDS plugin |
| Relational DB | PostgreSQL 16 |
| Message Queue | Redis Streams |
| Object Storage | MinIO (S3-compatible) |
| Backend | Python, FastAPI, Dagster |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Graph Visualization | Cytoscape.js (fcose layout) |

## Getting Started

### Prerequisites

- Docker + Docker Compose

### Run

```bash
git clone <repo>
cd chain-analysis
docker compose up -d
```

On first start the backend automatically:
1. Runs PostgreSQL migrations (`alembic upgrade head`)
2. Seeds known Ethereum labels into PostgreSQL
3. Creates Neo4j constraints and indexes
4. Seeds sample entities and transactions into Neo4j

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| API Docs (Swagger) | http://localhost:8000/docs |
| Neo4j Browser | http://localhost:7474 |
| Dagster UI | http://localhost:3000 |
| MinIO Console | http://localhost:9001 |

Default Neo4j credentials: `neo4j` / `password123`

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

## Project Structure

```
chain-analysis/
├── docker-compose.yml
├── scripts/                    # Init + seed scripts (run by backend on startup)
├── backend/
│   └── src/
│       ├── api/
│       │   ├── routes/         # FastAPI route handlers
│       │   └── models/         # Pydantic request/response schemas
│       ├── core/
│       │   ├── ports/          # Database + storage interfaces (protocols)
│       │   └── adapters/       # Neo4j, PostgreSQL, Redis, MinIO implementations
│       ├── etl/                # Dagster assets and resources
│       ├── graph/              # AML Cypher detection queries
│       └── db/                 # SQLAlchemy models + Alembic migrations
└── frontend/
    └── src/
        ├── pages/              # Full-page views (Home, Explorer, Groups, ETL, Dashboard)
        ├── components/         # Shared UI components
        ├── hooks/              # Data-fetching hooks
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
| GET | `/api/entities/{address}/neighbors` | 1-hop neighbors |
| GET | `/api/entities/{src}/paths/{tgt}` | Find paths |
| GET | `/api/transactions/{hash}` | Fetch transaction |

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

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health/live` | Liveness probe |
| GET | `/health` | Full health check |
| GET | `/api/stats` | Graph statistics |

## Neo4j Graph Schema

```
(from:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(to:Entity)

(member:Entity)-[:IN_GROUP]->(group:Entity)
```

**Entity labels:** `EOA`, `Contract`, `Mixer`, `LendingPool`, `Bridge`, `DEX`, `CEXHotWallet`, `Application`

**Risk levels:** `unknown`, `low`, `medium`, `high`, `critical`

## AML Detection Patterns

Implemented as parameterized Cypher queries in `backend/src/graph/queries.py`:

| Pattern | Description |
|---------|-------------|
| Peel chain | Linear chain of single-output hops — common in layering |
| Structuring | Fan-out to many receivers within a block window |
| Round trip | Funds return to originating address |
| Fan-out / fan-in | Layering through intermediary addresses |
| Mixer interaction | Direct sends to/from known Mixer-labeled nodes |

## Groups

Groups let analysts tag a flat set of addresses under a named label (e.g. "Tornado Cash Protocol", "Suspect Cluster A"). Rules:

- An address can belong to at most one group
- A group cannot contain itself
- Deleting a group requires removing all members first
- Membership is stored as `(member)-[:IN_GROUP]->(group)` in Neo4j

## Environment Variables

Copy `.env.example` to `.env` for non-Docker deployments:

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=chain_analysis
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres

REDIS_URL=redis://localhost:6379

MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=chain-analysis
MINIO_SECURE=false

ALLIUM_API_KEY=          # Required for production ETL
```
