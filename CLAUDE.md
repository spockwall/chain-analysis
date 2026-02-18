# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chain-Analysis is a blockchain transaction analysis platform for detecting and investigating money laundering patterns on Ethereum and EVM-compatible chains. The system models blockchain entities as a property graph, enables human analysts to label suspicious activity, and provides a visual interface for exploring transaction flows.

## Technology Stack

**Backend (Hybrid Rust/Python):**
- Rust: ETL ingestion workers, feature computation, custom graph algorithms (CPU-intensive)
- Python: FastAPI (REST/GraphQL API), Dagster (ETL orchestration), ad-hoc analysis
- Neo4j 5.x + GDS plugin: Graph database with Cypher queries
- PostgreSQL 16: Labeling workflows, metadata, known entity references
- Kafka/Redis Streams: Message queue for decoupling ingestion

**Frontend:**
- React 18 + TypeScript
- Cytoscape.js for graph visualization
- shadcn/ui + Tailwind CSS
- Recharts for dashboards

**Data Sources:**
- Allium (primary): Pre-decoded blockchain data via SQL
- Etherscan API (fallback): Ad-hoc lookups, ABI fetching
- Erigon node (fallback): Full historical replay

## Project Structure

```
chain-analysis/
├── docker-compose.yml          # Neo4j, Postgres, Kafka, API, Frontend
├── .env.example                 # Environment variables template
├── backend/
│   ├── pyproject.toml           # Python deps (poetry/uv)
│   └── src/
│       ├── api/                 # FastAPI routes, Pydantic models
│       ├── etl/                 # Dagster assets, resources, jobs
│       ├── graph/               # Neo4j query builders + GDS wrappers
│       ├── db/                  # SQLAlchemy models + Alembic migrations
│       └── services/            # Business logic layer
├── frontend/
│   ├── package.json
│   └── src/
│       ├── components/          # graph/, labeling/, dashboard/
│       ├── hooks/               # useGraph, useLabel
│       ├── api/                 # Fetch wrappers, types
│       └── types/               # TypeScript interfaces
└── scripts/                     # Utility scripts (seed data, migrations)
```

## Development Commands

```bash
# Start infrastructure (Neo4j, PostgreSQL, Kafka)
docker compose up -d

# Backend setup (from backend/)
alembic upgrade head                              # Initialize PostgreSQL schema
python scripts/seed_known_labels.py               # Seed known labels
dagster dev                                       # Start Dagster UI for ETL
uvicorn src.api.main:app --reload                 # Start FastAPI server

# Frontend setup (from frontend/)
pnpm install
pnpm dev                                          # Start dev server (connects to localhost:8000)

# Testing
pytest                                            # Backend tests (from backend/)
pnpm test                                         # Frontend tests (from frontend/)
```

## Architecture Notes

### Neo4j Graph Schema

**Node Labels:** `:Entity` (base), `:EOA`, `:Contract`, `:Mixer`, `:LendingPool`, `:Bridge`, `:DEX`, `:CEXHotWallet`, `:Application`

**Edge Types:** `TRANSFER` (value transfers), `CALLS` (contract interactions), `DEPLOYED` (contract creation)

**Key Constraint:**
```cypher
CREATE CONSTRAINT entity_address FOR (e:Entity) REQUIRE e.address IS UNIQUE;
```

### ETL Pipeline (Dagster Assets)

Asset dependency chain: `raw_transactions` → `resolved_entities` → `computed_features` → `graph_nodes` → `graph_edges` → `gds_algorithms`

**Critical patterns:**
- Use `MERGE` (not `CREATE`) for idempotent upserts
- Batch Neo4j writes using `UNWIND` for 10-100x performance
- Store token amounts as strings (wei) to avoid floating-point precision loss

### Three-Tier Storage Strategy

| Tier | Storage | Purpose |
|------|---------|---------|
| Hot | Neo4j Aura | Active investigation subgraphs, GDS algorithms |
| Warm | PostgreSQL | All transactions, feature history, labeling data |
| Cold | S3 Parquet + Athena | Full 5TB archive, ML training, compliance |

### Graph Algorithms (Neo4j GDS)

- PageRank: High-influence fund aggregators
- Betweenness Centrality: Intermediary/mixer nodes
- Louvain: Community detection for suspicious clusters
- Label Propagation: Risk propagation from known labels

### Custom AML Queries

Cypher patterns for: peel chain detection, structuring detection, round-trip detection, fan-out/fan-in patterns, timing correlation.

## Code Conventions

### Python (Backend)
- Use async Neo4j driver with session-per-request pattern
- Pydantic models for all API request/response schemas
- SQLAlchemy for PostgreSQL models, Alembic for migrations

### TypeScript (Frontend)
- Cytoscape.js: lazy-load 1-2 hop neighborhoods, never load entire graph
- Use `fcose` layout (force-directed) by default, `dagre` for flow analysis
- Color-code nodes by `entity_type` and `risk_label`

### Neo4j Queries
- Always parameterize queries (prevent injection)
- Use `LIMIT` clauses to prevent runaway queries
- Profile queries with `PROFILE` or `EXPLAIN` before production use

## Environment Variables

Required in `.env`:
- `NEO4J_URI`, `NEO4J_PASSWORD`
- `PG_USER`, `PG_PASSWORD`
- `ALLIUM_API_KEY`

## Documentation

Full system documentation: `docs/chain-analysis_system_overview.pdf`
