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
│ Ingest tier — `ingest` binary (Rust, tokio) — one-shot CLI                   │
│  • Mode dispatch: block / address / targeted / reprocess                     │
│  • `BlockSource` trait → Etherscan | Alchemy | Mock (factory per INGEST_SOURCE)│
│  • Concurrent fetch: `futures::stream::buffered` over `Arc<dyn BlockSource>` │
│  • `writer_pipeline`: fan-in → batched XADD MAXLEN ~ N                       │
│  • Used for manual backfills and Dagster-scheduled reprocess jobs            │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ XADD                   ▲ BRPOP ingest:targeted_queue
                               ▼                        │
┌──────────────────────────────────────────────────────────────────────────────┐
│ Message bus — Redis 7 (streams + list)                                       │
│  ingested_txs │ ingested_traces │ ingested_transfers  (streams)              │
│  ingest:targeted_queue                                (list, BRPOP-drained)  │
│  Poison batches → `{stream}_dlq` after PROCESS_DLQ_MAX_ATTEMPTS              │
└───────────────┬──────────────────────────────────────┬───────────────────────┘
                │ XREADGROUP / BRPOP                   │ XREADGROUP
                ▼                                      ▼
┌──────────────────────────────┐      ┌──────────────────────────────────────┐
│ `worker` binary (long-lived) │      │ OLAP consumer — `clickhouse-process` │
│  Rust, tokio — 3 tasks:      │      │  Rust, tokio                         │
│  A) BRPOP targeted_queue →   │      │  • ClickHouse writer (clickhouse-rs) │
│     Etherscan fetch →        │      │  • ethereum-etl column names         │
│     flip label_tasks /       │      │  • Batched INSERT, DDL auto-applied  │
│     ingestion_runs status    │      │  • Per-batch DLQ (separate env vars) │
│  B) Periodic refresh:        │      │                                      │
│     known_labels ∪ high-risk │      │                                      │
│     entities → LPUSH targeted│      │                                      │
│  C) XREADGROUP ingested_*    │      │                                      │
│     → Neo4j + Postgres       │      │                                      │
│     → bump last_synced_block │      │                                      │
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
Orchestration: Dagster stays dormant in Phase I — only `reprocess_job`
(hourly schedules) and ad-hoc `backfill_job` remain. The targeted-queue
sensor is gone; the `worker` binary consumes `ingest:targeted_queue`
directly via BRPOP. See the Orchestration section below.
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
| `ingest` | `ingest` binary — one-shot CLI: fetches from Etherscan/Alchemy and publishes to Redis Streams |
| `consumer` | Shared library — `read_batch` + `process_read_batch` used by `worker`'s stream task |
| `worker` | `worker` binary — long-running three-task tokio process (targeted queue drain + refresh + stream consumer) |
| `clickhouse` | `clickhouse-process` binary — independent OLAP consumer group |

## Build

```bash
cargo build --release
# → target/release/ingest
# → target/release/worker
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
```

The targeted-queue drain is now handled by the long-running `worker`
binary (see below), not the one-shot `ingest` CLI.

## `worker`

```bash
worker             # continuous, Ctrl+C for graceful shutdown
```

One process runs three independent tokio tasks:

1. **Task A — targeted queue drain.** BRPOPs `INGEST_TARGETED_QUEUE`
   (`ingest:targeted_queue` by default) with `TARGETED_BRPOP_TIMEOUT_SECS`
   timeout. Each payload is `{task_id?, run_id?, spec}` where `spec` is
   one of `{mode: addresses, addrs, from_block?}` / `{mode: hashes,
   hashes}` / `{mode: neighborhood, seed, hops}`. On pickup the worker
   flips `label_tasks.status → in_progress` and/or
   `ingestion_runs.status → running` **before** calling Etherscan, then
   writes the terminal status on completion (success counts,
   `error_message = "{tag}: {err}"` on failure via `classify_error`).

2. **Task B — background refresh.** Every `REFRESH_INTERVAL_SECS`
   (default 300), the worker runs `SELECT address, last_synced_block
   FROM entity_features WHERE risk_level IN ('high','critical')` unioned
   with `known_labels` and LPUSHes one refresh job per address onto
   `ingest:targeted_queue`. An in-memory `HashMap<String, Instant>`
   cooldown (`REFRESH_COOLDOWN_SECS`, default 1800) dedups pushes.
   Payloads carry no `task_id`/`run_id` so they're fire-and-forget.

3. **Task C — stream consumer.** XREADGROUP on `ingested_txs`,
   `ingested_traces`, `ingested_transfers` under consumer group
   `chain-analysis-process` → Neo4j + Postgres writers. After a
   successful batch, the worker bumps
   `entity_features.last_synced_block = GREATEST(existing, max_block)`
   per address touched in the batch.

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
| `REDIS_URL` | `redis://localhost:6379` | ingest, worker |
| `INGEST_BATCH_SIZE` | `1000` | ingest |
| `INGEST_STREAM_MAXLEN` | `1000000` (`0` disables) | ingest |
| `INGEST_TARGETED_QUEUE` | `ingest:targeted_queue` | worker, backend |
| `REFRESH_INTERVAL_SECS` | `300` | worker (task B) |
| `REFRESH_COOLDOWN_SECS` | `1800` | worker (task B) |
| `TARGETED_BRPOP_TIMEOUT_SECS` | `5` | worker (task A) |
| `NEIGHBORHOOD_TX_LIMIT_PER_ADDR` | `500` | worker / ingest (`targeted neighborhood`) — cap txs fetched per peer |
| `MAX_PEERS_PER_HOP` | `20` | worker / ingest (`targeted neighborhood`) — cap peers expanded per hop (top-N by counterparty frequency) |
| `NEO4J_URI` | `bolt://localhost:7687` | worker |
| `NEO4J_USER` | `neo4j` | worker |
| `NEO4J_PASSWORD` | `password123` | worker |
| `NEO4J_DATABASE` | `neo4j` | worker |
| `DATABASE_URL` | `postgresql://postgres:postgres123@localhost:5432/chain_analysis` | worker |
| `PROCESS_BATCH_SIZE` | `500` | worker |
| `PROCESS_CONSUMER_GROUP` | `chain-analysis-process` | worker |
| `PROCESS_CONSUMER_NAME` | `consumer-{pid}` | worker |
| `PROCESS_DLQ_MAX_ATTEMPTS` | `5` | worker |
| `PROCESS_DLQ_SUFFIX` | `_dlq` | worker |
| `PROCESS_DLQ_ATTEMPT_TTL_SECS` | `86400` | worker |
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
| `ingest::e2e` | `E2E_REDIS_URL` | Mock ingest populates `ingested_txs` |

CI (`.github/workflows/rust.yml`) runs `fmt`, `clippy`, `test-unit`, and
`test-integration` (with Redis + ClickHouse service containers) on every
push/PR that touches `etl-rs/`.

## Orchestration (Dagster)

Dagster wraps the `ingest` binary so analysts can schedule backfills
and inspect runs from a UI. **Phase I removed the targeted-queue
sensor** — the `worker` binary now BRPOPs `ingest:targeted_queue`
directly, which eliminates the 30s sensor-tick latency. Dagster remains
as a cold harness for `backfill_job` and the hourly `reprocess_job`
schedules only. The `worker` and `clickhouse-process` consumers stay
outside Dagster — they are always-on, nothing to schedule.

```bash
# Bring up everything, including Dagster webserver + daemon
docker compose up -d

# UI at http://localhost:3000
```

| Job | Trigger | CLI invoked |
| --- | --- | --- |
| `backfill_job` | Launchpad (manual) | `ingest block --start N --end M [--with-traces] [--with-transfers]` |
| `reprocess_job` | Hourly schedules (etherscan :00, alchemy :15) | `ingest reprocess-failed --source {etherscan,alchemy}` |
| `targeted_addresses_job` | Launchpad (ad-hoc) | `ingest targeted addresses --addrs 0x...,0x...` |
| `targeted_neighborhood_job` | Launchpad (ad-hoc) | `ingest targeted neighborhood 0x... --hops N` |

Hourly reprocess schedules default to **stopped** — enable them in the
Dagster UI (Overview → Schedules) once you're confident the upstream
source isn't persistently failing. `/labels` "Queue fetch" and
`/api/pipeline/ingest-address` bypass Dagster entirely — they LPUSH
onto `ingest:targeted_queue` and the `worker` binary picks them up
within one BRPOP cycle (~instant).

**Dagster-specific env vars** (in addition to the standard `INGEST_*` /
`ALCHEMY_*` / `REDIS_URL` knobs consumed by the Rust binary):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DAGSTER_HOME` | `/opt/dagster/home` | SQLite run storage, instance config |
| `RUST_INGEST_BINARY` | `/opt/rust-bin/ingest` in container | Path Dagster subprocess-execs |

The binary is built once by the `ingest-builder` compose service and staged
into the shared `rust_bin` volume; `dagster-webserver` and `dagster-daemon`
mount it read-only at `/opt/rust-bin/`.

## Observability

Each Rust worker exposes Prometheus metrics on `0.0.0.0:${METRICS_PORT:-9100}/metrics`.
Init is best-effort — a busy port logs a warning and the worker keeps running.

Metric name constants live in `crates/etl/src/observability.rs` (kept in sync
with Grafana dashboards under `compose/grafana/dashboards/`).

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

A global `service` label (`ingest`, `worker`, `clickhouse-process`) is added
by the exporter so dashboards can separate binaries running on the same host.

### Local stack

`compose/prometheus.yml` runs Prometheus (`:9090`) and `compose/grafana.yml`
runs Grafana (`:3001`). Prometheus is configured via
`compose/prometheus.config.yml`; Grafana is provisioned with a Prometheus
datasource and the `ETL Overview` dashboard from `compose/grafana/`.

```bash
docker compose up -d prometheus grafana
open http://localhost:3001   # Grafana — anonymous Viewer access enabled
open http://localhost:9090   # Prometheus UI
```

Only the `worker` target is scraped in the current setup. Alertmanager was
removed 2026-04-22 — alerts can be re-introduced when there's a real
receiver to route to.

## Labeling UX

The frontend `/labels` page (`frontend/src/pages/LabelsPage.tsx`) drives the
human-in-the-loop side of ingestion:

1. **Queue targeted fetch** — operators submit `addresses`, transaction `hashes`,
   or a `neighborhood` seed. `POST /api/labels/fetch` LPUSHes jobs onto the
   Redis list `ingest:targeted_queue` and creates pending `label_tasks` rows.
2. **Worker drains the queue** — the `worker` binary's task A BRPOPs the
   list (sub-second latency), flips the `label_tasks` row to `in_progress`
   before fetching from Etherscan, and to `completed` on success.
3. **Analysts annotate** — pending tasks appear in the task table; submitting
   the annotation form (`POST /api/labels/annotations`) writes to the
   `annotations` table and flips the task's status to `completed`.

The `NodePanel` in the graph explorer has a **Label this entity** button that
deep-links into `/labels?address=0x…` with the address prefilled.

## Web-triggered ingest

`POST /api/pipeline/ingest-address` is a thin wrapper that validates the
address, inserts a `queued` row into `ingestion_runs`, and LPUSHes a job with
the pre-assigned `run_id` onto `ingest:targeted_queue`. The `worker`
binary (task A) drains the queue, transitions the run row
`queued → running → completed|failed`, and records counts + error tags.
The frontend polls `GET /api/ingestion-runs/{run_id}` every 2s through
`useIngestionRun` and `RunStatusPill` in the top nav.

Additional UI entry points that reuse `POST /api/labels/fetch` (no run pill —
fire-and-forget, drained by the worker within one BRPOP cycle):

- **NodePanel → Deep trace (2 hops)** — queues `{mode:"neighborhood"}` for
  the selected entity.
- **ETLPage → Ingest Transactions by Hash** — queues `{mode:"hashes"}` for
  a newline-separated hash list.

Admins see an extra **Orchestration** section on `/etl` with deep-links to
the Dagster Launchpad for `reprocess_job` and the Dagster UI.

Error tags written by the Rust drain (see `classify_error` in
`crates/ingest/src/modes/targeted.rs`):

| Tag            | Cause                                         | UI message |
|----------------|-----------------------------------------------|------------|
| `rate_limited` | 429 after exhausting Etherscan backoff        | "Etherscan rate limit hit — it will auto-retry shortly." |
| `auth`         | 401/403 or missing `ETHERSCAN_API_KEY`        | "ETHERSCAN_API_KEY is missing or invalid — check .env" |
| `network`      | Connection/DNS/timeout                        | "Network error reaching Etherscan — check connectivity." |
| `unknown`      | Anything else                                 | "Ingest failed — see backend logs for details." |

## Smoke test

Verify the ETL cooperates end-to-end against a fresh deploy:

1. `docker compose up -d` — wait for `chain-analysis-backend` healthy.
2. Log into the frontend (`http://localhost:5173`), open `/explorer`,
   search `0x742d35cc6634c0532925a3b844bc9e7595f0beb0`.
3. Click **Fetch Transactions**. A toast appears immediately ("Queued —
   graph will refresh when run completes"). The **run pill** in the nav
   flips `queued → running` within ~1s (one BRPOP cycle), then
   `completed` within seconds of pickup.
4. The graph repopulates automatically on completion. Opening the pill
   shows the recent run with tx counts.
5. On `/labels`, queue a fetch for the same address. A new `pending` task
   appears; the worker drains it within a second and the row flips to
   `in_progress`. The page auto-refreshes every 5s while any task is
   pending.
6. **Auth failure path** — unset `ETHERSCAN_API_KEY`, restart the
   `worker` container, trigger a fetch. The run should end in
   `status=failed`, `error_message` starting with `auth`, and the pill
   dropdown should render the ETHERSCAN_API_KEY help text.

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
