# Chain-Analysis — Operations Guide

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
# Edit .env and set ETHERSCAN_API_KEY=your_key_here
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
| http://localhost:5173 | Frontend (dev server — `npm run dev`) |
| http://localhost:8000/docs | Backend API (Swagger UI) |
| http://localhost:7474 | Neo4j Browser (neo4j / password123) |

---

## Data Ingestion

There are two ways to get real blockchain data into the system.

### Method A: Web UI / API

The Python backend fetches from Etherscan directly — no Rust binaries needed.

**Via the UI:** Open the ETL page → enter an address → click Ingest.

**Via curl:**

```bash
curl -X POST http://localhost:8000/api/pipeline/ingest-address \
  -H "Content-Type: application/json" \
  -d '{"address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}'
```

### Method B: Rust Pipeline

For bulk ingestion (large block ranges, follow mode, or batching thousands of addresses). Fetches ALL transactions with configurable concurrency and processes via Redis queue.

```
[Etherscan API]
      │   ← ingest binary (Rust)
      ▼
[Redis Streams]  (ingested_txs, ingested_traces, ingested_transfers)
      │   ← process binary (Rust)
      ▼
[Neo4j + PostgreSQL]
```

#### Build

```bash
cd etl-rs
cargo build --release
# Outputs: etl-rs/target/release/ingest  and  etl-rs/target/release/process
```

#### Run

The binaries connect directly to the Docker-hosted data services on localhost.

```bash
# Set environment (or load from .env)
export ETHERSCAN_API_KEY=...
export REDIS_URL=redis://localhost:6379
export NEO4J_URI=bolt://localhost:7687
export NEO4J_PASSWORD=password123
export DATABASE_URL=postgresql://postgres:postgres123@localhost:5432/chain_analysis

# Step 1: ingest
etl-rs/target/release/ingest --address 0x... --with-traces --with-transfers

# Step 2: process
etl-rs/target/release/process --one-shot
```

---

#### `ingest` CLI reference

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
      --fetch-concurrency <N>
          Number of block fetches to keep in flight concurrently [default: 5]

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

#### `process` CLI reference

```
Redis consumer → Neo4j + PostgreSQL writer

Reads a combined batch from all three Redis streams (txs, traces, transfers)
in a single XREADGROUP call, resolves entities, computes features, and writes
to Neo4j and PostgreSQL in parallel.

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
          How long to block waiting for new Redis messages (milliseconds).
          0 = non-blocking (returns immediately if empty). [default: 5000]
      --run-id <UUID>
          Run identifier (auto-generated if not set)
  -h, --help
          Print help
```

#### Common recipes

**Ingest a specific address (all transactions, traces, and token transfers):**

```bash
etl-rs/target/release/ingest \
  --address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 \
  --with-traces --with-transfers
```

**Process one batch of 500 then exit:**

```bash
etl-rs/target/release/process --one-shot
```

**Process all remaining messages (continuous, press Ctrl+C when idle):**

```bash
etl-rs/target/release/process
```

**Ingest a block range (mock data, no API key needed):**

```bash
etl-rs/target/release/ingest --start-block 18000000 --end-block 18000100
```

**Dry-run (print to stdout, no Redis writes):**

```bash
etl-rs/target/release/ingest --address 0x... --dry-run
```

**Continuous follow mode (keeps up with the chain):**

```bash
etl-rs/target/release/ingest --follow --poll-interval 12 --with-traces --with-transfers
```

---

#### Environment variables

**`ingest`**

| Variable | Default | Description |
|----------|---------|-------------|
| `ETHERSCAN_API_KEY` | — | Required for address mode and real block data |
| `ETHERSCAN_BASE_URL` | `https://api.etherscan.io/v2/api` | Etherscan V2 endpoint |
| `ETHERSCAN_CHAIN_ID` | `1` | Chain ID (1 = Ethereum mainnet) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |

**`process`**

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

---

#### Multi-chain support

The `ingest` binary supports any EVM chain via Etherscan V2 API. Set `ETHERSCAN_CHAIN_ID`:

| Chain | ID |
|---|---|
| Ethereum Mainnet | `1` (default) |
| Sepolia Testnet | `11155111` |
| BSC | `56` |
| Polygon | `137` |
| Arbitrum One | `42161` |
| Optimism | `10` |

```bash
ETHERSCAN_CHAIN_ID=11155111 etl-rs/target/release/ingest \
  --start-block 5000000 --end-block 5000010
```

---

#### Full pipeline (bulk ingestion)

```bash
# 1. Start infrastructure (Neo4j, Postgres, Redis, backend, frontend)
docker compose up -d

# 2. Build the Rust binaries
cd etl-rs && cargo build --release && cd ..

# 3. Export env (or load from .env)
export ETHERSCAN_API_KEY=...
export REDIS_URL=redis://localhost:6379
export NEO4J_URI=bolt://localhost:7687
export NEO4J_PASSWORD=password123
export DATABASE_URL=postgresql://postgres:postgres123@localhost:5432/chain_analysis

# 4. Ingest then process
etl-rs/target/release/ingest \
  --start-block 21000000 --end-block 21000100 \
  --with-traces --with-transfers
etl-rs/target/release/process

# 5. Open http://localhost:5173
```

---

## Verification

### Check Redis streams

```bash
# Message counts per stream
docker exec chain-analysis-redis redis-cli XLEN ingested_txs
docker exec chain-analysis-redis redis-cli XLEN ingested_traces
docker exec chain-analysis-redis redis-cli XLEN ingested_transfers

# Current ingest cursor
docker exec chain-analysis-redis redis-cli GET ingest:last_block:etherscan

# Pending messages (delivered to consumer but not yet acked)
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
# Kill any running ingest/process processes (Ctrl+C, or kill <pid>)

# Clear all Redis streams and cursors
docker exec chain-analysis-redis redis-cli DEL \
  ingested_txs ingested_traces ingested_transfers \
  ingestion_progress processing_progress \
  ingest:last_block:etherscan ingest:failed_blocks:etherscan

# Clear Neo4j (removes ALL nodes — irreversible)
docker exec chain-analysis-neo4j cypher-shell -u neo4j -p password123 \
  "MATCH (n) DETACH DELETE n"
```

### Retry failed blocks

```bash
# Check which blocks failed
docker exec chain-analysis-redis redis-cli SMEMBERS ingest:failed_blocks:etherscan

# Re-ingest a specific block
etl-rs/target/release/ingest --start-block <FAILED_BLOCK> --end-block <FAILED_BLOCK>

# Clear the failed set after success
docker exec chain-analysis-redis redis-cli DEL ingest:failed_blocks:etherscan
```

### Scale processing

Run multiple `process` instances in separate terminals under the same consumer group — Redis distributes messages so each message goes to exactly one consumer:

```bash
# Terminal 1
PROCESS_CONSUMER_NAME=consumer-1 etl-rs/target/release/process

# Terminal 2
PROCESS_CONSUMER_NAME=consumer-2 etl-rs/target/release/process
```

### Monitor progress

```bash
# Watch stream length over time
watch -n 5 'docker exec chain-analysis-redis redis-cli XLEN ingested_txs'

# Stream live processing events
docker exec chain-analysis-redis redis-cli XREAD BLOCK 0 STREAMS processing_progress $
```

### Redis streams reference

| Stream | Producer | Consumer | Content |
|---|---|---|---|
| `ingested_txs` | `ingest` | `process` | JSON `Transaction` |
| `ingested_traces` | `ingest` | `process` | JSON `Trace` |
| `ingested_transfers` | `ingest` | `process` | JSON `Transfer` |
| `ingestion_progress` | `ingest` | monitoring | Progress / Complete / Error events |
| `processing_progress` | `process` | monitoring | Progress / Complete / Error events |

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
| GET | `/api/entities/{address}/neighbors` | 1-hop neighborhood (`depth`, `direction`, `limit`) |
| GET | `/api/entities/{src}/paths/{tgt}` | Paths between two entities (`max_depth`, `limit`) |
| GET | `/api/entities/{address}/features` | Computed features from PostgreSQL |
| PUT | `/api/entities/{address}/features` | Upsert features |
| GET | `/api/entities/{address}/members` | List group members |
| POST | `/api/entities/{address}/members` | Add member to group |
| DELETE | `/api/entities/{address}/members/{member}` | Remove member |

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

### Ingestion Runs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ingestion-runs` | List runs (`limit`, `offset`) |
| GET | `/api/ingestion-runs/{run_id}` | Get single run |

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

**Entity properties:** `address` (unique), `risk_level`, `name`, `entity_type`, `description`, `is_group`

**Transaction properties:** `hash` (unique), `value` (wei string), `block_number`, `timestamp`, `gas_used`, `gas_price`, `from_address`, `to_address`

**Trace properties:** `uid` (unique), `transaction_hash`, `block_number`, `from_address`, `to_address`, `value`, `call_type`

**TokenTransfer properties:** `uid` (unique), `transaction_hash`, `block_number`, `token_address`, `from_address`, `to_address`, `amount`

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

The consumer group's read position is stuck past the unprocessed messages. Reset all three streams:

```bash
docker exec chain-analysis-redis redis-cli XGROUP SETID ingested_txs chain-analysis-process 0
docker exec chain-analysis-redis redis-cli XGROUP SETID ingested_traces chain-analysis-process 0
docker exec chain-analysis-redis redis-cli XGROUP SETID ingested_transfers chain-analysis-process 0
```

Then re-run process. Note: `--one-shot` processes one batch of 500. For large datasets omit `--one-shot` and press Ctrl+C when the log shows 0 new messages.

### Etherscan 429 rate limit

Free Etherscan keys allow 5 req/s. The web ingestion endpoint makes 2 requests per call. Reduce `--fetch-concurrency` (block mode) or wait between rapid address requests.

### Neo4j `APOC not available` warning

The APOC-based sub-label assignment (`apoc.create.addLabels`) is optional. The adapter falls back to plain `MERGE` automatically — entity sub-labels (`:EOA`, `:Mixer`, etc.) won't be set but the data is fully usable.

### Check what's in Redis

```bash
docker exec chain-analysis-redis redis-cli XLEN ingested_txs
docker exec chain-analysis-redis redis-cli XINFO GROUPS ingested_txs
```
