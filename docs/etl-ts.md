# Chain-Analysis — Demo Guide

Complete reference for running and demonstrating the platform.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Data Ingestion](#data-ingestion)
   - [Method A: Web UI / API (recommended for demos)](#method-a-web-ui--api)
   - [Method B: Rust Pipeline (bulk ingestion)](#method-b-rust-pipeline)
3. [Verification](#verification)
4. [Operations](#operations)
5. [Frontend Pages](#frontend-pages)
6. [API Reference](#api-reference)
7. [Database Schemas](#database-schemas)
8. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Prerequisites

- Docker + Docker Compose
- Etherscan API key (free at https://etherscan.io/apis) — required for real data

### 1. Configure

```bash
cp .env.example .env
# Edit .env and set:
#   ETHERSCAN_API_KEY=your_key_here
```

### 2. Start all services

```bash
docker compose up -d
```

Starts: Neo4j, PostgreSQL, Redis, MinIO, Backend (port 8000), Frontend (port 3000).

On every start the backend automatically runs Alembic migrations, creates Neo4j indexes, and seeds sample data.

### 3. Open the app

| URL | Service |
|-----|---------|
| http://localhost:3000 | Frontend (Docker) |
| http://localhost:8000/docs | Backend API (Swagger UI) |
| http://localhost:7474 | Neo4j Browser (neo4j / password123) |

---

## Data Ingestion

There are two ways to get real blockchain data into the system.



#### Via API

```bash
curl -X POST http://localhost:8000/api/pipeline/ingest-address \
  -H "Content-Type: application/json" \
  -d '{"address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}'
```

### Method: Rust Pipeline

**Best for bulk ingestion.** Fetches ALL transactions (paginated) and processes via Redis queue.

```
[Etherscan API]
      │   ← ingest binary (Rust)
      ▼
[Redis Streams]  (ingested_txs, ingested_traces, ingested_transfers)
      │   ← process binary (Rust)
      ▼
[Neo4j + PostgreSQL]
```

Flow: `ingest` → Redis Streams → `process` → Neo4j + PostgreSQL

#### Build

```bash
docker compose build ingest
docker compose build process   # already built if using --profile etl
```

#### `ingest --help`

```
Blockchain transaction ingestion worker

Fetches Ethereum transactions from Etherscan and writes them to Redis Streams.

Two modes:

ADDRESS MODE  (--address 0x...)
  Fetches all transactions for a specific address via Etherscan account APIs.
  Requires ETHERSCAN_API_KEY. No mock fallback.

BLOCK MODE  (--start-block N --end-block M)
  Fetches all transactions in a block range via Etherscan proxy APIs.
  Falls back to deterministic mock data when ETHERSCAN_API_KEY is not set.

After running ingest, run the `process` binary to consume Redis → Neo4j + PostgreSQL.

Usage: ingest [OPTIONS]

Options:
  Address mode:
      --address <ADDRESS>
          Ethereum address to fetch (enables address mode). Requires ETHERSCAN_API_KEY.
      --addr-start-block <N>
          Earliest block to include [default: 0]
      --addr-end-block <N>
          Latest block to include [default: 99999999]

  Block mode:
      --start-block <N>
          First block to fetch. Defaults to last saved cursor, or chain tip.
      --end-block <N>
          Last block to fetch. Defaults to current chain tip.
      --follow
          Keep polling for new blocks after initial range is done.
      --poll-interval <SECS>
          Seconds between polls in follow mode [default: 12]

  Data options (both modes):
      --with-traces
          Also fetch internal transactions (traces)
      --with-transfers
          Also fetch ERC-20 token transfers

  Output / behaviour:
      --dry-run
          Print to stdout instead of writing to Redis (testing)
      --source <SOURCE>
          Label for the Redis cursor key [default: etherscan]
      --max-retries <N>
          Max retries per Etherscan request [default: 5]
      --retry-backoff-secs <N>
          Initial retry backoff in seconds [default: 1]
      --run-id <UUID>
          Run identifier (auto-generated if not set)
  -h, --help
          Print help
```

#### `process --help`

```
Redis consumer → Neo4j graph writer

Consumes IngestionMessages from Redis Streams and writes entities,
transactions, traces, and transfers to Neo4j and PostgreSQL.

Run after `ingest` has written data to Redis:

  One-shot:   process --one-shot   (read one batch then exit)
  Continuous: process              (read until Ctrl+C)

Usage: process [OPTIONS]

Options:
      --one-shot
          Read one batch from Redis then exit. Without this flag the
          worker runs continuously until Ctrl+C.
      --batch-size <N>
          Max messages to read per XREADGROUP call (per stream) [default: 500]
      --block-ms <MS>
          How long to block waiting for new Redis messages in milliseconds.
          0 = non-blocking (returns immediately if no messages). [default: 5000]
      --run-id <UUID>
          Run identifier (auto-generated if not set)
  -h, --help
          Print help
```

#### Docker Compose flags

These flags appear in every `docker compose run` command — they are **Docker** flags, not `ingest`/`process` flags:

| Flag | Description |
|------|-------------|
| `--profile ingest` | Activates the `ingest` service (defined with `profiles: [ingest]` in docker-compose.yml). Without this, `docker compose run ingest` will fail with "no such service". |
| `--profile etl` | Activates the `process` service (defined with `profiles: [etl]`). |
| `--rm` | Automatically removes the container after it exits. Without this, stopped containers accumulate and take up disk space. Always use `--rm` for one-off runs. |

So the full pattern is:
```
docker compose --profile <profile> run --rm <service> [binary flags...]
```

---

#### Common usage

**Ingest a specific address (all transactions, traces, and token transfers):**

```bash
docker compose --profile ingest run --rm ingest \
  --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 \
  --with-traces \
  --with-transfers
```

**Process ALL messages in Redis (continuous until done):**

```bash
docker compose --profile etl run --rm process
# Press Ctrl+C when log shows 0 new messages
```

**Process one batch of 500 then exit:**

```bash
docker compose --profile etl run --rm process --one-shot
```

**Ingest a block range (with mock data, no API key needed):**

```bash
docker compose --profile ingest run --rm ingest \
  --start-block 18000000 --end-block 18000100
```

**Dry-run — print to stdout only, no Redis writes:**

```bash
docker compose --profile ingest run --rm ingest \
  --address 0x... --dry-run
```

#### Environment variables for `ingest`

| Variable | Default | Description |
|----------|---------|-------------|
| `ETHERSCAN_API_KEY` | — | Required for address mode and real block data |
| `ETHERSCAN_BASE_URL` | `https://api.etherscan.io/v2/api` | Etherscan V2 endpoint |
| `ETHERSCAN_CHAIN_ID` | `1` | Chain ID (1 = Ethereum mainnet) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `INGEST_BATCH_SIZE` | `1000` | Batch size hint |

#### Environment variables for `process`

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | `password123` | Neo4j password |
| `NEO4J_DATABASE` | `neo4j` | Neo4j database name |
| `DATABASE_URL` | `postgresql://postgres:postgres123@localhost:5432/chain_analysis` | PostgreSQL |
| `PROCESS_BATCH_SIZE` | `500` | Default batch size |
| `PROCESS_CONSUMER_GROUP` | `chain-analysis-process` | Redis consumer group name |
| `PROCESS_CONSUMER_NAME` | `consumer-{pid}` | Redis consumer name |

#### Multi-chain support

The `ingest` binary supports any EVM chain via Etherscan V2 API. Set `ETHERSCAN_CHAIN_ID`:

| Chain | ID | Notes |
|---|---|---|
| Ethereum Mainnet | `1` | Default |
| Sepolia Testnet | `11155111` | Recommended testnet |
| BSC | `56` | Binance Smart Chain |
| Polygon | `137` | — |
| Arbitrum One | `42161` | L2 |
| Optimism | `10` | L2 |

```bash
docker compose --profile ingest run --rm \
  -e ETHERSCAN_CHAIN_ID=11155111 \
  ingest --start-block 5000000 --end-block 5000010
```

#### Full pipeline (all-in-one)

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Build ETL images
docker compose build ingest process

# 3. Start the process worker (background, picks up messages automatically)
docker compose --profile etl up -d process

# 4. Ingest real blocks
docker compose --profile ingest run --rm ingest \
  --start-block 21000000 --end-block 21000100 \
  --with-traces --with-transfers

# 5. Open http://localhost:3000
```

For continuous ingestion (keeps up with the chain):

```bash
docker compose --profile ingest run --rm ingest \
  --follow --poll-interval 12 --with-traces --with-transfers
```

---

## Verification

### Check Redis streams

```bash
# Total messages ingested
docker exec chain-analysis-redis redis-cli XLEN ingested_txs

# Current ingest cursor
docker exec chain-analysis-redis redis-cli GET ingest:last_block:etherscan

# Pending messages (not yet processed)
docker exec chain-analysis-redis redis-cli XPENDING ingested_txs chain-analysis-process

# Inspect a sample message
docker exec chain-analysis-redis redis-cli XRANGE ingested_txs - + COUNT 1
```

### Check Neo4j

Open http://localhost:7474 (user: `neo4j`, password: `password123`):

```cypher
-- Entity and transaction counts
MATCH (e:Entity) RETURN count(e);
MATCH (t:Transaction) RETURN count(t);

-- Sample transaction with sender and receiver
MATCH (from:Entity)-[:SENT]->(t:Transaction)-[:RECEIVED]->(to:Entity)
RETURN from.address, t.hash, t.value, to.address
LIMIT 5;

-- Most active senders
MATCH (e:Entity)-[:SENT]->(t:Transaction)
RETURN e.address, count(t) AS tx_count
ORDER BY tx_count DESC LIMIT 10;
```

### Check the API

```bash
curl http://localhost:8000/api/stats | jq
curl http://localhost:8000/api/entities/0x... | jq
```

---

## Operations

### Reset the pipeline

```bash
# Stop workers
docker compose --profile etl down

# Clear all Redis streams and cursors
docker exec chain-analysis-redis redis-cli DEL \
  ingested_txs ingested_traces ingested_transfers \
  ingestion_progress processing_progress \
  ingest:last_block:etherscan ingest:failed_blocks:etherscan

# Clear Neo4j (optional — removes ALL nodes)
docker exec chain-analysis-neo4j cypher-shell -u neo4j -p password123 \
  "MATCH (n) DETACH DELETE n"

# Restart
docker compose --profile etl up -d process
```

### Retry failed blocks

```bash
# Check which blocks failed
docker exec chain-analysis-redis redis-cli SMEMBERS ingest:failed_blocks:etherscan

# Re-ingest a specific block
docker compose --profile ingest run --rm ingest \
  --start-block <FAILED_BLOCK> --end-block <FAILED_BLOCK>

# Clear the failed set after success
docker exec chain-analysis-redis redis-cli DEL ingest:failed_blocks:etherscan
```

### Scale processing

Run multiple process instances (same consumer group, different names):

```bash
docker run --rm --network chain-analysis-net \
  -e REDIS_URL=redis://redis:6379 \
  -e NEO4J_URI=bolt://neo4j:7687 \
  -e NEO4J_USER=neo4j \
  -e NEO4J_PASSWORD=password123 \
  -e DATABASE_URL=postgresql://postgres:postgres123@postgres:5432/chain_analysis \
  -e PROCESS_CONSUMER_NAME=consumer-2 \
  chain-analysis-etl-rs-process:latest
```

Redis consumer groups automatically distribute messages — each message goes to exactly one consumer.

### Monitor progress

```bash
# Watch stream length over time
watch -n 5 'docker exec chain-analysis-redis redis-cli XLEN ingested_txs'

# Watch processing progress stream
docker exec chain-analysis-redis redis-cli XREAD BLOCK 0 STREAMS processing_progress $
```

### Redis streams reference

| Stream | Producer | Consumer | Content |
|---|---|---|---|
| `ingested_txs` | `ingest` | `process` (consumer group) | JSON `Transaction` |
| `ingested_traces` | `ingest` | `process` (consumer group) | JSON `Trace` |
| `ingested_transfers` | `ingest` | `process` (consumer group) | JSON `Transfer` |
| `ingestion_progress` | `ingest` | monitoring | Progress/Complete/Error |
| `processing_progress` | `process` | monitoring | Progress/Complete/Error |

| Redis Key | Type | Description |
|---|---|---|
| `ingest:last_block:etherscan` | String | Last successfully ingested block number |
| `ingest:failed_blocks:etherscan` | Set | Block numbers that failed after all retries |

---

## Frontend Pages

| Page | URL | Description |
|------|-----|-------------|
| Home | `/` | Landing page |
| Login | `/login` | JWT login |
| Signup | `/signup` | User registration |
| Graph Explorer | `/explorer` | Interactive Cytoscape.js graph — search, path find, filter |
| Groups | `/groups` | Manage entity groups for investigations |
| ETL | `/etl` | Pipeline monitoring, address ingestion, entity feature lookup |
| Dashboard | `/dashboard` | System health + aggregate statistics |

### Graph Explorer

- Search an address → loads its 1-hop neighborhood
- Click entity nodes or transaction diamonds for detail panels
- **Path Finder**: find transaction paths between two addresses
- Filter panel: entity types, risk levels

### ETL Page

- **Service Status**: live health check for all backends
- **Graph Statistics**: entity count, transaction count, entity types
- **Ingest Address from Etherscan**: type an address → click Ingest → see results
- **Ingestion Runs**: table of all pipeline runs (auto-refreshes every 10s), click a row to expand
- **Entity Features**: look up computed features for any address
- **Lookup Entity / Transaction**: quick lookup by address or hash

---

## API Reference

Full interactive docs: http://localhost:8000/docs

### Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login → `{ access_token }` |
| POST | `/api/auth/register` | Register new user |
| GET | `/api/auth/me` | Get current user |

### Pipeline

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/pipeline/ingest-address` | Fetch address from Etherscan → Neo4j + PostgreSQL |

Request body: `{ "address": "0x...", "chain_id": 1 }`

### Entities

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/entities/{address}` | Get entity |
| PUT | `/api/entities/{address}` | Create / update entity |
| PATCH | `/api/entities/{address}` | Partial update |
| DELETE | `/api/entities/{address}` | Delete entity |
| GET | `/api/entities/{address}/neighbors` | 1-hop neighborhood |
| GET | `/api/entities/{src}/paths/{tgt}` | Paths between two entities |
| GET | `/api/entities/{address}/features` | Computed features |
| PUT | `/api/entities/{address}/features` | Upsert features |

Neighbors query params: `depth` (int), `direction` (in/out/both), `limit` (int)

### Transactions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/transactions/{hash}` | Get transaction by hash |
| PUT | `/api/transactions/{hash}` | Upsert transaction + SENT/RECEIVED edges |
| DELETE | `/api/transactions/{hash}` | Delete transaction + relationships |

### Groups

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/groups` | List all groups |
| POST | `/api/groups` | Create group |
| GET | `/api/groups/{address}` | Get group with members |
| PATCH | `/api/groups/{address}` | Update group |
| DELETE | `/api/groups/{address}` | Delete (must have 0 members) |
| GET | `/api/entities/{address}/members` | List members |
| POST | `/api/entities/{address}/members` | Add member |
| DELETE | `/api/entities/{address}/members/{member}` | Remove member |

### Ingestion Runs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ingestion-runs` | List runs (paginated, newest first) |
| GET | `/api/ingestion-runs/{run_id}` | Get single run |

Query params: `limit` (1–100, default 20), `offset` (default 0)

### Stats & Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | Graph statistics |
| GET | `/health` | Full service health check |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe (503 if Neo4j or PG down) |

### Labels

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/labels/tasks` | Create a label task |
| GET | `/api/labels/tasks` | List tasks (optional `status` filter) |
| GET | `/api/labels/tasks/{task_id}` | Get single task |
| POST | `/api/labels/annotations` | Submit annotation |
| GET | `/api/labels/annotations/{address}` | Get annotations for address |

---

## Database Schemas

### Neo4j Graph

**Pattern:** `(from:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(to:Entity)`

**Entity node labels:** `:Entity` (base), `:EOA`, `:Contract`, `:Mixer`, `:LendingPool`, `:Bridge`, `:DEX`, `:CEXHotWallet`, `:Application`

**Entity properties:** `address` (unique index), `risk_level`, `name`, `entity_type`, `description`

**Transaction properties:** `hash` (unique index), `value` (wei string), `block_number`, `timestamp`, `gas_used`, `gas_price`, `from_address`, `to_address`

**Group membership:** `(member:Entity)-[:IN_GROUP]->(group:Entity)`

### PostgreSQL — `entity_features`

Computed on-chain behavioral attributes per address.

| Column | Type | Description |
|--------|------|-------------|
| `address` | varchar(42) PK | Ethereum address |
| `chain_id` | int | Chain ID (1 = mainnet) |
| `out_degree` | int | Outgoing transaction count |
| `in_degree` | int | Incoming transaction count |
| `unique_interacted_entities` | int | Unique counterparty count |
| `volume_in_wei` | numeric | Total incoming value (wei) |
| `volume_out_wei` | numeric | Total outgoing value (wei) |
| `first_seen_at` | timestamptz | Earliest transaction timestamp |
| `last_seen_at` | timestamptz | Latest transaction timestamp |
| `is_labeled` | bool | Has a known label in `known_labels` |
| `computed_at` | timestamptz | Last computation time |
| `is_peel_chain_suspect` | bool | AML: linear single-hop chain pattern |
| `is_fan_out_suspect` | bool | AML: fan-out to many receivers |
| `is_hopping_suspect` | bool | AML: rapid chain-hopping pattern |
| `mixer_interaction_count` | int | Transactions to/from known mixers |
| `bridge_interaction_count` | int | Transactions to/from known bridges |

### PostgreSQL — `ingestion_runs`

ETL pipeline execution history.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | Auto-increment |
| `run_id` | varchar | Unique run ID |
| `chain_id` | int | Chain ID |
| `start_block` / `end_block` | bigint | Block range processed |
| `data_source` | varchar | `etherscan-web` or `rust-process` |
| `status` | enum | `running` / `completed` / `failed` |
| `transactions_processed` | int | Transaction count |
| `nodes_created` | int | Entity count |
| `started_at` / `completed_at` | timestamptz | Timing |
| `error_message` | text | Error details if failed |

---

## Troubleshooting

### `ETHERSCAN_API_KEY not configured`

```bash
# Add to .env then rebuild backend
docker compose build backend && docker compose up -d backend
```

### `process --one-shot` finishes with `entities=0 transactions=0`

The Redis consumer group's read position may be stuck. Reset all three streams then re-run:

```bash
docker exec chain-analysis-redis redis-cli XGROUP SETID ingested_txs chain-analysis-process 0
docker exec chain-analysis-redis redis-cli XGROUP SETID ingested_traces chain-analysis-process 0
docker exec chain-analysis-redis redis-cli XGROUP SETID ingested_transfers chain-analysis-process 0
docker compose --profile etl run --rm process
```

Also note: `--one-shot` processes only **one batch of 500 messages**. For 10 000+ messages, omit `--one-shot` and press Ctrl+C when the log shows 0 new messages.

### Etherscan 429 rate limit

Free Etherscan keys allow 5 req/s. The web ingestion endpoint makes 2 requests per call. Wait a moment between rapid requests.

### Neo4j `APOC not available` warning

The APOC-based sub-label assignment (`apoc.create.addLabels`) is optional. The adapter falls back to plain `MERGE` automatically. Entity type sub-labels (`:EOA`, `:Mixer`, etc.) won't be set but the data is still fully usable.

### Check what's in Redis

```bash
docker exec chain-analysis-redis redis-cli XLEN ingested_txs
docker exec chain-analysis-redis redis-cli XINFO GROUPS ingested_txs
```
