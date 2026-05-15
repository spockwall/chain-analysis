---
name: etl-rs
description: Rust ETL workspace under etl-rs/ — workspace crates (types, config, sources with BlockSource trait, sinks for Redis/Neo4j/Postgres/ClickHouse, pipeline retry/DLQ, consumer, ingest, worker, clickhouse), data-flow diagram (Etherscan → Redis streams → Neo4j+PG), `ingest` one-shot CLI subcommands (block, address, reprocess-failed, targeted addresses/neighborhood), `worker` long-running binary three tasks (A targeted_queue BRPOP, B refresh known_labels, C XREADGROUP stream consumer → graph+PG), build commands, and how to reset a stuck consumer group via XGROUP SETID. Invoke when touching anything under etl-rs/, modifying the ingest or worker binaries, changing Redis stream consumer logic, or debugging the ETL pipeline.
---

## Rust ETL Workers (`etl-rs/`)

Two long-running binaries plus one CLI, communicating via Redis:

```
[Etherscan API]
      │   ← ingest binary (one-shot CLI) / worker task A (continuous)
      ▼
[Redis]  streams: ingested_txs / ingested_traces / ingested_transfers
         list:    ingest:targeted_queue  (BRPOPped by worker task A)
      │   ← worker task C (stream consumer)
      ▼
[Neo4j + PostgreSQL]
```

**Workspace crates:**

| Crate | Role |
|---|---|
| `types` | Shared value types (`Transaction`, `Trace`, `Transfer`) |
| `config` | Env-based `Config` + `ProcessConfig` |
| `sources` | `BlockSource` trait + Etherscan / Alchemy / Mock impls |
| `sinks` | Redis Streams writer/consumer, Neo4j/Postgres/ClickHouse writers |
| `pipeline` | Retry, DLQ, shutdown handle, progress reporters |
| `consumer` | `read_batch` + `process_read_batch` (used by `worker` task C) |
| `ingest` | `ingest` binary — one-shot CLI for backfills / ad-hoc targeted fetches |
| `worker` | `worker` binary — long-running, three tokio tasks (targeted queue + refresh + stream consumer) |
| `clickhouse` | `clickhouse-process` binary — independent OLAP consumer group |

**`ingest` CLI:**
```
ingest block --start N --end M [--with-traces] [--with-transfers]
ingest address 0x... [--with-traces] [--with-transfers]
ingest reprocess-failed --source {etherscan,alchemy}
ingest targeted addresses --addrs 0xaaa,0xbbb
ingest targeted neighborhood 0xseed --hops 1
```

**`worker` binary:**
```
worker               # continuous — task A (BRPOP targeted_queue),
                     #              task B (refresh known_labels + high-risk),
                     #              task C (stream consumer → Neo4j + Postgres)
```

**Build:**
```bash
cd etl-rs
cargo build --release   # produces target/release/{ingest, worker, clickhouse-process}
```

**Reset stuck consumer group:**
```bash
docker exec chain-analysis-redis redis-cli XGROUP SETID ingested_txs chain-analysis-process 0
```
(The consumer group name is still `chain-analysis-process` for
backwards compatibility — only the binary name changed.)
