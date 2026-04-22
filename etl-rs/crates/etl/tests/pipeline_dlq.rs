//! Integration tests for `pipeline::dlq`. Gated on `E2E_REDIS_URL`.
//!
//! ```sh
//! E2E_REDIS_URL=redis://localhost:6379 cargo test -p pipeline --test dlq
//! ```

use etl::pipeline::{clear_attempt, incr_attempt, move_batch_to_dlq, BatchKey, DlqPolicy};
use redis::AsyncCommands;

fn e2e_redis_url() -> Option<String> {
    std::env::var("E2E_REDIS_URL").ok()
}

async fn conn(url: &str) -> redis::aio::MultiplexedConnection {
    redis::Client::open(url)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap()
}

#[tokio::test]
async fn incr_attempt_increments_and_sets_ttl() {
    let Some(url) = e2e_redis_url() else {
        eprintln!("E2E_REDIS_URL unset — skipping");
        return;
    };
    let mut c = conn(&url).await;
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let key = BatchKey {
        stream: format!("test_stream_{}", tag),
        first_id: "1-0".into(),
        last_id: "5-0".into(),
    };

    let ttl = 60u64;
    assert_eq!(incr_attempt(&mut c, &key, ttl).await.unwrap(), 1);
    assert_eq!(incr_attempt(&mut c, &key, ttl).await.unwrap(), 2);
    assert_eq!(incr_attempt(&mut c, &key, ttl).await.unwrap(), 3);

    let remaining: i64 = redis::cmd("TTL")
        .arg(key.redis_key())
        .query_async(&mut c)
        .await
        .unwrap();
    assert!(
        remaining > 0 && remaining <= ttl as i64,
        "TTL out of range: {}",
        remaining
    );

    clear_attempt(&mut c, &key).await.unwrap();
    let exists: i32 = redis::cmd("EXISTS")
        .arg(key.redis_key())
        .query_async(&mut c)
        .await
        .unwrap();
    assert_eq!(exists, 0, "counter not cleared");
}

#[tokio::test]
async fn move_batch_to_dlq_end_to_end() {
    let Some(url) = e2e_redis_url() else {
        eprintln!("E2E_REDIS_URL unset — skipping");
        return;
    };
    let mut c = conn(&url).await;
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let stream = format!("test_stream_{}", tag);
    let group = format!("grp_{}", tag);
    let dlq = format!("{}_dlq", stream);

    // Seed 3 messages into the stream
    let mut ids = Vec::new();
    for i in 0..3 {
        let id: String = redis::cmd("XADD")
            .arg(&stream)
            .arg("*")
            .arg("data")
            .arg(format!("payload-{}", i))
            .arg("meta")
            .arg(i.to_string())
            .query_async(&mut c)
            .await
            .unwrap();
        ids.push(id);
    }

    // Create group at start and XREADGROUP to move msgs into PEL
    let _: String = redis::cmd("XGROUP")
        .arg("CREATE")
        .arg(&stream)
        .arg(&group)
        .arg("0")
        .arg("MKSTREAM")
        .query_async(&mut c)
        .await
        .unwrap();

    let _: redis::Value = redis::cmd("XREADGROUP")
        .arg("GROUP")
        .arg(&group)
        .arg("consumer-1")
        .arg("COUNT")
        .arg(10)
        .arg("STREAMS")
        .arg(&stream)
        .arg(">")
        .query_async(&mut c)
        .await
        .unwrap();

    // Build msgs vec mirroring what the real consumer would produce
    let msgs: Vec<(String, Vec<(String, String)>)> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            (
                id.clone(),
                vec![
                    ("data".to_string(), format!("payload-{}", i)),
                    ("meta".to_string(), i.to_string()),
                ],
            )
        })
        .collect();

    // Pre-seed counter so we can verify it gets cleared
    let key = BatchKey {
        stream: stream.clone(),
        first_id: ids.first().unwrap().clone(),
        last_id: ids.last().unwrap().clone(),
    };
    incr_attempt(&mut c, &key, 60).await.unwrap();

    let policy = DlqPolicy::default();
    move_batch_to_dlq(&mut c, &stream, &group, &msgs, &policy)
        .await
        .unwrap();

    // DLQ stream has 3 messages
    let dlq_len: u64 = c.xlen(&dlq).await.unwrap();
    assert_eq!(dlq_len, 3);

    // Each DLQ message carries an "original_id" field
    let entries: Vec<(String, Vec<(String, String)>)> = redis::cmd("XRANGE")
        .arg(&dlq)
        .arg("-")
        .arg("+")
        .query_async(&mut c)
        .await
        .unwrap();
    let mut carried_originals = Vec::new();
    for (_id, fields) in &entries {
        let orig = fields
            .iter()
            .find(|(k, _)| k == "original_id")
            .map(|(_, v)| v.clone())
            .expect("original_id field missing");
        carried_originals.push(orig);
    }
    for src_id in &ids {
        assert!(
            carried_originals.contains(src_id),
            "original id {} not found in DLQ",
            src_id
        );
    }

    // PEL empty after XACK — use XLEN semantics: XPENDING summary returns
    // [count, smallest_id, greatest_id, [[consumer, count], ...]]
    let pending: redis::Value = redis::cmd("XPENDING")
        .arg(&stream)
        .arg(&group)
        .query_async(&mut c)
        .await
        .unwrap();
    let pending_count: i64 = match &pending {
        redis::Value::Array(v) => redis::from_redis_value(&v[0]).unwrap(),
        other => panic!("unexpected XPENDING shape: {:?}", other),
    };
    assert_eq!(pending_count, 0, "PEL not drained");

    // Counter deleted
    let exists: i32 = redis::cmd("EXISTS")
        .arg(key.redis_key())
        .query_async(&mut c)
        .await
        .unwrap();
    assert_eq!(exists, 0, "counter not cleared after DLQ move");

    // Cleanup
    let _: i32 = c.del(&stream).await.unwrap();
    let _: i32 = c.del(&dlq).await.unwrap();
}
