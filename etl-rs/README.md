# etl-rs

Rust ETL workers for chain-analysis. Redis Streams fan out to two independent
consumer groups — one writes the operational graph, the other the analytical
columnar store.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ External providers                                                           │
│  Etherscan V2 proxy API │ Alchemy JSON-RPC │ Mock (deterministic generator)  │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ HTTPS (reqwest + rate-limited client)
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Ingest tier — `ingest` binary (Rust, tokio)                                  │
│  • Mode dispatch: block / address / targeted / reprocess                     │
│  • `BlockSource` trait → Etherscan | Alchemy | Mock (factory per INGEST_SOURCE)│
│  • Concurrent fetch: `futures::stream::buffered` over `Arc<dyn BlockSource>` │
│  • `writer_pipeline`: fan-in → batched XADD MAXLEN ~ N                       │
│  • Graceful shutdown (tokio watch), retry w/ backoff, failed-block DLQ list  │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ XADD
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Message bus — Redis 7 Streams                                                │
│  ingested_txs │ ingested_traces │ ingested_transfers                         │
│  Two consumer groups read independently (no cross back-pressure):            │
│   ─ `chain-analysis-process`     → graph + features sink                     │
│   ─ `chain-analysis-clickhouse`  → OLAP sink                                 │
│  Poison batches → `{stream}_dlq` after PROCESS_DLQ_MAX_ATTEMPTS              │
└───────────────┬──────────────────────────────────────┬───────────────────────┘
                │ XREADGROUP                           │ XREADGROUP
                ▼                                      ▼
┌──────────────────────────────┐      ┌──────────────────────────────────────┐
│ Graph consumer — `process`   │      │ OLAP consumer — `clickhouse-process` │
│  Rust, tokio                 │      │  Rust, tokio                         │
│  • Neo4j writer (bolt,neo4rs)│      │  • ClickHouse writer (clickhouse-rs) │
│  • Postgres writer (sqlx)    │      │  • ethereum-etl column names         │
│  • Feature derivation        │      │  • Batched INSERT, DDL auto-applied  │
│  • Per-batch DLQ w/ TTL ctr  │      │  • Per-batch DLQ (separate env vars) │
└──────────────┬───────────────┘      └─────────────────┬────────────────────┘
               ▼                                        ▼
┌──────────────────────────────┐      ┌──────────────────────────────────────┐
│ Hot + Warm OLTP              │      │ Warm OLAP                            │
│  Neo4j 5 + GDS (graph)       │      │  ClickHouse (analytical tables)      │
│  PostgreSQL 17 (features,    │      │  chain_analysis.transactions /       │
│  labels, run history, auth)  │      │   .traces / .token_transfers         │
└──────────────┬───────────────┘      └─────────────────┬────────────────────┘
               │                                        │
               └────────────────┬───────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Query / API tier — Python FastAPI backend                                    │
│  • Neo4j async driver (Cypher), asyncpg (Postgres), clickhouse-connect       │
│  • REST endpoints: entities, transactions, groups, paths, features, labels   │
│  • JWT auth (python-jose), SQLAlchemy async + Alembic migrations             │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ HTTP/JSON
                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Frontend — React 18 + TypeScript (Vite)                                      │
│  Cytoscape.js (fcose) for graph canvas, React Router v6, Tailwind v3         │
└──────────────────────────────────────────────────────────────────────────────┘

Cold tier (archive): MinIO (S3-compatible) — raw data, ML training, compliance.
Orchestration: Dagster webserver + daemon wrap the `ingest` binary as
subprocess-executed jobs (backfill, reprocess, targeted drain). See the
Orchestration section below.
Observability: Prometheus scrapes `/metrics` from every Rust worker; Grafana
renders the `ETL Overview` dashboard; Alertmanager routes rule violations.
See the Observability section below.
```

### Per-layer tooling

| Layer | Tool / Library | Purpose |
|---|---|---|
| External fetch | `reqwest` + rate-limited client | Etherscan V2 / Alchemy JSON-RPC |
| Ingest runtime | `tokio` + `futures::stream::buffered` | Concurrent block fetch |
| Source abstraction | `async_trait` `BlockSource` | Swap providers at runtime |
| Message bus | Redis 7 Streams | Durable buffer, independent consumer groups |
| Graph store | Neo4j 5 + GDS, `neo4rs` (Rust), async neo4j (Python) | Transaction-as-Node graph |
| Relational store | PostgreSQL 17, `sqlx` (Rust), `asyncpg` (Python) | Features, labels, auth, run history |
| Analytical store | ClickHouse, `clickhouse-rs` (Rust), `clickhouse-connect` (Python) | OLAP / BI |
| Object store | MinIO (S3 API) | Cold archive, Parquet exports |
| API | FastAPI + Pydantic | REST façade |
| Frontend | React 18 + Vite + Cytoscape.js | Analyst UI |
| Orchestration | Dagster (webserver + daemon) | Scheduling, sensors, lineage |
| Observability | Prometheus / Grafana / Alertmanager | Metrics, dashboards, alerting |

The two consumer groups (`chain-analysis-process` and `chain-analysis-clickhouse`)
share the same streams but ack independently, so analytical writes can't
back-pressure graph ingest and vice versa.

## Workspace layout

| Crate | Role |
|---|---|
| `types` | Shared on-chain value types (`Transaction`, `Trace`, `Transfer`, entity enums) |
| `config` | Env-based `Config` and `ProcessConfig` |
| `sources` | `BlockSource` trait + Etherscan V2, Alchemy JSON-RPC, and mock impls |
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

## Data sources

`ingest` dispatches through a `BlockSource` trait. Provider is selected by
`INGEST_SOURCE` (`etherscan` | `alchemy` | `mock`). When unset, it infers from
whichever API key is populated (alchemy > etherscan), falling back to `mock`.

| Source | Fetch style | Traces | Transfers | Address mode |
|---|---|---|---|---|
| `etherscan` | V2 proxy JSON | `eth_getBlockReceipts`-ish via proxy | Log scan | ✅ (txlist) |
| `alchemy` | JSON-RPC pull | `trace_block` (Parity) | `eth_getLogs` w/ Transfer topic0 | ❌ (no txlist equivalent) |
| `mock` | Deterministic generator | — | — | — |

Address-mode ingestion (`ingest address 0x...`, targeted neighborhood / hashes)
is Etherscan-only — Alchemy exposes no `txlist` equivalent. For Alchemy users,
rely on `ingest block --follow` or `targeted hashes` for specific tx lookups.

Values larger than `u128` in ERC-20 Transfer logs are truncated to the low 128
bits with a warn log — mirrors the ClickHouse writer's documented u128 caveat.

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `INGEST_SOURCE` | *(inferred)* | ingest |
| `ETHERSCAN_API_KEY` | *(unset → mock or alchemy fallback)* | ingest |
| `ETHERSCAN_BASE_URL` | `https://api.etherscan.io/v2/api` | ingest |
| `ETHERSCAN_CHAIN_ID` | `1` | ingest |
| `ALCHEMY_API_KEY` | *(unset)* | ingest |
| `ALCHEMY_BASE_URL` | `https://eth-mainnet.g.alchemy.com/v2/` | ingest |
| `ALCHEMY_CHAIN` | `eth-mainnet` | ingest (informational) |
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

## Orchestration (Dagster)

Dagster wraps the `ingest` binary so analysts can schedule
backfills, inspect runs, and auto-drain the targeted-fetch queue from a UI.
The `process` and `clickhouse-process` consumers stay outside Dagster — they
are always-on stream consumers, nothing to schedule.

```bash
# Bring up everything, including Dagster webserver + daemon
docker compose up -d

# UI at http://localhost:3000
```

| Job | Trigger | CLI invoked |
| --- | --- | --- |
| `backfill_job` | Launchpad (manual) | `ingest block --start N --end M [--with-traces] [--with-transfers]` |
| `reprocess_job` | Hourly schedules (etherscan :00, alchemy :15) | `ingest reprocess-failed --source {etherscan,alchemy}` |
| `targeted_drain_job` | Redis sensor on `INGEST_TARGETED_QUEUE` (30s tick) | `ingest targeted from-label-tasks --limit N` |
| `targeted_addresses_job` | Launchpad (ad-hoc) | `ingest targeted addresses --addrs 0x...,0x...` |
| `targeted_neighborhood_job` | Launchpad (ad-hoc) | `ingest targeted neighborhood 0x... --hops N` |

Schedules and the sensor default to **stopped** — enable them in the UI
(Overview → Schedules / Sensors) after confirming the ingest binary is
reachable.

**Dagster-specific env vars** (in addition to the standard `INGEST_*` /
`ALCHEMY_*` / `REDIS_URL` knobs consumed by the Rust binary):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DAGSTER_HOME` | `/opt/dagster/home` | SQLite run storage, instance config |
| `RUST_INGEST_BINARY` | `/opt/rust-bin/ingest` in container | Path Dagster subprocess-execs |
| `DAGSTER_TARGETED_SENSOR_INTERVAL` | `30` | Seconds between `targeted_queue_sensor` ticks |
| `DAGSTER_TARGETED_DRAIN_LIMIT` | `50` | `--limit` passed to `ingest targeted from-label-tasks` |

The binary is built once by the `ingest-builder` compose service and staged
into the shared `rust_bin` volume; `dagster-webserver` and `dagster-daemon`
mount it read-only at `/opt/rust-bin/`.

## Observability

Each Rust worker exposes Prometheus metrics on `0.0.0.0:${METRICS_PORT:-9100}/metrics`.
Init is best-effort — a busy port logs a warning and the worker keeps running.

Metric name constants live in `crates/observability/src/lib.rs` (kept in sync
with Grafana dashboards under `compose/observability/grafana/dashboards/`).

Key metrics:

| Name | Kind | Labels | Tier |
| --- | --- | --- | --- |
| `ingest_blocks_fetched_total` | counter | `source` | ingest |
| `ingest_blocks_failed_total` | counter | `source` | ingest |
| `ingest_fetch_duration_seconds` | histogram | `source` | ingest |
| `stream_messages_published_total` | counter | `stream` | ingest |
| `stream_maxlen_trims_total` | counter | `stream` | ingest |
| `consumer_batches_processed_total` | counter | `group`, `outcome` | process / clickhouse-process |
| `consumer_messages_processed_total` | counter | `group`, `stream` | process / clickhouse-process |
| `consumer_parse_failures_total` | counter | `group`, `stream` | process / clickhouse-process |
| `consumer_batch_duration_seconds` | histogram | `group` | process / clickhouse-process |
| `dlq_moves_total` | counter | `stream` | process / clickhouse-process |
| `dlq_messages_moved_total` | counter | `stream` | process / clickhouse-process |

A global `service` label (`ingest`, `process`, `clickhouse-process`) is added
by the exporter so dashboards can separate binaries running on the same host.

### Local stack

`compose/observability.yml` runs Prometheus (`:9090`) and Grafana (`:3001`).
Prometheus is configured via `compose/observability/prometheus.yml`; Grafana
is provisioned with a Prometheus datasource and the `ETL Overview` dashboard.

```bash
docker compose up -d prometheus grafana
open http://localhost:3001   # Grafana — anonymous Viewer access enabled
open http://localhost:9090   # Prometheus UI
```

Workers that aren't currently running will show as `down` in Prometheus; that
is expected — the `ingest` job runs on-demand via Dagster.

### Alerting

Alertmanager runs alongside Prometheus on `:9093`. Alert rules live in
`compose/observability/alerts.yml`; routing + receivers in
`compose/observability/alertmanager.yml`.

| Alert | Severity | Fires when |
| --- | --- | --- |
| `PrometheusTargetDown` | info | A scrape target has been unreachable for 10m. Expected while idle; investigate only if a schedule should have fired. |
| `HighIngestFetchFailureRate` | warning | >5% of block fetches for a given source are failing over 5m (sustained 10m). |
| `IngestFetchLatencyHigh` | warning | p95 block-fetch latency >10s over 10m (sustained 15m). |
| `HighParseFailureRate` | warning | A consumer group is failing to parse >0.1 msg/s from a stream over 5m (sustained 10m). Usually schema drift. |
| `DLQMovesFiring` | critical | Any batch has been relocated to a DLQ stream in the last 15m. Inspect with `redis-cli XRANGE {stream}_dlq - + COUNT 5`. |
| `ConsumerBatchLatencyHigh` | warning | p95 consumer batch duration >30s over 10m (sustained 15m). |

The default receiver is `null` — alerts fire and are visible in the
Alertmanager UI (`http://localhost:9093`) but no external notification is
sent. To enable Slack, uncomment the `slack` receiver block in
`alertmanager.yml`, point `api_url_file` at a file containing the webhook URL,
and change the top-level `route.receiver` to `slack`.

Silence a noisy alert via the Alertmanager UI or:

```bash
curl -XPOST http://localhost:9093/api/v2/silences \
  -H 'Content-Type: application/json' \
  -d '{"matchers":[{"name":"alertname","value":"HighIngestFetchFailureRate","isRegex":false}],"startsAt":"2026-04-21T00:00:00Z","endsAt":"2026-04-22T00:00:00Z","createdBy":"me","comment":"known upstream outage"}'
```

Reload alert rules without restarting Prometheus:

```bash
curl -XPOST http://localhost:9090/-/reload
```

## Labeling UX

The frontend `/labels` page (`frontend/src/pages/LabelsPage.tsx`) drives the
human-in-the-loop side of ingestion:

1. **Queue targeted fetch** — operators submit `addresses`, transaction `hashes`,
   or a `neighborhood` seed. `POST /api/labels/fetch` LPUSHes jobs onto the
   Redis list `ingest:targeted_queue` and creates pending `label_tasks` rows.
2. **Sensor drains the queue** — Dagster's `targeted_queue_sensor` (30s tick)
   spawns `targeted_drain_job`, which shells out to the Rust `ingest targeted`
   subcommand against those addresses.
3. **Analysts annotate** — pending tasks appear in the task table; submitting
   the annotation form (`POST /api/labels/annotations`) writes to the
   `annotations` table and flips the task's status to `completed`.

The `NodePanel` in the graph explorer has a **Label this entity** button that
deep-links into `/labels?address=0x…` with the address prefilled.

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
