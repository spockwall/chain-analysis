# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Skills — detailed reference

Project-level skills under `.claude/skills/` hold the deep reference material so it doesn't have to load every turn. Invoke via the Skill tool when relevant:

- **`roadmap`** — open issues #1–#10, smaller refinements, and the removed-tooling milestones table. Use when picking up a roadmap task or asking why something was removed.
- **`architecture`** — Neo4j graph schema (Transaction-as-Node), group rules, container startup, the full REST API endpoint table, PostgreSQL tables, two-tier storage, and the AML Cypher queries in `graph/queries.py`. Use when touching API routes, graph schema, Cypher, or PG tables.
- **`etl-rs`** — Rust ETL workspace under `etl-rs/`: crates, data-flow diagram, `ingest` CLI, the `worker` binary's three tasks, build commands, consumer-group reset. Use when modifying anything under `etl-rs/` or debugging the pipeline.
- **`conventions`** — code-style rules per stack (Python/TS/Tailwind/Cypher). Use when writing or reviewing code.

## Project Overview

Chain-Analysis is a blockchain transaction analysis platform for detecting and investigating money laundering patterns on Ethereum and EVM-compatible chains. The system models blockchain entities as a property graph, enables human analysts to label suspicious activity, and provides a visual interface for exploring transaction flows.

## Technology Stack

**Backend (Python):** FastAPI, Dagster (dormant — only `reprocess_job` + `backfill_job`; targeted ingestion goes through the Rust `worker`), Neo4j 5.x + GDS, PostgreSQL 17, Redis Streams, SQLAlchemy async + asyncpg + Alembic, JWT auth (`python-jose`, 24h `localStorage`).

**Frontend:** React 18 + TypeScript (Vite), React Router v6, Cytoscape.js (fcose), Tailwind CSS v3.

**Data Sources:** Etherscan API (`txlist` + `txlistinternal` for addresses; proxy API for block-range ingestion in the Rust `ingest`). Falls back to deterministic mock data when no API key is set.

## Project Structure

```
chain-analysis/
├── docker-compose.yml          # Neo4j, Postgres, Redis, ClickHouse, Backend, Frontend + optional profiles
├── .env.example
├── etl-rs/                     # Rust ETL workspace — see `etl-rs` skill
│   ├── Cargo.toml
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
│   ├── alembic.ini             # Async asyncpg driver
│   ├── alembic/env.py          # Async Alembic runner
│   ├── entrypoint.sh           # Container startup: migrations → seeds → uvicorn
│   ├── Dockerfile              # Multi-stage build; build context is repo root
│   └── src/
│       ├── api/
│       │   ├── main.py         # FastAPI app + lifespan
│       │   ├── models/         # Pydantic response models
│       │   └── routes/         # auth, entities, features, groups, health, ingestion, labels, pipeline, stats
│       ├── core/
│       │   ├── config.py       # Pydantic BaseSettings, @lru_cache
│       │   ├── ports/graph_db.py
│       │   └── adapters/       # neo4j_adapter, postgres_adapter, redis_adapter
│       ├── services/auth.py    # Password hashing, JWT token creation/decode
│       ├── libs/logger.py
│       ├── etl/                # Dagster assets, resources, jobs (optional)
│       ├── graph/queries.py    # AML detection Cypher queries
│       └── db/                 # SQLAlchemy models + Alembic migrations
└── frontend/
    ├── Dockerfile
    ├── tailwind.config.js
    └── src/
        ├── App.tsx
        ├── context/            # ToastContext, AuthContext
        ├── hooks/              # useToast, useGraphStats, useHealth
        ├── components/         # GraphCanvas, NodePanel, TxPanel, SearchBar, Nav, CopyButton, etc.
        ├── pages/              # Home, Login, Signup, GraphExplorer, Groups, ETL, Labels, Dashboard
        ├── api/client.ts       # Fetch wrappers (JWT, noContent flag)
        ├── types/index.ts
        └── index.css           # Reset, :root tokens, .grid-bg, .app-shell, scrollbar
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

For the Rust ETL build / `ingest` / `worker` commands, see the `etl-rs` skill.

## Environment Variables

Set in `docker-compose.yml` for local dev; override in `.env` for external deployments:
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REDIS_URL`
- `ETHERSCAN_API_KEY` — required for real blockchain data (free at etherscan.io/apis)
- `JWT_SECRET_KEY` — secret for signing JWT tokens

## Documentation

Operations and demo guide: `docs/etl-ts.md`
