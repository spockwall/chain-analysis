//! End-to-end test: drive mock ingest into a real Redis and assert the stream
//! is populated.
//!
//! Gated on the `E2E_REDIS_URL` env var. Set it to a reachable Redis instance
//! (e.g. `redis://localhost:6379`) to run:
//!
//! ```sh
//! E2E_REDIS_URL=redis://localhost:6379 cargo test --test e2e -- --nocapture
//! ```

use pipeline::{ProgressReporter, RetryPolicy};
use redis::AsyncCommands;
use sinks::redis_stream::{RedisStreamWriter, TransactionWriter};

fn e2e_redis_url() -> Option<String> {
    std::env::var("E2E_REDIS_URL").ok()
}

#[tokio::test]
async fn mock_ingest_populates_stream() {
    let Some(redis_url) = e2e_redis_url() else {
        eprintln!("E2E_REDIS_URL not set — skipping e2e test");
        return;
    };

    let source = format!("e2e-{}", uuid::Uuid::new_v4());
    let stream_key = "ingested_txs";

    let client = redis::Client::open(redis_url.clone()).unwrap();
    let mut conn = client.get_multiplexed_async_connection().await.unwrap();
    let before_len: u64 = conn.xlen(stream_key).await.unwrap_or(0);

    let writer = RedisStreamWriter::connect(&redis_url, &source, None)
        .await
        .expect("connect writer");
    let writer: Box<dyn TransactionWriter> = Box::new(writer);

    let reporter = ProgressReporter::new_dry_run("e2e-test-run");
    let retry = RetryPolicy::default();

    let (_w, _r, total) = ingest::ingest_block_range_pipelined(
        &config::Config {
            etherscan_api_key: None,
            etherscan_base_url: "unused".into(),
            etherscan_chain_id: 1,
            redis_url: redis_url.clone(),
            batch_size: 100,
            stream_maxlen: None,
            targeted_queue_key: "unused".into(),
            postgres_url: None,
        },
        1,
        3,
        true,
        writer,
        reporter,
        &retry,
        false,
        false,
        2,
        3,
        0,
    )
    .await
    .expect("pipelined ingest");

    assert!(total > 0, "expected some txs ingested, got {}", total);

    let after_len: u64 = conn.xlen(stream_key).await.unwrap();
    assert!(
        after_len > before_len,
        "stream did not grow: before={}, after={}",
        before_len,
        after_len
    );
}
