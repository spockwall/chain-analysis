# etl-rs — Architecture & Operations Guide

Deep reference for the Rust ETL workspace (`etl-rs/`). Covers the crate
layout, the three binaries, every inter-service message, the per-component
lifecycles, and the day-to-day operational recipes.

This document pairs with:

- `etl-rs/README.md` — short overview diagram + build commands
- `CLAUDE.md` — repo-wide roadmap, backend/frontend conventions
- `docs/etl-ts.md` — the Python-backend flow (separate HTTP pipeline)

---

## Table of Contents

1. [Workspace layout](#1-workspace-layout)
2. [End-to-end architecture](#2-end-to-end-architecture)
3. [Process model — the 3 binaries](#3-process-model--the-3-binaries)
4. [Library crate `etl/` — module walk-through](#4-library-crate-etl--module-walk-through)
5. [Data model & Redis contract](#5-data-model--redis-contract)
6. [Lifecycles & workflows](#6-lifecycles--workflows)
7. [Configuration reference](#7-configuration-reference)
8. [Observability — metrics, logs, progress events](#8-observability--metrics-logs-progress-events)
9. [Failure handling — retries, DLQ, delta cursors](#9-failure-handling--retries-dlq-delta-cursors)
10. [Cooperation with the rest of the stack](#10-cooperation-with-the-rest-of-the-stack)
11. [Operational recipes](#11-operational-recipes)
12. [Troubleshooting](#12-troubleshooting)
13. [Tests & benchmarks](#13-tests--benchmarks)

---

## 1. Workspace layout

The workspace is a single library crate plus three thin binary crates. Every
piece of domain logic lives in `etl/`; the bins are pure orchestration and
CLI parsing.

```
etl-rs/
├── Cargo.toml                       # workspace manifest (4 members)
└── crates/
    ├── etl/                         # library — all domain code
    │   ├── Cargo.toml
    │   └── src/
    │       ├── lib.rs               # pub mod {config, consumer, ingest, …}
    │       ├── config.rs            # env-driven settings per subsystem
    │       ├── observability.rs     # Prometheus exporter + metric-name consts
    │       ├── pipeline.rs          # retry, shutdown, DLQ, progress reporters
    │       ├── types/               # serde value types (Transaction, Trace, …)
    │       ├── sources/             # BlockSource trait + Etherscan/Alchemy/Mock
    │       │   ├── mod.rs
    │       │   ├── block_source.rs  # trait + SourceConfig + make_source factory
    │       │   ├── etherscan/
    │       │   ├── alchemy/
    │       │   └── mock.rs
    │       ├── sinks/               # all writers + readers
    │       │   ├── neo4j.rs
    │       │   ├── clickhouse.rs
    │       │   ├── postgres_writer.rs
    │       │   ├── postgres_reader.rs
    │       │   ├── redis_stream.rs  # TransactionWriter + RedisStreamWriter
    │       │   └── redis_consumer.rs# StreamConsumer + CombinedBatch
    │       ├── ingest/              # fetch-tier orchestration
    │       │   ├── mod.rs           # fetch_block, ingest_address*,
    │       │   │                    # ingest_block_range_pipelined
    │       │   ├── writer_actor.rs  # mpsc-driven batched writer task
    │       │   ├── targeted.rs      # TargetSpec, TargetedJob, run_targeted
    │       │   └── reprocess.rs     # drain ingest:failed_blocks:*
    │       └── consumer/            # stream → Neo4j+PG
    │           ├── mod.rs           # read_batch, process_read_batch
    │           ├── resolver.rs      # address extraction, entity resolution
    │           └── features.rs      # on-chain feature computation
    └── bin/
        ├── ingest/                  # CLI one-shot ingestor
        │   ├── Cargo.toml
        │   └── src/main.rs
        ├── worker/                  # long-running service (3 tokio tasks)
        │   ├── Cargo.toml
        │   └── src/
        │       ├── main.rs          # wiring: connect, spawn, join
        │       ├── config.rs        # WorkerConfig (env → struct)
        │       ├── targeted.rs      # task A: BRPOP → TargetedJob::execute
        │       ├── refresh.rs       # task B: periodic refresh LPUSH
        │       └── stream.rs        # task C: XREADGROUP → process_read_batch
        └── clickhouse-process/      # independent OLAP consumer group
            ├── Cargo.toml
            └── src/main.rs
```

### Build outputs

```bash
cd etl-rs
cargo build --release --workspace --bins
# → target/release/ingest
# → target/release/worker
# → target/release/clickhouse-process
```

The Docker image (`etl-rs/Dockerfile`) builds all three in one layer and
copies them into a distroless runtime.

---

## 2. End-to-end architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ External providers                                                            │
│   Etherscan V2 proxy API  │  Alchemy JSON-RPC  │  MockSource (deterministic)  │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │ HTTPS (reqwest, retrying)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Fetch tier                                                                    │
│                                                                               │
│  ingest (one-shot CLI)                 worker task A (continuous)             │
│  ──────────────────────                ────────────────────────────           │
│  block / address / targeted /          BRPOP ingest:targeted_queue            │
│  reprocess-failed  subcommands         → TargetedJob::execute                 │
│                                         (addresses | hashes | neighborhood)  │
│                                                                               │
│  Both paths go through:                                                       │
│    BlockSource (Etherscan|Alchemy|Mock)                                       │
│    ingest::writer_actor (mpsc-fed batched writer)                            │
│    TransactionWriter (RedisStreamWriter in prod, StdoutWriter for --dry-run) │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │ XADD (MAXLEN ~ INGEST_STREAM_MAXLEN)
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Message bus — Redis 7                                                         │
│                                                                               │
│  Streams (durable, ID-ordered):                                               │
│    ingested_txs        ingested_traces     ingested_transfers                 │
│    ingestion_progress  processing_progress                                    │
│    {stream}_dlq         (poison-batch quarantine)                             │
│                                                                               │
│  Lists (FIFO work queue):                                                     │
│    ingest:targeted_queue         (LPUSH → BRPOP, drained by worker task A)   │
│                                                                               │
│  Keys:                                                                        │
│    ingest:last_block:{source}    (String — cursor per source)                 │
│    ingest:failed_blocks:{source} (Set — blocks exhausted retries)             │
│    process:retry:{s}:{first}:{last} (Int — DLQ attempt counter)               │
└───────┬──────────────────────────────────────────────────┬────────────────────┘
        │ XREADGROUP                                       │ XREADGROUP
        │ (group: chain-analysis-process)                  │ (group: chain-analysis-clickhouse)
        ▼                                                  ▼
┌──────────────────────────┐                 ┌──────────────────────────────────┐
│ worker task C            │                 │ clickhouse-process binary        │
│ ──────────────           │                 │ ──────────────────────           │
│ consumer::process_read_  │                 │ Inserts into                     │
│   batch                  │                 │   chain_analysis.transactions    │
│ → resolve entities       │                 │   chain_analysis.traces          │
│ → compute features       │                 │   chain_analysis.token_transfers │
│ → neo4j.upsert_*         │                 │ via native-protocol              │
│ → pg.upsert_features     │                 │ batched INSERT                   │
│ → pg.bump_last_synced    │                 │                                  │
│ → XACK                   │                 │                                  │
└────────┬─────────────────┘                 └──────────────────────────────────┘
         │
         ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│ Neo4j 5 (OLTP graph)     │  │ PostgreSQL (OLTP state)  │
│  Entity / Transaction /  │  │  entity_features         │
│  Trace / TokenTransfer   │  │  ingestion_runs          │
│  SENT / RECEIVED edges   │  │  label_tasks             │
│  IN_GROUP edges          │  │  known_labels            │
└──────────────────────────┘  └──────────────────────────┘
```

### The two consumer groups, explained

The same three Redis streams (`ingested_*`) feed **two independent consumer
groups**:

- `chain-analysis-process` (worker task C) — graph + row-per-entity state
- `chain-analysis-clickhouse` (clickhouse-process bin) — columnar analytics

Each group tracks its own read position. A slow ClickHouse insert can never
block the graph writer, and vice versa. A message is XACK'd independently
by each group; `INGEST_STREAM_MAXLEN` trims only the oldest IDs, and Redis
guarantees we won't evict a message while it's still pending for any
consumer group.

---

## 3. Process model — the 3 binaries

### 3.1 `ingest` — one-shot CLI

Used for backfills, ad-hoc address fetches, manual neighborhood BFS, and
draining the failed-blocks set. Exits when the job finishes (or Ctrl+C in
`--follow` mode).

**Subcommands:**

```
ingest block        --start N --end M [--follow] [--with-traces] [--with-transfers]
ingest address      0x... [--start N] [--end M] [--with-traces] [--with-transfers]
ingest targeted     addresses      --addrs 0xa,0xb,0xc
                    hashes         --hashes 0x1,0x2
                    neighborhood   0xseed --hops 2
ingest reprocess-failed  --source {etherscan|alchemy}
ingest dlq          list           --stream <name> [--limit 50] [--suffix _dlq]
                    replay         --stream <name> {--id <stream-id> | --all} [--max N]
                    drop           --stream <name> {--id <stream-id> | --all}
```

**`dlq` operator workflow** — when the worker exhausts retries on a poison
batch it lands in `{stream}_dlq`. Triage looks like:

```
# What's in the queue?
ingest dlq list --stream ingested_txs --limit 20

# Send the survivors back to the head of the original stream. Replay is
# safe: it XADDs to the original BEFORE XDELing from the DLQ, so a crash
# mid-op produces a duplicate (worker MERGE is idempotent), never a loss.
ingest dlq replay --stream ingested_txs --all --max 100

# Permanently drop entries that are known-bad (logged, captured elsewhere).
ingest dlq drop --stream ingested_txs --all
```

Legacy flat args (`--address 0x… --start-block N …`) still parse when no
subcommand is given — see `crates/bin/ingest/src/main.rs` for the full
Clap definition.

Internally each subcommand follows the same shape:

1. Parse `etl::config::Config::from_env()`
2. Build a `DynBlockSource = Arc<dyn BlockSource>` via `make_source`
3. Build a `Box<dyn TransactionWriter>` (RedisStreamWriter or StdoutWriter)
4. Build a `ProgressReporter` (Redis XADD or log-only `DryRun`)
5. Call the matching function in `etl::ingest::*`

### 3.2 `worker` — long-running service (3 tokio tasks)

The daemon. One process, one `tokio::runtime`, three `tokio::spawn`'d tasks
sharing connection pools. All three observe the same `ShutdownHandle`
derived from `install_shutdown()` (SIGINT/SIGTERM watcher).

```rust
// crates/bin/worker/src/main.rs  (abridged)
let shutdown = install_shutdown();
let pg       = sqlx::PgPool::connect(...).await?;
let redis    = redis::aio::ConnectionManager::new(client).await?;
let neo4j    = Neo4jWriter::connect(...).await?;

let a = tokio::spawn(targeted::run(cfg, brpop_timeout, pg, redis, shutdown));
let b = tokio::spawn(refresh::run(queue_key, interval, cooldown, pg, redis, shutdown));
let c = tokio::spawn(stream::run(cfg, pg, neo4j, batch_size, block_ms, shutdown));

tokio::select! {
    r = a => report("targeted", r),
    r = b => report("refresh",  r),
    r = c => report("stream",   r),
}
```

**Task A — targeted queue consumer** (`bin/worker/src/targeted.rs`)

```
loop {
    payload = BRPOP ingest:targeted_queue TIMEOUT
    task    = serde_json::from_str(payload)   // QueuedTask { task_id, run_id, spec }
    TargetedJob { cfg, pg, writer, reporter, pg_writer, … }
        .execute(task)          // flips label_tasks/ingestion_runs + runs spec
        .await
}
```

Sub-second latency between a web UI click and the first Etherscan call,
because BRPOP wakes on every `LPUSH`.

**Task B — refresh loop** (`bin/worker/src/refresh.rs`)

Periodic (default 300s) enumeration of:

- `known_labels` rows with `risk_level IN ('high','critical')`
- `entity_features` rows (anything we've already ingested once)

For each address, compute `from_block = last_synced_block + 1` and LPUSH a
targeted-addresses payload onto `ingest:targeted_queue`. Task A picks it up.
An in-memory per-address cooldown (default 1800s) prevents re-queuing.

**Task C — stream consumer** (`bin/worker/src/stream.rs`)

```
loop {
    batch = read_batch(consumer)               // XREADGROUP across 3 streams
    if empty → continue
    raw_snapshot = batch.raw_by_stream         // for DLQ on failure
    result = process_read_batch(consumer, pg, pg_writer, neo4j, reporter, batch)
    if error → incr_attempt; if >= max → move_batch_to_dlq; else retry next tick
}
```

`process_read_batch` is the 180-line end-to-end processor; see
[§4.7](#47-consumer--stream-processor).

### 3.3 `clickhouse-process` — independent OLAP consumer

Totally separate binary, separate consumer group
(`chain-analysis-clickhouse`), separate DLQ settings
(`CLICKHOUSE_DLQ_*`). Reads the same three streams as worker task C,
batches rows into ClickHouse native-protocol inserts, XACKs on success.

Supports `--one-shot` for a single batch then exit (useful for
CI / manual ops). Continuous mode is the default.

---

## 4. Library crate `etl/` — module walk-through

### 4.1 `config`

One struct per subsystem, each with `from_env()`. All env vars use the
same names as before the refactor — no env-var renames.

| Struct              | Used by                           | Key fields                                          |
|---------------------|-----------------------------------|-----------------------------------------------------|
| `Config`            | `ingest` bin, worker task A       | etherscan\_\*, alchemy\_\*, redis_url, stream_maxlen, targeted_queue_key |
| `ProcessConfig`     | worker task C                     | neo4j_\*, postgres_url, consumer_group, dlq_\*      |
| `ClickhouseConfig`  | `clickhouse-process` bin          | clickhouse_\*, consumer_group, dlq_\*               |

`bin/worker/src/config.rs::WorkerConfig` composes `Config` + `ProcessConfig`
plus 5 worker-only knobs (`refresh_interval_secs`, `brpop_timeout_secs`, …).

### 4.2 `observability`

`init_best_effort(service, port)` spins up a Prometheus HTTP listener on
`0.0.0.0:{METRICS_PORT}/metrics` (default 9100) and registers metric
descriptions. Every binary calls this at startup.

Metric name constants live here so Grafana dashboards and call sites share
one source of truth. See [§8](#8-observability--metrics-logs-progress-events).

### 4.3 `types`

```rust
pub struct Transaction   { hash, value, block_number, timestamp, gas_used,
                           gas_price, from_address, to_address, … }
pub struct Trace         { uid, transaction_hash, block_number,
                           from_address, to_address, value, call_type }
pub struct Transfer      { uid, transaction_hash, block_number, token_address,
                           from_address, to_address, amount }
pub enum   EntityType    { EOA, Contract, Mixer, Bridge, DEX, CEXHotWallet, … }
pub enum   RiskLevel     { Low, Medium, High, Critical }

// Redis stream payloads (JSON-encoded in the `data` field of each message)
pub enum IngestionMessage { Progress{...}, Complete{...}, Error{...} }
pub enum ProcessingMessage { Progress{...}, Complete{...}, Error{...} }
```

All types derive `Serialize + Deserialize`. The same struct is the
JSON-on-the-wire form in Redis Streams, the row value in
`ClickhouseWriter`, and the argument to `Neo4jWriter::upsert_*`.

### 4.4 `sources`

```rust
#[async_trait]
pub trait BlockSource: Send + Sync {
    fn name(&self) -> &'static str;
    async fn latest_block(&self) -> Result<u64>;
    async fn fetch_block    (&self, n: u64) -> Result<Vec<Transaction>>;
    async fn fetch_traces   (&self, n: u64) -> Result<Vec<Trace>>;
    async fn fetch_transfers(&self, n: u64) -> Result<Vec<Transfer>>;
    async fn fetch_tx_by_hash(&self, h: &str) -> Result<Option<Transaction>>;
}
```

Three impls:

- **`etherscan`** — Etherscan V2 proxy API. Uses `eth_getBlockByNumber`,
  `eth_getBlockReceipts`, `debug_traceBlockByNumber`, `account/txlist`,
  `account/txlistinternal`, `account/tokentx`.
- **`alchemy`** — JSON-RPC with `alchemy_getAssetTransfers` for token
  transfers; no `txlist` equivalent (so address mode is Etherscan-only).
- **`mock`** — deterministic generator for tests and when no API key is set.

`make_source(&SourceConfig)` picks the impl:

```
if INGEST_SOURCE set                       → use it explicitly
else if ALCHEMY_API_KEY   is present       → alchemy
else if ETHERSCAN_API_KEY is present       → etherscan
else                                       → mock
```

### 4.5 `sinks`

| Module              | Role                                                        |
|---------------------|-------------------------------------------------------------|
| `redis_stream`      | `TransactionWriter` trait + `RedisStreamWriter` (production) + `StdoutWriter` (--dry-run) |
| `redis_consumer`    | `StreamConsumer`: XREADGROUP across 3 streams, returns a `CombinedBatch` |
| `neo4j`             | `Neo4jWriter`: UNWIND-MERGE batches for entities/txs/traces/transfers |
| `postgres_writer`   | `PostgresWriter`: upsert into `entity_features`, bump `last_synced_block`, `ingestion_runs` transitions |
| `postgres_reader`   | `PostgresReader`: read `known_labels`, read `last_synced_block` |
| `clickhouse`        | `ClickhouseWriter`: native-protocol batched insert into 3 tables |

`TransactionWriter` is the core fetch-side abstraction:

```rust
#[async_trait]
pub trait TransactionWriter: Send {
    async fn write_transaction (&mut self, tx: &Transaction) -> Result<()>;
    async fn write_trace       (&mut self, tr: &Trace)       -> Result<()>;
    async fn write_transfer    (&mut self, tf: &Transfer)    -> Result<()>;
    async fn save_cursor       (&mut self, block: u64)       -> Result<()>;
    async fn get_cursor        (&mut self)                    -> Result<Option<u64>>;
    async fn record_failed_block(&mut self, block: u64)      -> Result<()>;

    async fn write_transactions_batch(&mut self, txs:       &[Transaction]) -> Result<()>;
    async fn write_traces_batch      (&mut self, traces:    &[Trace])       -> Result<()>;
    async fn write_transfers_batch   (&mut self, transfers: &[Transfer])    -> Result<()>;
}
```

`RedisStreamWriter` overrides the `*_batch` methods with pipelined XADDs
using `MAXLEN ~ N` (approximate trim, much cheaper than exact).

### 4.6 `pipeline`

Cross-cutting helpers kept in one file so every call site imports via
`use etl::pipeline::{…}`:

- **`RetryPolicy { max_retries, initial_backoff, multiplier, max_backoff }`**
  + `with_retry(&policy, op_name, || fut)` — exponential backoff with jitter.
- **`ShutdownHandle`** + `install_shutdown()` — watches SIGINT/SIGTERM,
  yields a `watch::Receiver<bool>` all tasks clone.
- **`DlqPolicy`, `BatchKey`, `incr_attempt`, `clear_attempt`,
  `move_batch_to_dlq`** — per-batch attempt counter keyed by
  `process:retry:{stream}:{first_id}:{last_id}` with TTL.
  See [§9](#9-failure-handling--retries-dlq-delta-cursors).
- **`ProgressReporter`** (ingest tier) — XADDs `IngestionMessage` JSON to
  `ingestion_progress` under a `run_id`. `DryRun` variant just logs.
- **`ProcessProgressReporter`** (stream tier) — same shape but writes
  `ProcessingMessage` to `processing_progress`. The backend's
  `/api/ingestion-runs/{run_id}/events` endpoint tails these streams for
  the live-progress pill in the UI.

### 4.7 `consumer` / stream processor

```rust
// crates/etl/src/consumer/mod.rs
pub async fn read_batch(c: &mut StreamConsumer) -> Result<CombinedBatch>;

pub async fn process_read_batch(
    consumer: &mut StreamConsumer,
    pg:       &PostgresReader,
    pg_writer:&PostgresWriter,
    neo4j:    &Neo4jWriter,
    reporter: &mut ProcessProgressReporter,
    batch:    CombinedBatch,
) -> Result<(u64 /*entities*/, u64 /*txs*/, u64 /*traces+transfers*/)>;
```

Step-by-step:

1. **Unwrap batch.** Separate `(msg_id, value)` pairs into parallel vectors.
2. **Extract addresses** (`resolver::extract_addresses*`) — union of
   `from` + `to` across txs/traces/transfers.
3. **Label lookup** — `pg.get_known_labels(&addrs)` → `HashMap<addr, (type, risk)>`.
4. **Resolve entities** — produces `EntityRecord { address, entity_type, risk_level, is_labeled, … }` for every unique address.
5. **Compute features** — degree, volume, first/last-seen, AML flags.
6. **Parallel upserts** via `tokio::try_join!`:
   - `neo4j.upsert_entities(&enriched)`
   - `pg_writer.upsert_entity_features(&enriched)`
7. **Parallel graph upserts**:
   - `neo4j.upsert_transactions(&txs)` — creates `SENT` + `RECEIVED` edges
   - `neo4j.upsert_traces(&traces)`
   - `neo4j.upsert_transfers(&transfers)`
8. **Bump delta cursor** — `pg_writer.bump_last_synced_block(&updates)` so
   the refresh loop (task B) and `effective_from_block` (task A) skip
   already-ingested ranges.
9. **XACK** all three streams.
10. **Emit metrics + progress** (`ProcessProgressReporter::report_stage`
    per phase, final `Complete` event).

On any error in steps 3–9, the caller (worker task C / clickhouse-process)
hands `batch.raw_by_stream` to the DLQ routine — no messages are XACK'd,
so Redis's PEL retains ownership until the next attempt or the DLQ move.

### 4.8 `ingest` module — fetch orchestration

Free functions + one struct (`TargetedJob`). All share `DynBlockSource = Arc<dyn BlockSource>`.

```rust
// Block-range, pipelined
pub async fn ingest_block_range_pipelined(
    source: DynBlockSource,
    start: u64, end: u64,
    writer: Box<dyn TransactionWriter>,
    progress: ProgressReporter,
    retry: &RetryPolicy,
    with_traces: bool, with_transfers: bool,
    fetch_concurrency: usize,
    total_blocks_for_progress: u64, initial_total_txs: u64,
) -> Result<(Box<dyn TransactionWriter>, ProgressReporter, u64 /*total txs*/)>;

// Address mode (Etherscan-only — Alchemy has no txlist equivalent)
pub async fn ingest_address       (config, addr, start, end, writer, reporter, …);
pub async fn ingest_address_capped(config, addr, start, end, writer, reporter, …, max_per_kind);

// Targeted — the user-triggered path, also the TargetedJob::execute core
pub async fn run_targeted(config, spec, writer, reporter, pg_writer, with_traces, with_transfers)
```

`ingest_block_range_pipelined` is the production fetch pipeline:

```
futures::stream::iter(start..=end)
    .map(|n| fetch_block_data(source, n, retry, traces, transfers))
    .buffered(fetch_concurrency)                 // N concurrent fetches
    ──►  mpsc channel  ──►  writer_actor task:   // one writer, pipelined XADDs
                            - write_transactions_batch
                            - write_traces_batch
                            - write_transfers_batch
                            - save_cursor(block)
                            - send FlushAck
    ◄── ack_rx ──       driver records progress, emits XADD ingestion_progress
```

The fetch-side concurrency is bounded by `--fetch-concurrency`; the writer
is a single task, so Redis never sees out-of-order cursor bumps.

### 4.9 `TargetedJob` — owns the label-task lifecycle

Introduced in the refactor to consolidate code that used to be split
between `worker/src/targeted.rs` (DB state flips) and `ingest` (the actual
fetch). Lives in `crates/etl/src/ingest/targeted.rs`.

```rust
pub struct TargetedJob<'a> {
    pub config:     &'a Config,
    pub pg:         &'a PgPool,            // for label_tasks/ingestion_runs flips
    pub writer:     &'a mut Box<dyn TransactionWriter>,
    pub reporter:   &'a mut ProgressReporter,
    pub pg_writer:  Option<&'a PostgresWriter>,
    pub with_traces: bool,
    pub with_transfers: bool,
}

impl TargetedJob<'_> {
    pub async fn execute(&mut self, task: QueuedTask) -> Result<u64> {
        Self::mark_pickup(self.pg, task.task_id, task.run_id.as_deref()).await;
        let result = run_targeted(self.config, task.spec.into(),
                                  self.writer, self.reporter, self.pg_writer,
                                  self.with_traces, self.with_transfers).await;
        Self::mark_terminal(self.pg, task.task_id, task.run_id.as_deref(), &result).await;
        result
    }
    // mark_pickup, mark_terminal, classify_error — all co-located
}
```

`worker::targeted::run` then reduces to a BRPOP loop that constructs a
`TargetedJob` and calls `execute(task)`.

### 4.10 `TargetSpec` variants

```rust
pub enum TargetSpec {
    Addresses { addrs: Vec<String>, from_block: Option<u64> },
    Hashes(Vec<String>),
    Neighborhood { seed: String, hops: u8 },
}
```

- **Addresses** — fetch full history per address via
  `etherscan::account/txlist` (+traces/tokentx if requested). Skips
  already-synced blocks when `pg_writer` is supplied
  (`effective_from_block = max(requested, last_synced_block + 1)`).
- **Hashes** — `eth_getTransactionByHash` per hash, batched XADD into
  `ingested_txs`. Etherscan-only.
- **Neighborhood** — BFS from `seed` up to `hops` levels. Per-hop caps
  (`NEIGHBORHOOD_TX_LIMIT_PER_ADDR`, `MAX_PEERS_PER_HOP`) prevent runaway
  expansion around hubs like Tornado or Uniswap.

---

## 5. Data model & Redis contract

### 5.1 Streams (producer → consumers)

| Stream                 | Producer                              | Consumers (groups)                            | Payload schema             |
|------------------------|---------------------------------------|-----------------------------------------------|----------------------------|
| `ingested_txs`         | `ingest`, worker task A               | `chain-analysis-process`, `chain-analysis-clickhouse` | `data=<Transaction JSON>`  |
| `ingested_traces`      | `ingest`, worker task A               | same                                          | `data=<Trace JSON>`        |
| `ingested_transfers`   | `ingest`, worker task A               | same                                          | `data=<Transfer JSON>`     |
| `ingestion_progress`   | ingest tier (via `ProgressReporter`)  | backend SSE route                             | `data=<IngestionMessage>`  |
| `processing_progress`  | stream tier (via `ProcessProgressReporter`) | backend SSE route                       | `data=<ProcessingMessage>` |
| `{stream}_dlq`         | `pipeline::move_batch_to_dlq`         | manual/automated replay                       | original fields + `original_id` |

Every message has a single field named `data` whose value is a JSON string
of the corresponding typed struct from `etl::types`.

### 5.2 Keys and lists

| Key pattern                              | Type    | Owner / purpose                                                      |
|------------------------------------------|---------|----------------------------------------------------------------------|
| `ingest:targeted_queue`                  | List    | Web backend LPUSHes `QueuedTask` JSON; worker task A BRPOPs.         |
| `ingest:last_block:{source}`             | String  | Cursor written by `RedisStreamWriter::save_cursor`.                  |
| `ingest:failed_blocks:{source}`          | Set     | Blocks whose fetch exhausted `RetryPolicy::max_retries`. Drained by `ingest reprocess-failed`. |
| `process:retry:{stream}:{first}:{last}`  | Integer | DLQ attempt counter with TTL = `attempt_ttl_secs`.                   |

### 5.3 `QueuedTask` JSON contract

What the backend writes onto `ingest:targeted_queue`:

```json
{
  "task_id": 42,                       // optional — label_tasks row id
  "run_id":  "abc-123",                // optional — ingestion_runs row id
  "spec": {
    "mode": "addresses",               // "addresses" | "hashes" | "neighborhood"
    "addrs": ["0xaaa", "0xbbb"],
    "from_block": 18000000             // optional; default 0
  }
}
```

Other `spec` shapes:

```json
{ "mode": "hashes",       "hashes": ["0x1", "0x2"] }
{ "mode": "neighborhood", "seed": "0xseed", "hops": 2 }
```

The task optionally carries a pre-inserted `ingestion_runs.run_id` so the
worker can flip the row to `running` → `completed`/`failed` in place.
Refresh-loop (task B) entries omit both `task_id` and `run_id`.

---

## 6. Lifecycles & workflows

### 6.1 User clicks "Ingest address" in the web UI

```
  User  →  FastAPI  →  Postgres  →  Redis                 Worker (A)
  ────────────────────────────────────────────────────────────────────
  POST /pipeline/ingest-address
        INSERT ingestion_runs (status=queued, run_id=uuid)
                                      LPUSH ingest:targeted_queue
                                         { run_id, spec: addresses(0x…) }
                                      ────────────────────────►  BRPOP wakes
  ◄── 202 {run_id}
                                                        mark_pickup:
                                                          UPDATE ingestion_runs
                                                            SET status='running'
                                      XADD ingestion_progress ◄ ProgressReporter
                                      XADD ingested_txs/*
                                                        mark_terminal:
                                                          UPDATE ingestion_runs
                                                            SET status='completed',
                                                                transactions_processed=N
                                         ▲
                                         │
                                                        (Worker task C reads streams,
                                                         writes Neo4j + Postgres,
                                                         XADDs processing_progress)
```

The frontend pill (`RunStatusPill`) tails `ingestion_progress` via SSE and
flips from `queued` → `running` → `completed` in ≈1s latency end-to-end.

### 6.2 Deep-trace (2 hops)

Identical to 6.1 but `spec = { mode: "neighborhood", seed, hops: 2 }`. The
neighborhood BFS runs inside `run_targeted` → `run_neighborhood`, emitting
progress every peer.

### 6.3 Scheduled refresh (worker task B)

```
every REFRESH_INTERVAL_SECS (default 300s):
  rows = SELECT address, COALESCE(last_synced_block, 0)
         FROM known_labels kl
         LEFT JOIN entity_features ef ON ef.address = kl.address
         WHERE kl.risk_level IN ('high','critical') OR ef.address IS NOT NULL

  for (addr, lsb) in rows:
    if addr in cooldown_map and elapsed < REFRESH_COOLDOWN_SECS: skip
    LPUSH ingest:targeted_queue
          { spec: { mode: "addresses", addrs: [addr], from_block: lsb + 1 } }
    cooldown_map[addr] = now
```

Task A then consumes these like any other targeted entry. The
`from_block` seed + task C's `bump_last_synced_block` means each tick only
touches new blocks.

### 6.4 Bulk backfill via CLI

```
ingest block --start 21_000_000 --end 21_000_100 --with-traces --with-transfers
  → ingest_block_range_pipelined
      → futures::buffered(fetch_concurrency)
      → writer_actor:
          XADD ingested_txs/traces/transfers
          SET  ingest:last_block:{source} = <block>
```

Worker task C is already consuming on the other side, so the UI repopulates
within seconds of each block flushing.

### 6.5 Poison batch → DLQ

```
task C: process_read_batch  → Err(e)
  for each stream in batch.raw_by_stream:
    n = INCR process:retry:{stream}:{first_id}:{last_id}
    EXPIRE same TTL = DLQ_ATTEMPT_TTL_SECS
    if n >= PROCESS_DLQ_MAX_ATTEMPTS:
       XADD {stream}_dlq  (orig fields + original_id=<id>)
       XACK stream group <ids…>     ← removes from PEL
       DEL  process:retry:…         ← clear counter
    else:
       leave in PEL; next XREADGROUP> re-reads them
```

Clickhouse-process uses the same algorithm with
`CLICKHOUSE_DLQ_*` settings — its attempt keys share the `process:retry:*`
namespace but keyed by `(stream, first, last)` so both groups retry
independently.

### 6.6 Graceful shutdown

1. SIGINT / SIGTERM arrives.
2. `install_shutdown()`'s spawned watcher flips the `watch` channel.
3. Each task observes `shutdown.wait()` in its `tokio::select!` and breaks
   out of its loop.
4. Task A finishes any in-flight `TargetedJob::execute` before exiting
   (it doesn't re-enter the BRPOP).
5. Task C finishes the current `process_read_batch` (which XACKs on success)
   before exiting.
6. `main.rs` joins all three tasks and exits.

No message is lost. A batch interrupted mid-process stays in the PEL and
is re-delivered when the worker restarts.

---

## 7. Configuration reference

### 7.1 Core (`Config::from_env`) — used by `ingest` + worker task A

| Variable                     | Default                                | Purpose                                           |
|------------------------------|----------------------------------------|---------------------------------------------------|
| `INGEST_SOURCE`              | unset (auto-detect)                    | `"etherscan"` / `"alchemy"` / `"mock"`            |
| `ETHERSCAN_API_KEY`          | —                                      | Required for etherscan source                     |
| `ETHERSCAN_BASE_URL`         | `https://api.etherscan.io/v2/api`     | V2 proxy endpoint                                 |
| `ETHERSCAN_CHAIN_ID`         | `1`                                    | 1=mainnet, 11155111=sepolia, 137=polygon, …       |
| `ALCHEMY_API_KEY`            | —                                      | Required for alchemy source                       |
| `ALCHEMY_BASE_URL`           | `https://eth-mainnet.g.alchemy.com/v2/`| Alchemy base                                      |
| `ALCHEMY_CHAIN`              | `eth-mainnet`                          | Reserved for multi-chain                          |
| `REDIS_URL`                  | `redis://localhost:6379`               |                                                   |
| `INGEST_BATCH_SIZE`          | `1000`                                 | Soft target for batched XADD pipelines            |
| `INGEST_STREAM_MAXLEN`       | `1000000`                              | MAXLEN ~ arg; `0` disables trimming               |
| `INGEST_TARGETED_QUEUE`      | `ingest:targeted_queue`                | Redis list key                                    |
| `DATABASE_URL`               | —                                      | Enables `ingestion_runs` updates in targeted mode |
| `METRICS_PORT`               | `9100`                                 | Prometheus listener                               |

### 7.2 Stream processor (`ProcessConfig::from_env`) — worker task C

| Variable                         | Default                                                               |
|----------------------------------|-----------------------------------------------------------------------|
| `REDIS_URL`                      | `redis://localhost:6379`                                              |
| `NEO4J_URI`                      | `bolt://localhost:7687`                                               |
| `NEO4J_USER`                     | `neo4j`                                                               |
| `NEO4J_PASSWORD`                 | `password123`                                                         |
| `NEO4J_DATABASE`                 | `neo4j`                                                               |
| `DATABASE_URL`                   | `postgresql://postgres:postgres123@localhost:5432/chain_analysis`     |
| `PROCESS_BATCH_SIZE`             | `500`                                                                 |
| `PROCESS_CONSUMER_GROUP`         | `chain-analysis-process`                                              |
| `PROCESS_CONSUMER_NAME`          | `consumer-{pid}`                                                      |
| `PROCESS_DLQ_MAX_ATTEMPTS`       | `5`                                                                   |
| `PROCESS_DLQ_SUFFIX`             | `_dlq`                                                                |
| `PROCESS_DLQ_ATTEMPT_TTL_SECS`   | `86400`                                                               |

### 7.3 Worker tuning (`WorkerConfig`)

| Variable                         | Default  | Applies to               |
|----------------------------------|----------|--------------------------|
| `REFRESH_INTERVAL_SECS`          | `300`    | Task B tick              |
| `REFRESH_COOLDOWN_SECS`          | `1800`   | Task B per-address       |
| `TARGETED_BRPOP_TIMEOUT_SECS`    | `5`      | Task A BRPOP             |
| `WORKER_STREAM_BATCH_SIZE`       | `500`    | Task C XREADGROUP COUNT  |
| `WORKER_STREAM_BLOCK_MS`         | `5000`   | Task C XREADGROUP BLOCK  |

### 7.4 ClickHouse (`ClickhouseConfig::from_env`)

| Variable                           | Default                            |
|------------------------------------|------------------------------------|
| `CLICKHOUSE_URL`                   | `http://localhost:8123`            |
| `CLICKHOUSE_DATABASE`              | `chain_analysis`                   |
| `CLICKHOUSE_USER`                  | `default`                          |
| `CLICKHOUSE_PASSWORD`              | *(empty)*                          |
| `CLICKHOUSE_BATCH_SIZE`            | `1000`                             |
| `CLICKHOUSE_CONSUMER_GROUP`        | `chain-analysis-clickhouse`        |
| `CLICKHOUSE_CONSUMER_NAME`         | `ch-consumer-{pid}`                |
| `CLICKHOUSE_DLQ_MAX_ATTEMPTS`      | `5`                                |
| `CLICKHOUSE_DLQ_SUFFIX`            | `_dlq`                             |
| `CLICKHOUSE_DLQ_ATTEMPT_TTL_SECS`  | `86400`                            |

### 7.5 Neighborhood caps

| Variable                           | Default                     |
|------------------------------------|-----------------------------|
| `NEIGHBORHOOD_TX_LIMIT_PER_ADDR`   | `500` (per peer per hop)    |
| `MAX_PEERS_PER_HOP`                | `20` (ranked by frequency)  |

---

## 8. Observability — metrics, logs, progress events

### 8.1 Metrics (`/metrics` on port 9100)

All names live in `etl::observability`:

| Metric                                  | Type      | Labels                      |
|-----------------------------------------|-----------|-----------------------------|
| `ingest_blocks_fetched_total`           | counter   | `source`                    |
| `ingest_blocks_failed_total`            | counter   | `source`                    |
| `ingest_fetch_duration_seconds`         | histogram | `source`                    |
| `stream_messages_published_total`       | counter   | `stream`                    |
| `stream_maxlen_trims_total`             | counter   | `stream`                    |
| `consumer_batches_processed_total`      | counter   | `group`, `outcome`          |
| `consumer_messages_processed_total`     | counter   | `group`, `stream`           |
| `consumer_parse_failures_total`         | counter   | `group`, `stream`           |
| `consumer_batch_duration_seconds`       | histogram | `group`                     |
| `dlq_moves_total`                       | counter   | `stream`                    |
| `dlq_messages_moved_total`              | counter   | `stream`                    |

All metrics carry a `service` label (`ingest`, `worker`, or
`clickhouse-process`) set by `observability::init`.

### 8.2 Logs

Structured JSON via `tracing-subscriber` with `EnvFilter` honouring
`RUST_LOG` (default `info`). Every log line carries the task name
(`task=targeted`, `task=refresh`, `task=stream`) and relevant IDs
(`run_id`, `task_id`, `stream`, `block`).

### 8.3 Progress events

Two streams consumed by the FastAPI backend:

**`ingestion_progress`** — produced by the fetch tier. JSON payloads:

```json
{"type":"Progress","run_id":"…","current_block":123,"total_blocks":500,"transactions_processed":12345}
{"type":"Complete","run_id":"…","blocks_processed":500,"transactions_processed":48910}
{"type":"Error",   "run_id":"…","message":"…"}
```

**`processing_progress`** — produced by the stream tier. JSON payloads:

```json
{"type":"Progress","run_id":"…","stage":"resolve_entities","processed":120,"total":120}
{"type":"Complete","run_id":"…","entities_processed":120,"transactions_processed":480}
{"type":"Error",   "run_id":"…","message":"…"}
```

The backend's `/api/ingestion-runs/{run_id}/events` SSE route filters
both streams by `run_id` and pushes them to the frontend pill.

---

## 9. Failure handling — retries, DLQ, delta cursors

### 9.1 Fetch retry

`pipeline::with_retry(&policy, "op", || fut)` wraps each provider call.
Policy (defaults): 5 retries, 1s → 2x backoff → cap 60s.

After exhaustion in block mode, the block number is `SADD`'d into
`ingest:failed_blocks:{source}` via
`writer_actor → WriterCommand::FailedBlock → writer.record_failed_block`.
`ingest reprocess-failed` drains this set by re-running
`ingest_block_range_pipelined` per block.

### 9.2 Consumer-side DLQ (per-batch attempt counter)

Motivation: a single poison message shouldn't wedge the whole stream.

```
key      = process:retry:{stream}:{first_msg_id}:{last_msg_id}
INCR key
EXPIRE key DLQ_ATTEMPT_TTL_SECS
if value >= max_attempts:
    XADD {stream}_dlq  <original fields + original_id=<first_msg_id>>
    XACK stream group <all message ids in batch>
    DEL  key
```

The DLQ entry preserves the entire original field set plus an
`original_id` field so operators can replay via XRANGE if they want.

### 9.3 Delta cursor (avoids duplicated history on re-ingest)

`entity_features.last_synced_block` stores the max block we've ever
processed per address. Two places use it:

- **Fetch side** (`effective_from_block` in `ingest::targeted`) — a
  targeted fetch starts at `max(requested_from, last_synced_block + 1)`.
- **Consumer side** (`bump_last_synced_block` in `process_read_batch`) —
  after a batch is XACK'd, the per-address max block from the batch's
  `txs` is written back.

Result: triggering "Deep trace" twice on the same address doesn't
double-insert blocks; the second trigger becomes a no-op up to the head
of the chain.

---

## 10. Cooperation with the rest of the stack

### 10.1 With the FastAPI backend (`backend/`)

- `POST /api/pipeline/ingest-address` →
  1. INSERT into `ingestion_runs (status='queued', run_id=uuid())`
  2. LPUSH `ingest:targeted_queue` with the run_id
  3. return 202 + run_id
- `POST /api/labels/fetch` → LPUSH with a `task_id` field (the
  `label_tasks` row).
- `GET /api/ingestion-runs/{run_id}/events` (SSE) → tails
  `ingestion_progress` + `processing_progress` filtered by run_id.
- `GET /api/ingestion-runs` → straight SELECT from `ingestion_runs`.

The backend **never** writes Neo4j or Postgres directly on the ingest
path; it only enqueues. This lets the worker be the single arbiter of
row state transitions and keeps the `entity_features` update path
deadlock-free.

### 10.2 With the frontend

The frontend doesn't talk to Redis. It:

1. Posts the trigger to the backend.
2. Opens the SSE stream for the returned `run_id`.
3. Displays the `RunStatusPill` which reflects the fetch-tier +
   stream-tier progress events in real time.

### 10.3 With Dagster (dormant)

Targeted ingestion is no longer Dagster-driven — the `targeted_queue_sensor`
and `targeted_drain_job` were removed in Phase I. Dagster retains only
`reprocess_job` (a wrapper that invokes `ingest reprocess-failed`) and
`backfill_job` for scheduled historical ranges.

### 10.4 With ClickHouse

`clickhouse-process` is an entirely separate consumer group — kill it and
Neo4j/Postgres ingestion continues unaffected. The two groups are only
coupled through `INGEST_STREAM_MAXLEN`: if one group falls far enough
behind that the stream head lapses past its read position, its messages
are evicted. Monitor `XPENDING ingested_txs <group>` against MAXLEN.

---

## 11. Operational recipes

### 11.1 Build & run

```bash
cd etl-rs
cargo build --release --workspace --bins

# Environment (or use .env + direnv)
export ETHERSCAN_API_KEY=…
export REDIS_URL=redis://localhost:6379
export NEO4J_URI=bolt://localhost:7687
export NEO4J_PASSWORD=password123
export DATABASE_URL=postgresql://postgres:postgres123@localhost:5432/chain_analysis
export CLICKHOUSE_URL=http://localhost:8123

# Long-running daemon (three tasks in one process)
target/release/worker

# Optional: OLAP sink
target/release/clickhouse-process
```

### 11.2 Bulk backfill a block range

```bash
target/release/ingest block \
  --start 21000000 --end 21001000 \
  --fetch-concurrency 8 \
  --with-traces --with-transfers
```

The `worker` daemon (or a `process`-class consumer) picks up the XADDs on
the other side in real time.

### 11.3 Targeted fetch from the CLI

```bash
target/release/ingest targeted addresses --addrs 0xaaa,0xbbb
target/release/ingest targeted neighborhood 0xseed --hops 2 --with-traces
target/release/ingest targeted hashes --hashes 0x1,0x2
```

Equivalent to LPUSHing the same payload onto `ingest:targeted_queue`.

### 11.4 Drain failed blocks

```bash
# Check
docker exec chain-analysis-redis redis-cli SMEMBERS ingest:failed_blocks:etherscan

# Re-run
target/release/ingest reprocess-failed --source etherscan --fetch-concurrency 4
```

### 11.5 Replay a DLQ

DLQ messages live in `{stream}_dlq` with the original fields preserved
plus an `original_id` field. Simple replay:

```bash
# Inspect
docker exec chain-analysis-redis redis-cli XLEN ingested_txs_dlq
docker exec chain-analysis-redis redis-cli XRANGE ingested_txs_dlq - + COUNT 5

# To replay: XADD each entry back onto `ingested_txs` (script-only — no CLI)
```

### 11.6 Reset a stuck consumer group

```bash
# Rewind the graph consumer group to the beginning of the stream
docker exec chain-analysis-redis redis-cli \
  XGROUP SETID ingested_txs chain-analysis-process 0
docker exec chain-analysis-redis redis-cli \
  XGROUP SETID ingested_traces chain-analysis-process 0
docker exec chain-analysis-redis redis-cli \
  XGROUP SETID ingested_transfers chain-analysis-process 0
```

Consumer group name is kept for historical reasons — the binary is
`worker`, the group label is `chain-analysis-process`.

### 11.7 Scale consumers horizontally

```bash
PROCESS_CONSUMER_NAME=worker-1 target/release/worker
PROCESS_CONSUMER_NAME=worker-2 target/release/worker
```

Redis distributes pending messages between consumers within the same
group. Task A (BRPOP) scales too — two BRPOPping workers will split the
`ingest:targeted_queue` load.

### 11.8 Monitor

```bash
# Stream length
watch -n5 'docker exec chain-analysis-redis redis-cli \
  XLEN ingested_txs'

# Pending per group
docker exec chain-analysis-redis redis-cli \
  XPENDING ingested_txs chain-analysis-process

# DLQ depth
docker exec chain-analysis-redis redis-cli XLEN ingested_txs_dlq

# Prometheus
curl -s localhost:9100/metrics | grep -E '^(ingest|consumer|dlq)_'
```

---

## 12. Troubleshooting

### "No such consumer group"

First boot — `StreamConsumer::ensure_groups()` runs XGROUP CREATE MKSTREAM.
If you see it at steady state, the group was deleted externally — just
restart the consumer.

### Worker doesn't pick up clicks instantly

Check `TARGETED_BRPOP_TIMEOUT_SECS` — that's the max delay between LPUSH
and BRPOP returning. The default 5s is fine for interactive use; for
sub-second latency drop to 1.

### Neo4j deadlocks under concurrent upsert

`Neo4jWriter` retries deadlocks internally with jittered backoff
(`Neo.TransientError.Transaction.DeadlockDetected`). If they persist,
reduce `WORKER_STREAM_BATCH_SIZE` so each transaction touches fewer
nodes.

### ClickHouse fallen behind

Check `XPENDING ingested_txs chain-analysis-clickhouse`. If pending
count > `INGEST_STREAM_MAXLEN * 0.5`, bump `CLICKHOUSE_BATCH_SIZE` or
run a second `clickhouse-process` instance.

### "ETHERSCAN_API_KEY required for address mode"

`ingest address …` and `ingest targeted hashes …` need Etherscan.
Alchemy exposes no `txlist` equivalent. Either set the key or use
`ingest block …` which has mock fallback.

### Refresh loop spams LPUSH

If the cooldown map is smaller than `known_labels ∪ entity_features`,
every tick re-queues everything. Raise `REFRESH_COOLDOWN_SECS` or lower
the address scope in the refresh SQL (`bin/worker/src/refresh.rs`).

### Progress pill stuck on "running" after task completed

Symptom of a pre-Phase-I enum (`in_progress` instead of `running`) —
ensure the `label_tasks.status` enum values are
`{queued, running, completed, failed}` and that the frontend
`RunStatusPill` maps them 1:1.

---

## 13. Tests & benchmarks

### 13.1 Test layout

```
etl-rs/crates/etl/tests/
├── common/mod.rs       # shared testcontainers harness + worker-loop test helper
├── e2e_pipeline.rs     # ingest → stream → consumer → Neo4j+PG happy path
├── chaos.rs            # mid-loop failure injection (Redis/PG/Neo4j)
├── pipeline_dlq.rs     # DLQ primitives (env-var gated)
├── ingest_reprocess.rs
├── sinks_clickhouse.rs
├── sinks_maxlen.rs
└── sources_alchemy_live.rs
```

**Run unit tests** (always-on, no Docker):

```bash
cd etl-rs
cargo test --workspace --lib
```

**Run e2e + chaos** (requires Docker; ~2-3 min):

```bash
cd etl-rs
cargo test --test e2e_pipeline -- --ignored --nocapture
cargo test --test chaos -- --ignored --nocapture --test-threads=1
```

`--test-threads=1` for chaos because each test spins up its own
Redis/PG/Neo4j stack — running them in parallel fights for ports and
Docker daemon resources.

For diagnostic logs:

```bash
RUST_LOG=info,etl=debug,common=debug,chaos=debug \
  cargo test --test chaos -- --ignored --nocapture --test-threads=1
```

### 13.2 What chaos tests verify

Each chaos test injects a failure *while* the worker loop is processing.
The end-state assertion is "no data loss":

- `XPENDING == 0` for the consumer group across all three streams
- Postgres `entity_features` has rows (data persisted)
- `dlq_moves == 0` (didn't escalate beyond retry budget)

Note on `batches_err`: the chaos mechanism (`docker pause` /
`pg_terminate_backend`) hangs operations or is silently handled by sqlx's
`test_before_acquire`, so we cannot reliably observe error counts. To
exercise the retry/DLQ path with observable errors, a network-level
proxy (Toxiproxy) would be needed — that's a separate effort. The current
tests prove the system *survives* chaos and converges to a clean state.

### 13.3 Throughput bench

```bash
cd etl-rs
cargo bench -p etl --bench ingest_throughput
```

Ingests 10,000 mock blocks at `fetch_concurrency = 16` against a real
Redis container. Reports:

- Total wall time
- Throughput (blocks/sec)
- Per-100-block-chunk latency (p50, p95, p99, max)

Per-block latency isn't reported because the writer actor batches —
single-block timing is meaningless. Per-chunk = 100 blocks of pipelined
work is the smallest meaningful unit.

Reference numbers live in `etl-rs/bench/baseline.md`. Treat them as
indicative — GitHub-hosted runners vary by ±30%. CI doesn't gate on
absolute numbers; the bench is opt-in via the `run-bench` PR label.
