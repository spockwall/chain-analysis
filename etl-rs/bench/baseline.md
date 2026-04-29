# ETL Bench Baseline

Reference numbers for `cargo bench -p etl --bench ingest_throughput`.

PR review should call out regressions of ≥30% against these. Numbers are
hardware-sensitive; treat them as indicative, not contractual.

## Methodology

- 10,000 mock blocks ingested through `ingest_block_range_pipelined` into
  a real Redis 7 container (testcontainers, AOF off — this is the ingest
  tier only, not the consumer).
- Chunks of 100 blocks at `fetch_concurrency = 16`.
- Each chunk's wall-clock time is recorded into an HDR histogram; the
  reported latency is per-chunk (100 blocks), not per-block.

## Latest baseline

| Metric           | Value             |
|------------------|-------------------|
| Throughput       | 2,275 blocks/sec  |
| Per-chunk p50    | 43.23 ms          |
| Per-chunk p95    | 45.82 ms          |
| Per-chunk p99    | 46.24 ms          |
| Per-chunk max    | 46.62 ms          |

Captured on:
- Date: 2026-04-29
- Host: WSL2 on Windows 11, Docker Desktop (developer workstation; not a CI runner)
- Rust: 1.95.0 stable

To refresh, run from `etl-rs/`:

```bash
cargo bench -p etl --bench ingest_throughput 2>&1 | tail -30
```

Then update the table above with the values from the
`=== ingest_throughput results ===` block.

## CI runners

GitHub-hosted runners vary ±30% between runs, so we do **not** gate CI on
absolute numbers. The bench job is opt-in (label-gated) and exists to
produce a comparable number when investigating a suspected regression.
