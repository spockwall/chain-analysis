//! Integration test for `reprocess_failed_blocks`. Gated on `E2E_REDIS_URL`.
//!
//! ```sh
//! E2E_REDIS_URL=redis://localhost:6379 cargo test -p ingest --test reprocess
//! ```

use ingest::modes::reprocess::reprocess_failed_blocks;
use pipeline::{ProgressReporter, RetryPolicy};
use redis::AsyncCommands;
use sinks::redis_stream::{RedisStreamWriter, TransactionWriter};

fn e2e_redis_url() -> Option<String> {
    std::env::var("E2E_REDIS_URL").ok()
}

#[tokio::test]
async fn reprocess_drains_failed_blocks_set() {
    let Some(url) = e2e_redis_url() else {
        eprintln!("E2E_REDIS_URL unset — skipping");
        return;
    };

    // Unique source tag isolates this test's failed-blocks SET from other runs.
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let source = format!("mock-{}", tag);
    let key = format!("ingest:failed_blocks:{}", source);

    let client = redis::Client::open(url.clone()).unwrap();
    let mut conn = client.get_multiplexed_async_connection().await.unwrap();

    // Seed two failed block numbers.
    let _: i32 = conn.sadd(&key, 100u64).await.unwrap();
    let _: i32 = conn.sadd(&key, 101u64).await.unwrap();

    let writer = RedisStreamWriter::connect(&url, &source, None)
        .await
        .expect("connect writer");
    let writer: Box<dyn TransactionWriter> = Box::new(writer);
    let reporter = ProgressReporter::new_dry_run(&format!("reprocess-{}", tag));
    let retry = RetryPolicy::default();

    // Mock mode: etherscan_api_key=None causes the pipeline to fetch deterministic mock blocks.
    let cfg = config::Config {
        etherscan_api_key: None,
        etherscan_base_url: "unused".into(),
        etherscan_chain_id: 1,
        redis_url: url.clone(),
        batch_size: 100,
        stream_maxlen: None,
        targeted_queue_key: "unused".into(),
        postgres_url: None,
    };

    let (_w, _r, ok_count, total_txs) =
        reprocess_failed_blocks(&cfg, &source, writer, reporter, &retry, false, false, 2)
            .await
            .expect("reprocess");

    assert_eq!(ok_count, 2, "expected both blocks reprocessed, got {}", ok_count);
    assert!(total_txs > 0, "expected mock ingest to produce txs, got {}", total_txs);

    let remaining: Vec<u64> = conn.smembers(&key).await.unwrap();
    assert!(
        remaining.is_empty(),
        "expected failed-blocks set drained, got {:?}",
        remaining
    );

    // Cleanup (set should already be empty, but just in case).
    let _: i32 = conn.del(&key).await.unwrap_or(0);
}
