//! End-to-end test: drive mock ingest into a real Redis and assert the stream
//! is populated.
//!
//! Gated on the `E2E_REDIS_URL` env var. Set it to a reachable Redis instance
//! (e.g. `redis://localhost:6379`) to run:
//!
//! ```sh
//! E2E_REDIS_URL=redis://localhost:6379 cargo test --test e2e -- --nocapture
//! ```

use ingest::modes::targeted::{run_targeted, TargetSpec};
use pipeline::{ProgressReporter, RetryPolicy};
use redis::AsyncCommands;
use sinks::redis_stream::{RedisStreamWriter, TransactionWriter};
use sources::mock::MockSource;
use std::sync::Arc;

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

    let source_handle: ingest::DynBlockSource = Arc::new(MockSource);
    let (_w, _r, total) = ingest::ingest_block_range_pipelined(
        source_handle,
        1,
        3,
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

#[tokio::test]
async fn from_label_tasks_drains_queue() {
    let Some(redis_url) = e2e_redis_url() else {
        eprintln!("E2E_REDIS_URL not set — skipping");
        return;
    };

    let tag = uuid::Uuid::new_v4().simple().to_string();
    let queue_key = format!("ingest:targeted_queue-{}", tag);
    let source = format!("queue-drain-{}", tag);

    let client = redis::Client::open(redis_url.clone()).unwrap();
    let mut conn = client.get_multiplexed_async_connection().await.unwrap();

    // Push a valid JSON task with EMPTY addrs so run_targeted short-circuits
    // without needing an Etherscan API key. This exercises the drain mechanism
    // itself, not the downstream fetch.
    let payload = r#"{"task_id":1,"spec":{"mode":"addresses","addrs":[]}}"#;
    let _: i64 = conn.lpush(&queue_key, payload).await.unwrap();

    // Also push a malformed payload — should be logged+skipped, not error out.
    let _: i64 = conn.lpush(&queue_key, "not-valid-json").await.unwrap();

    let before_len: u64 = conn.llen(&queue_key).await.unwrap();
    assert_eq!(before_len, 2, "expected 2 queue entries, got {}", before_len);

    let writer = RedisStreamWriter::connect(&redis_url, &source, None)
        .await
        .expect("connect writer");
    let mut writer: Box<dyn TransactionWriter> = Box::new(writer);
    let mut reporter = ProgressReporter::new_dry_run(&format!("queue-drain-{}", tag));

    let cfg = config::Config {
        etherscan_api_key: None,
        etherscan_base_url: "unused".into(),
        etherscan_chain_id: 1,
        redis_url: redis_url.clone(),
        batch_size: 100,
        stream_maxlen: None,
        targeted_queue_key: queue_key.clone(),
        postgres_url: None,
        ingest_source: None,
        alchemy_api_key: None,
        alchemy_base_url: String::new(),
        alchemy_chain: String::new(),
    };

    let _total = run_targeted(
        &cfg,
        TargetSpec::FromLabelTasks { limit: 10 },
        &mut writer,
        &mut reporter,
        None,
        false,
        false,
    )
    .await
    .expect("run_targeted drained queue");

    let after_len: u64 = conn.llen(&queue_key).await.unwrap_or(0);
    assert_eq!(after_len, 0, "queue not drained: LLEN={}", after_len);

    let _: i32 = conn.del(&queue_key).await.unwrap_or(0);
}
