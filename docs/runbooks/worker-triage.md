# Worker triage runbook

When someone says "the worker is acting up", run the **3-minute SOP** at the
top first. ~95% of incidents surface in one of those four checks. The deeper
sections cover specific failure modes once you've narrowed it down.

Worker logs live in `logs/<service>.log.YYYY-MM-DD` and `logs/<service>.error.log.YYYY-MM-DD`
inside the container (set `LOG_DIR` to override; default `./logs/`).

---

## 3-minute triage SOP

```bash
DATE=$(date +%Y-%m-%d)
GROUP=chain-analysis-process

# 1. Are there any actual errors? (warn+ only — empty file = healthy)
docker exec chain-analysis-worker cat logs/worker.error.log.$DATE | head -20

# 2. Pending list (PEL) — messages stuck mid-processing
for s in ingested_txs ingested_traces ingested_transfers; do
  echo -n "$s pending: "
  docker exec chain-analysis-redis redis-cli XPENDING $s $GROUP | head -1
done

# 3. DLQ depth — messages quarantined after retry exhaustion
for s in ingested_txs ingested_traces ingested_transfers; do
  echo -n "${s}_dlq: "
  docker exec chain-analysis-redis redis-cli XLEN ${s}_dlq
done

# 4. Is the loop still iterating? (latest log line + timestamp)
docker exec chain-analysis-worker tail -3 logs/worker.log.$DATE
```

**Interpretation:**

| Symptom | Likely cause | Next section |
|---|---|---|
| #1 has content | Specific error logged | Read it; usually self-explanatory |
| #2 > 0 and growing | Worker failing to process; messages re-read but never ACK'd | [Stuck PEL](#stuck-pel) |
| #3 > 0 | Retry budget exhausted, batches quarantined | [DLQ triage](#dlq-triage) |
| #4 timestamp old (>1 min) | Worker stalled | [Worker stalled](#worker-stalled) |
| All clean but users complaining | Performance / specific task issue | [Performance](#performance) |

---

## Stuck PEL

Messages live in the consumer's pending list when `XREADGROUP` delivered them
but no `XACK` followed (i.e. processing failed). Pending-first read makes the
next loop iteration retry them.

```bash
# Detail of pending entries
docker exec chain-analysis-redis redis-cli \
  XPENDING ingested_txs $GROUP - + 10

# Consumer-level breakdown
docker exec chain-analysis-redis redis-cli \
  XINFO CONSUMERS ingested_txs $GROUP
```

If PEL is non-zero **and not shrinking**, the worker is failing on those messages
every retry. Check `worker.error.log` for the recurring error and decide:

- Transient downstream issue (Neo4j down, PG flapping) → wait or restart the dep
- Permanent — schema drift, malformed JSON → batch will eventually go to DLQ
  after `dlq_max_attempts` (default 5)

If you need to clear PEL manually (data loss acceptable):

```bash
# Move all stuck entries to DLQ for triage, ACK them in original stream
# (Implement only after reading XCLAIM / XAUTOCLAIM docs — easy to lose data here.)
```

---

## DLQ triage

Quarantined batches end up in `<stream>_dlq`. Inspect, replay, or drop them
with the `ingest dlq` CLI:

```bash
# What's in the queue?
cd etl-rs
cargo run --release -p ingest-bin -- dlq list --stream ingested_txs --limit 20

# After fixing the upstream issue, replay back to the original stream
cargo run --release -p ingest-bin -- dlq replay --stream ingested_txs --all

# Permanently remove (only after you've captured the payload elsewhere)
cargo run --release -p ingest-bin -- dlq drop --stream ingested_txs --all
```

Replay is safe: `XADD` to original happens **before** `XDEL` from DLQ, so a
crash mid-op produces a duplicate (worker `MERGE` is idempotent), never a
loss.

---

## Worker stalled

No new log lines for >1 minute means the worker isn't iterating. Confirm:

```bash
# Check the iter counter is still advancing (requires debug level)
docker exec chain-analysis-worker tail -f logs/worker.log.$DATE | grep "iter="
```

If `iter` is stuck:

| Stuck on | Diagnosis |
|---|---|
| `loop: read batch iter=N` last line | Stream read hangs — Redis network issue, container paused |
| `loop: batch ok iter=N` last line + no next read | Process step took forever; check Neo4j / PG load |
| `loop: process_read_batch failed` repeating | Same batch failing every retry; check the error |

To enable per-iteration timing, set `RUST_LOG=info,etl=debug,worker_bin=debug`
on the worker container and restart:

```bash
# Edit compose/etl.yml worker.environment, add:
- RUST_LOG=info,etl=debug,worker_bin=debug

docker compose up -d worker
```

You'll see `read_ms=`, `process_ms=`, `attempts=` on every iteration. Look
for a step that's an order of magnitude slower than the rest.

---

## Performance

Even when nothing is broken, things can get slow.

### Throughput dropped

```bash
# Per-batch processing time (look for outliers)
docker exec chain-analysis-worker grep "process_ms" logs/worker.log.$DATE \
  | awk -F'process_ms=' '{print $2}' | awk '{print $1}' \
  | sort -n | tail -20
```

Typical p50 ~150-300 ms per batch (500 messages). Sustained > 1s per batch
points to a downstream bottleneck.

### Neo4j slow

```bash
# Look at "Upserted X nodes" timings — large gaps mean Neo4j is the bottleneck
docker exec chain-analysis-worker grep "Upserted" logs/worker.log.$DATE | tail -30

# Check Neo4j heap pressure
docker exec chain-analysis-neo4j cypher-shell -u neo4j -p changeme \
  "CALL dbms.queryJmx('java.lang:type=Memory')"
```

### Postgres saturated

```bash
docker exec chain-analysis-postgres psql -U postgres -d chain_analysis -c \
  "SELECT count(*), state, application_name
     FROM pg_stat_activity
    WHERE application_name LIKE 'worker%'
    GROUP BY state, application_name"
```

`state = 'active'` consistently > 1 = queries are queueing. Either tune
worker batch size down or check PG indexes.

---

## Specific task / address didn't process

```bash
# Find every log line touching a task or address
docker exec chain-analysis-worker grep 'task_id=42' logs/worker.log.$DATE
docker exec chain-analysis-worker grep '0xabcdef1234' logs/worker.log.$DATE
```

If it's missing entirely from the log, the message either never made it into
Redis (check ingest-side logs) or is still in the targeted-queue:

```bash
docker exec chain-analysis-redis redis-cli LLEN ingest:targeted_queue
docker exec chain-analysis-redis redis-cli LRANGE ingest:targeted_queue 0 5
```

---

## Metrics — Prometheus

Worker exposes `/metrics` on port 9100. Cheap quick check:

```bash
curl -s http://localhost:9100/metrics \
  | grep -E "^(dlq|consumer_parse_failures|consumer_batches_processed|ingest_blocks_failed)"
```

Key counters worth watching over time (Grafana if running):

| Metric | What it tells you |
|---|---|
| `dlq_moves_total{stream=...}` | How often retry budget is exhausted |
| `consumer_parse_failures_total` | Schema drift early signal |
| `consumer_batches_processed_total{outcome="error"}` | Failed batches |
| `ingest_blocks_failed_total{source=...}` | Upstream API health |

---

## Recovering from a full reset

If a local dev environment is wedged beyond saving:

```bash
docker compose down -v   # WARNING: wipes Neo4j / PG / Redis volumes
docker compose up -d redis postgres neo4j
sleep 15
docker compose up -d worker
```

`-v` is required to drop named volumes — without it, the old PG password etc.
will fight with the current `compose/secrets.dev.env`.
