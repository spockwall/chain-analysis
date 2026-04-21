//! Integration tests for Redis stream MAXLEN trimming. Gated on `E2E_REDIS_URL`.
//!
//! ```sh
//! E2E_REDIS_URL=redis://localhost:6379 cargo test -p sinks --test maxlen
//! ```
//!
//! Note: the writer hardcodes stream names (`ingested_txs` etc.), so these
//! tests measure state on that shared stream and use per-test counts.

use redis::AsyncCommands;
use sinks::redis_stream::{RedisStreamWriter, TransactionWriter, TOPIC_INGESTED_TXS};
use types::Transaction;

fn e2e_redis_url() -> Option<String> {
    std::env::var("E2E_REDIS_URL").ok()
}

fn mk_tx(i: u64) -> Transaction {
    Transaction {
        hash: format!("0x{:064x}", i),
        from_address: "0xfrom".into(),
        to_address: "0xto".into(),
        value: "1".into(),
        block_number: i,
        timestamp: 1_700_000_000 + i,
        gas_used: 21000,
        gas_price: "0".into(),
        input: "0x".into(),
        contract_address: String::new(),
    }
}

async fn conn(url: &str) -> redis::aio::MultiplexedConnection {
    redis::Client::open(url)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap()
}

#[tokio::test]
async fn maxlen_caps_stream_size() {
    let Some(url) = e2e_redis_url() else {
        eprintln!("E2E_REDIS_URL unset — skipping");
        return;
    };

    // Reset the shared stream so we can measure absolute length under the cap.
    // Other parallel tests writing to ingested_txs could perturb this, so we
    // run under a unique DB prefix strategy: DELete and assert growth under
    // 2x maxlen (approx-trim slop).
    let mut c = conn(&url).await;
    let _: i32 = c.del(TOPIC_INGESTED_TXS).await.unwrap_or(0);

    let maxlen = 50u64;
    let source = format!("maxlen-test-{}", uuid::Uuid::new_v4().simple());
    let mut writer = RedisStreamWriter::connect(&url, &source, Some(maxlen))
        .await
        .unwrap();

    // Write 200 single-tx batches (200 XADD calls, each with MAXLEN ~ 50)
    for i in 0..200u64 {
        writer.write_transactions_batch(&[mk_tx(i)]).await.unwrap();
    }

    let len: u64 = c.xlen(TOPIC_INGESTED_TXS).await.unwrap();
    // Approximate trim can overshoot; Redis docs say usually <2x, commonly 1-1.1x.
    // Cap at 2.5x to tolerate any CI flakiness from concurrent writers.
    assert!(
        len <= maxlen * 5 / 2,
        "expected XLEN <= {} with maxlen={}, got {}",
        maxlen * 5 / 2,
        maxlen,
        len
    );
    assert!(len > 0, "stream is empty — writer didn't run");
}

#[tokio::test]
async fn maxlen_none_does_not_trim() {
    let Some(url) = e2e_redis_url() else {
        eprintln!("E2E_REDIS_URL unset — skipping");
        return;
    };
    let mut c = conn(&url).await;

    let before: u64 = c.xlen(TOPIC_INGESTED_TXS).await.unwrap_or(0);

    let source = format!("nomax-test-{}", uuid::Uuid::new_v4().simple());
    let mut writer = RedisStreamWriter::connect(&url, &source, None).await.unwrap();

    let count = 100u64;
    for i in 0..count {
        writer.write_transactions_batch(&[mk_tx(i)]).await.unwrap();
    }

    let after: u64 = c.xlen(TOPIC_INGESTED_TXS).await.unwrap();
    let delta = after.saturating_sub(before);
    // Without trimming, every write lands in the stream.
    assert!(
        delta >= count,
        "expected delta >= {} with maxlen=None, got {} (before={}, after={})",
        count,
        delta,
        before,
        after
    );
}
