---
name: architecture
description: Neo4j graph schema (Transaction-as-Node pattern, Entity/Trace/TokenTransfer labels, constraints/indexes), group entities rules, container startup sequence (entrypoint.sh), full REST API endpoint table (/health, /api/auth, /api/entities, /api/transactions, /api/groups, /api/pipeline, /api/ingestion-runs, /api/labels, /api/stats), PostgreSQL tables (entity_features, ingestion_runs, raw_transactions, known_labels, label_tasks, annotations, users), two-tier hot/warm storage strategy, and custom AML Cypher queries in graph/queries.py (peel chain, structuring, round trip, fan-out/fan-in, mixer interaction, high-risk paths). Invoke when adding/changing API routes, modifying graph schema, writing Cypher, touching PG tables, or explaining how data flows through Neo4j + PostgreSQL.
---

## Neo4j Graph Schema (Transaction-as-Node)

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

## Group Entities

Groups are ordinary Entity nodes (`is_group = true`). Rules:
- A group cannot be a member of itself
- An address can only belong to one group at a time (409 if already a member)
- A group with members cannot be deleted (409; remove all members first)

## Container Startup Sequence (`entrypoint.sh`)

On every container start the backend runs these steps before serving:
1. `alembic upgrade head` — PostgreSQL schema migrations
2. `seed_known_labels.py` — Seeds known Ethereum addresses into `known_labels`
3. `seed_users.py` — Seeds default auth users
4. `init_neo4j.py` — Creates Neo4j constraints and indexes (idempotent)
5. `seed_neo4j.py` — Seeds sample Transaction + Entity nodes (idempotent MERGE)
6. `uvicorn` — Starts the API server

## Backend API Endpoints

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

## PostgreSQL Tables

| Table | Purpose |
|-------|---------|
| `entity_features` | Computed on-chain behavioral metrics per address (degree, volume, AML indicators) |
| `ingestion_runs` | ETL pipeline execution history (status, counts, timing, error) |
| `raw_transactions` | Raw blockchain transaction archive (hash-partitioned) |
| `known_labels` | Seeded known Ethereum addresses with entity type and risk level |
| `label_tasks` | Human labeling workflow: tasks assigned per address |
| `annotations` | Human-submitted labels for task records |
| `users` | Auth users (email, hashed_password) |

## Two-Tier Storage Strategy

| Tier | Storage | Purpose |
|------|---------|---------|
| Hot | Neo4j | Active investigation subgraphs, GDS algorithms |
| Warm | PostgreSQL | Entity features, labeling data, ingestion history |

(A cold tier via MinIO/S3 was removed 2026-04-22; see roadmap Milestones.
ClickHouse is provisioned for future OLAP use — see roadmap #4.)

## Custom AML Queries (`graph/queries.py`)

All queries use the Transaction-as-Node pattern:
- `detect_peel_chain` — linear chain of single-output hops
- `detect_structuring` — fan-out to many receivers in a block window
- `detect_round_trip` — funds return to origin
- `detect_fan_out_fan_in` — layering through intermediaries
- `detect_mixer_interaction` — direct sends to/from Mixer-labeled nodes
- `find_high_risk_paths` — paths through high-risk labeled entities
