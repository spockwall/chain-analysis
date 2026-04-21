# etl-rs

Rust ETL workers for chain-analysis. Redis Streams fan out to two independent
consumer groups — one writes the operational graph, the other the analytical
columnar store:

```
                            [Etherscan API]
                                  │   ← ingest
                                  ▼
                 [Redis Streams]  (ingested_txs / traces / transfers)
                       │                          │
       ← process ──────┤                          ├── ← clickhouse-process
                       ▼                          ▼
              [Neo4j + PostgreSQL]            [ClickHouse]
              (graph + features)              (OLAP / BI)
```

The two consumer groups (`chain-analysis-process` and `chain-analysis-clickhouse`)
share the same streams but ack independently, so analytical writes can't
back-pressure graph ingest and vice versa.

## Workspace layout

| Crate | Role |
|---|---|
| `types` | Shared on-chain value types (`Transaction`, `Trace`, `Transfer`, entity enums) |
| `config` | Env-based `Config` and `ProcessConfig` |
| `sources` | Etherscan V2 client + deterministic mock generator |
| `sinks` | Redis Streams writer, Redis consumer, Neo4j + Postgres + ClickHouse writers |
| `pipeline` | Retry policy, DLQ helpers, shutdown handle, progress reporters |
| `ingest` | `ingest` binary — fetches from Etherscan and publishes to Redis Streams |
| `process` | `process` binary (Neo4j + Postgres) and `clickhouse-process` binary (ClickHouse) |

## Build

```bash
cargo build --release
# → target/release/ingest
# → target/release/process
# → target/release/clickhouse-process
```

## `ingest`

Subcommands (plus legacy flat args kept as fallback):

```bash
# Block range (mock mode if ETHERSCAN_API_KEY unset)
ingest block --start 20000000 --end 20000005

# Follow tip with graceful shutdown on SIGINT/SIGTERM
ingest block --follow --poll-interval 12

# All transactions for a single address
ingest address 0xdeadbeef...

# Drain ingest:failed_blocks:{source} and re-run them
ingest reprocess-failed --source etherscan

# Targeted fetches (addresses / hashes / neighborhood / from queue)
ingest targeted addresses --addrs 0xaaa...,0xbbb...
ingest targeted hashes --hashes 0x111...,0x222...
ingest targeted neighborhood 0xseed... --hops 1
ingest targeted from-label-tasks --limit 50
```

The `from-label-tasks` mode drains the Redis list `INGEST_TARGETED_QUEUE`
populated by the backend's `POST /api/labels/fetch`.

## `process`

```bash
process             # continuous, Ctrl+C for graceful shutdown
process --one-shot  # read one batch and exit
```

Poison batches are quarantined to `{stream}_dlq` after
`PROCESS_DLQ_MAX_ATTEMPTS` failed attempts.

## `clickhouse-process`

Independent consumer (group `chain-analysis-clickhouse`) that inserts the same
stream messages into ClickHouse analytical tables.

```bash
clickhouse-process             # continuous
clickhouse-process --one-shot  # read one batch and exit
```

Tables (`chain_analysis.transactions`, `.traces`, `.token_transfers`) follow
strict ethereum-etl / BigQuery column naming. The DDL lives in
`crates/sinks/migrations/clickhouse/*.sql` and is auto-applied by the
ClickHouse container via `/docker-entrypoint-initdb.d`.

Caveat: `value` / `gas_price` are declared `UInt256` in the schema but the
writer serializes them as `u128`. Every real ETH transaction fits
(max whale tx ≈ 10^24 wei; u128 caps at ~3.4·10^38). Over-u128 values are
logged and zeroed. Full 256-bit fidelity can be added later by switching the
`Row` fields to `[u8; 32]` with `#[serde(with = "clickhouse::serde::uint256")]`.

DLQ routing mirrors `process`, using `CLICKHOUSE_DLQ_*` env vars so the two
consumer groups can tune retries independently.

The Python backend queries ClickHouse directly (via `clickhouse-driver` or
`clickhouse-connect`) — no Rust `query` crate yet. A Rust CLI over the same
tables is a later item.

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `ETHERSCAN_API_KEY` | *(unset → mock data)* | ingest |
| `ETHERSCAN_BASE_URL` | `https://api.etherscan.io/v2/api` | ingest |
| `ETHERSCAN_CHAIN_ID` | `1` | ingest |
| `REDIS_URL` | `redis://localhost:6379` | ingest, process |
| `INGEST_BATCH_SIZE` | `1000` | ingest |
| `INGEST_STREAM_MAXLEN` | `1000000` (`0` disables) | ingest |
| `INGEST_TARGETED_QUEUE` | `ingest:targeted_queue` | ingest, backend |
| `NEO4J_URI` | `bolt://localhost:7687` | process |
| `NEO4J_USER` | `neo4j` | process |
| `NEO4J_PASSWORD` | `password123` | process |
| `NEO4J_DATABASE` | `neo4j` | process |
| `DATABASE_URL` | `postgresql://postgres:postgres123@localhost:5432/chain_analysis` | process |
| `PROCESS_BATCH_SIZE` | `500` | process |
| `PROCESS_CONSUMER_GROUP` | `chain-analysis-process` | process |
| `PROCESS_CONSUMER_NAME` | `consumer-{pid}` | process |
| `PROCESS_DLQ_MAX_ATTEMPTS` | `5` | process |
| `PROCESS_DLQ_SUFFIX` | `_dlq` | process |
| `PROCESS_DLQ_ATTEMPT_TTL_SECS` | `86400` | process |
| `CLICKHOUSE_URL` | `http://localhost:8123` | clickhouse-process, backend |
| `CLICKHOUSE_DATABASE` | `chain_analysis` | clickhouse-process, backend |
| `CLICKHOUSE_USER` | `default` | clickhouse-process, backend |
| `CLICKHOUSE_PASSWORD` | *(empty)* | clickhouse-process, backend |
| `CLICKHOUSE_BATCH_SIZE` | `1000` | clickhouse-process |
| `CLICKHOUSE_CONSUMER_GROUP` | `chain-analysis-clickhouse` | clickhouse-process |
| `CLICKHOUSE_CONSUMER_NAME` | `ch-consumer-{pid}` | clickhouse-process |
| `CLICKHOUSE_DLQ_MAX_ATTEMPTS` | `5` | clickhouse-process |
| `CLICKHOUSE_DLQ_SUFFIX` | `_dlq` | clickhouse-process |
| `CLICKHOUSE_DLQ_ATTEMPT_TTL_SECS` | `86400` | clickhouse-process |

## Test

Tests are split into two tiers. Unit tests have no external dependencies;
integration tests are gated on `E2E_REDIS_URL` and skip cleanly when it's unset.

```bash
# Unit tests only (pure logic, no services)
cargo test --workspace --lib --bins

# All tests including Redis-gated integration tests
E2E_REDIS_URL=redis://localhost:6379 cargo test --workspace

# A single integration suite
E2E_REDIS_URL=redis://localhost:6379 cargo test -p pipeline --test dlq
E2E_REDIS_URL=redis://localhost:6379 cargo test -p sinks    --test maxlen
E2E_REDIS_URL=redis://localhost:6379 cargo test -p ingest   --test reprocess
E2E_REDIS_URL=redis://localhost:6379 cargo test -p ingest   --test e2e

# ClickHouse writer (separate gate so it skips when CH isn't up)
E2E_CLICKHOUSE_URL=http://localhost:8123 \
  CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=clickhouse123 \
  cargo test -p sinks --test clickhouse
```

Integration coverage:

| Suite | Gate | Exercises |
|---|---|---|
| `pipeline::dlq` | `E2E_REDIS_URL` | `incr_attempt` counter + TTL; full `move_batch_to_dlq` round-trip (XADD → XREADGROUP → DLQ move → XACK) |
| `sinks::maxlen` | `E2E_REDIS_URL` | `MAXLEN ~ N` caps stream size; `None` leaves stream untrimmed |
| `sinks::clickhouse` | `E2E_CLICKHOUSE_URL` | Per-run DB; insert 10 txs / 5 traces / 7 transfers; SELECT-back verifies counts, ethereum-etl column names, `trace_id` composition |
| `ingest::reprocess` | `E2E_REDIS_URL` | `reprocess_failed_blocks` drains `ingest:failed_blocks:{source}` |
| `ingest::e2e` | `E2E_REDIS_URL` | Mock ingest populates `ingested_txs`; `from-label-tasks` drains `INGEST_TARGETED_QUEUE` |

CI (`.github/workflows/rust.yml`) runs `fmt`, `clippy`, `test-unit`, and
`test-integration` (with Redis + ClickHouse service containers) on every
push/PR that touches `etl-rs/`.

## Operational notes

Reset a stuck consumer group:

```bash
redis-cli XGROUP SETID ingested_txs chain-analysis-process 0
```

Inspect the DLQ:

```bash
redis-cli XLEN ingested_txs_dlq
redis-cli XRANGE ingested_txs_dlq - + COUNT 5
```
