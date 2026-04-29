//! 10k-block ingest throughput + latency bench.
//!
//! Runs `MockSource → ingest_block_range_pipelined → Redis stream` over 100
//! chunks of 100 blocks at fixed `fetch_concurrency`. Measures wall-clock
//! per-chunk time (not per-block, because the writer actor batches; per-block
//! timing would alias across chunks).
//!
//! Output: total time, blocks/sec, and per-chunk latency p50/p95/p99 (ms).
//!
//! Run with:
//!   cd etl-rs
//!   cargo bench -p etl --bench ingest_throughput
//!
//! Requires Docker for the Redis container.

use etl::ingest::{ingest_block_range_pipelined, DynBlockSource};
use etl::pipeline::{ProgressReporter, RetryPolicy};
use etl::sinks::redis_stream::{RedisStreamWriter, TransactionWriter};
use etl::sources::mock::MockSource;
use hdrhistogram::Histogram;
use std::sync::Arc;
use std::time::Instant;
use testcontainers::core::{ContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};

const TOTAL_BLOCKS: u64 = 10_000;
const CHUNK_SIZE: u64 = 100;
const FETCH_CONCURRENCY: usize = 16;

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    eprintln!(
        "ingest_throughput: starting Redis container (this can take ~10s on first run)"
    );

    let redis = GenericImage::new("redis", "7-alpine")
        .with_exposed_port(ContainerPort::Tcp(6379))
        .with_wait_for(WaitFor::message_on_stdout("Ready to accept connections"))
        .with_cmd(["redis-server", "--appendonly", "no"])
        .start()
        .await
        .expect("redis start");
    let port = redis.get_host_port_ipv4(6379).await.expect("redis port");
    let redis_url = format!("redis://127.0.0.1:{}", port);

    eprintln!(
        "ingest_throughput: redis ready at {}; running {} blocks in {} chunks of {}",
        redis_url, TOTAL_BLOCKS, TOTAL_BLOCKS / CHUNK_SIZE, CHUNK_SIZE
    );

    // Three-significant-digit histogram in microseconds.
    let mut hist = Histogram::<u64>::new(3).expect("histogram");
    let total_start = Instant::now();
    let chunks = TOTAL_BLOCKS / CHUNK_SIZE;

    for c in 0..chunks {
        let start_block = c * CHUNK_SIZE;
        let end_block = start_block + CHUNK_SIZE - 1;

        let writer: Box<dyn TransactionWriter> = Box::new(
            RedisStreamWriter::connect(&redis_url, "bench", None)
                .await
                .expect("redis writer"),
        );
        let reporter = ProgressReporter::new_dry_run(&format!("bench-chunk-{}", c));
        let source: DynBlockSource = Arc::new(MockSource);

        let chunk_start = Instant::now();
        let _ = ingest_block_range_pipelined(
            source,
            start_block,
            end_block,
            writer,
            reporter,
            &RetryPolicy::default(),
            false,
            false,
            FETCH_CONCURRENCY,
            CHUNK_SIZE,
            0,
        )
        .await
        .expect("ingest chunk");
        let elapsed_us = chunk_start.elapsed().as_micros() as u64;
        hist.record(elapsed_us).expect("record");
    }

    let total = total_start.elapsed();
    let throughput = TOTAL_BLOCKS as f64 / total.as_secs_f64();

    let p50_ms = hist.value_at_quantile(0.50) as f64 / 1000.0;
    let p95_ms = hist.value_at_quantile(0.95) as f64 / 1000.0;
    let p99_ms = hist.value_at_quantile(0.99) as f64 / 1000.0;
    let max_ms = hist.max() as f64 / 1000.0;

    println!();
    println!("=== ingest_throughput results ===");
    println!("Total blocks:       {}", TOTAL_BLOCKS);
    println!("Chunk size:         {}", CHUNK_SIZE);
    println!("Fetch concurrency:  {}", FETCH_CONCURRENCY);
    println!("Total wall time:    {:.2}s", total.as_secs_f64());
    println!("Throughput:         {:.1} blocks/sec", throughput);
    println!("Per-chunk latency:");
    println!("  p50  = {:>8.2} ms", p50_ms);
    println!("  p95  = {:>8.2} ms", p95_ms);
    println!("  p99  = {:>8.2} ms", p99_ms);
    println!("  max  = {:>8.2} ms", max_ms);
    println!("=================================");
}
