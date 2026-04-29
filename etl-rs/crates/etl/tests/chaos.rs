//! Chaos scenarios on top of the testcontainers harness.
//!
//! Each test verifies that worker-side primitives (consumer, sinks, retry
//! counters) behave correctly under a specific failure mode. We deliberately
//! exercise the *library* primitives directly (read_batch, process_read_batch,
//! incr_attempt, move_batch_to_dlq) rather than spawning the worker binary,
//! so failures point at code, not orchestration.
//!
//! Run with: `cargo test --test chaos -- --ignored --test-threads=1`
//! `--test-threads=1` avoids cross-test container contention.

mod common;

use etl::ingest::{ingest_block_range_pipelined, DynBlockSource};
use etl::pipeline::{
    incr_attempt, move_batch_to_dlq, BatchKey, DlqPolicy, ProcessProgressReporter,
    ProgressReporter, RetryPolicy,
};
use etl::sinks::neo4j::Neo4jWriter;
use etl::sinks::postgres_reader::PostgresReader;
use etl::sinks::postgres_writer::PostgresWriter;
use etl::sinks::redis_consumer::StreamConsumer;
use etl::sinks::redis_stream::{RedisStreamWriter, TransactionWriter};
use etl::sources::mock::MockSource;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use testcontainers::TestcontainersError;

/// Push N mock blocks into Redis streams and return the tx count.
async fn ingest_n_blocks(redis_url: &str, start: u64, end: u64) -> u64 {
    let writer: Box<dyn TransactionWriter> = Box::new(
        RedisStreamWriter::connect(redis_url, "mock", None)
            .await
            .expect("redis writer"),
    );
    let reporter = ProgressReporter::new_dry_run("chaos-test");
    let source: DynBlockSource = Arc::new(MockSource);

    let (_w, _r, total) = ingest_block_range_pipelined(
        source,
        start,
        end,
        writer,
        reporter,
        &RetryPolicy::default(),
        false,
        false,
        2,
        end - start + 1,
        0,
    )
    .await
    .expect("ingest pipelined");
    total
}

/// Drain the consumer with a hard deadline. Returns processed count.
async fn drain_with_deadline(
    consumer: &mut StreamConsumer,
    pg: &PostgresReader,
    pg_writer: &PostgresWriter,
    neo4j: &Neo4jWriter,
    reporter: &mut ProcessProgressReporter,
    deadline: Duration,
) -> usize {
    let mut total = 0;
    let mut empty_in_a_row = 0;
    let started = std::time::Instant::now();

    while empty_in_a_row < 2 {
        if started.elapsed() > deadline {
            break;
        }
        let batch = match etl::consumer::read_batch(consumer).await {
            Ok(b) => b,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        let n = batch.txs.len() + batch.traces.len() + batch.transfers.len();
        if n == 0 {
            empty_in_a_row += 1;
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        empty_in_a_row = 0;
        total += n;
        if etl::consumer::process_read_batch(consumer, pg, pg_writer, neo4j, reporter, batch)
            .await
            .is_err()
        {
            // Don't mark messages as processed on failure — the next read
            // will pick them up again (or XPENDING will show them stuck).
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    total
}

// =============================================================================
// Scenario 1: Redis restart mid-pipeline.
// Ingest blocks → restart Redis → drain consumer.
// AOF persistence (configured in common::start_stack) means un-ACKed messages
// survive the restart. The consumer must reconnect transparently.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_redis_restart_preserves_unacked_messages() {
    let stack = common::start_stack().await;

    let pg_pool = PgPool::connect(&stack.pg_url).await.expect("pg pool");
    common::apply_pg_schema(&pg_pool).await;
    let pg_writer = PostgresWriter::new(pg_pool.clone());
    let pg_reader = PostgresReader::new(pg_pool.clone());
    let neo4j = Neo4jWriter::connect(
        &stack.neo4j_uri,
        &stack.neo4j_user,
        &stack.neo4j_password,
        "neo4j",
    )
    .await
    .expect("neo4j");

    // Ingest before restart.
    let total = ingest_n_blocks(&stack.redis_url, 100, 104).await;
    assert!(total > 0);

    // Wait long enough for AOF to flush at least one fsync cycle (default 1s).
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // Restart redis container. ContainerAsync exposes stop()/start() since 0.23.
    stack.redis.stop().await.expect("redis stop");
    stack.redis.start().await.expect("redis start");

    // Wait for redis to come back. We don't know the exact moment so retry.
    let mut attempts = 0u32;
    loop {
        match RedisStreamWriter::connect(&stack.redis_url, "ping", None).await {
            Ok(_) => break,
            Err(_) if attempts < 30 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(e) => panic!("redis never came back: {}", e),
        }
    }

    // Drain. AOF should have replayed the pending messages.
    let mut consumer = StreamConsumer::connect(
        &stack.redis_url,
        "chaos-redis-group",
        "chaos-consumer",
        100,
        500,
    )
    .await
    .expect("consumer");
    consumer.ensure_groups().await.expect("groups");

    let mut reporter = ProcessProgressReporter::new(&stack.redis_url, "chaos-redis")
        .await
        .expect("reporter");

    let processed = drain_with_deadline(
        &mut consumer,
        &pg_reader,
        &pg_writer,
        &neo4j,
        &mut reporter,
        Duration::from_secs(60),
    )
    .await;
    assert!(
        processed >= total as usize,
        "after redis restart, processed={} expected>={}",
        processed,
        total
    );
}

// =============================================================================
// Scenario 2: Postgres connection killed during processing.
// We tag the worker's pool with a unique application_name and use a sidecar
// admin connection to pg_terminate_backend it. sqlx::PgPool should reconnect
// transparently; subsequent batches must succeed.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_pg_connection_kill_recovers() {
    let stack = common::start_stack().await;

    let app_name = "chaos-pg-worker";
    let tagged_url = format!("{}?application_name={}", stack.pg_url, app_name);

    let pg_pool = PgPool::connect(&tagged_url).await.expect("pg pool");
    common::apply_pg_schema(&pg_pool).await;
    let pg_writer = PostgresWriter::new(pg_pool.clone());
    let pg_reader = PostgresReader::new(pg_pool.clone());
    let neo4j = Neo4jWriter::connect(
        &stack.neo4j_uri,
        &stack.neo4j_user,
        &stack.neo4j_password,
        "neo4j",
    )
    .await
    .expect("neo4j");

    // First batch: produce + drain to confirm baseline works.
    let total_a = ingest_n_blocks(&stack.redis_url, 100, 102).await;
    let mut consumer = StreamConsumer::connect(
        &stack.redis_url,
        "chaos-pg-group",
        "chaos-consumer",
        100,
        500,
    )
    .await
    .expect("consumer");
    consumer.ensure_groups().await.expect("groups");
    let mut reporter = ProcessProgressReporter::new(&stack.redis_url, "chaos-pg")
        .await
        .expect("reporter");

    let processed_a = drain_with_deadline(
        &mut consumer,
        &pg_reader,
        &pg_writer,
        &neo4j,
        &mut reporter,
        Duration::from_secs(60),
    )
    .await;
    assert!(processed_a >= total_a as usize);

    // Kill all worker connections via a sidecar admin pool.
    let admin = PgPool::connect(&stack.pg_url).await.expect("admin pool");
    let killed: Vec<(i32,)> = sqlx::query_as(
        "SELECT pg_terminate_backend(pid)::int FROM pg_stat_activity \
         WHERE application_name = $1 AND pid <> pg_backend_pid()",
    )
    .bind(app_name)
    .fetch_all(&admin)
    .await
    .expect("terminate");
    assert!(!killed.is_empty(), "no worker connections to kill");

    // Second batch: pool must reconnect transparently.
    let total_b = ingest_n_blocks(&stack.redis_url, 200, 202).await;
    let processed_b = drain_with_deadline(
        &mut consumer,
        &pg_reader,
        &pg_writer,
        &neo4j,
        &mut reporter,
        Duration::from_secs(60),
    )
    .await;
    assert!(
        processed_b >= total_b as usize,
        "after pg kill: processed={} expected>={}",
        processed_b,
        total_b
    );
}

// =============================================================================
// Scenario 3: Neo4j outage triggers retry; messages stay un-ACKed.
// We invoke pipeline DLQ primitives directly to verify the worker's failure
// path: incr_attempt → move_batch_to_dlq once max_attempts exceeded.
// Restarting Neo4j after the outage lets a fresh batch flow end-to-end.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_neo4j_outage_routes_to_dlq_then_recovers() {
    let stack = common::start_stack().await;

    let pg_pool = PgPool::connect(&stack.pg_url).await.expect("pg pool");
    common::apply_pg_schema(&pg_pool).await;
    let pg_writer = PostgresWriter::new(pg_pool.clone());
    let pg_reader = PostgresReader::new(pg_pool.clone());

    // Ingest first to populate the stream.
    let total = ingest_n_blocks(&stack.redis_url, 100, 102).await;
    assert!(total > 0);

    // Stop Neo4j to simulate outage.
    stack.neo4j.stop().await.expect("neo4j stop");

    // Connecting to a Neo4j that's not running fails — exit early without
    // claiming the test passed silently if the failure mode shifts.
    let neo4j_down = Neo4jWriter::connect(
        &stack.neo4j_uri,
        &stack.neo4j_user,
        &stack.neo4j_password,
        "neo4j",
    )
    .await;
    assert!(neo4j_down.is_err(), "expected neo4j connect to fail while stopped");

    // Read a batch and simulate the worker's DLQ ladder against it directly,
    // since process_read_batch needs a Neo4jWriter.
    let mut consumer = StreamConsumer::connect(
        &stack.redis_url,
        "chaos-neo-group",
        "chaos-consumer",
        100,
        500,
    )
    .await
    .expect("consumer");
    consumer.ensure_groups().await.expect("groups");

    let batch = etl::consumer::read_batch(&mut consumer)
        .await
        .expect("read batch (redis is up)");
    assert!(!batch.raw_by_stream.is_empty(), "expected raw messages");

    let policy = DlqPolicy {
        max_attempts: 3,
        dlq_suffix: "_dlq".to_string(),
        attempt_ttl_secs: 60,
    };

    // Pick the first stream's messages for the DLQ ladder.
    let (stream, msgs) = batch
        .raw_by_stream
        .iter()
        .find(|(_, m)| !m.is_empty())
        .map(|(s, m)| (s.clone(), m.clone()))
        .expect("non-empty stream");
    let key = BatchKey {
        stream: stream.clone(),
        first_id: msgs.first().unwrap().0.clone(),
        last_id: msgs.last().unwrap().0.clone(),
    };

    let conn = consumer.conn_mut();

    // Three "failed" attempts, then DLQ.
    for expected in 1..=policy.max_attempts {
        let n = incr_attempt(conn, &key, policy.attempt_ttl_secs)
            .await
            .expect("incr_attempt");
        assert_eq!(n, expected);
    }
    move_batch_to_dlq(conn, &stream, "chaos-neo-group", &msgs, &policy)
        .await
        .expect("move_batch_to_dlq");

    // The DLQ stream is `{stream}_dlq` and should hold the same number of
    // entries as the original batch.
    let dlq_stream = format!("{}_dlq", stream);
    let entries = etl::dlq::list_dlq(conn, &dlq_stream, None)
        .await
        .expect("list dlq");
    assert_eq!(
        entries.len(),
        msgs.len(),
        "DLQ should contain all quarantined messages"
    );

    // Recover: restart Neo4j, replay the DLQ, drain succeeds.
    stack.neo4j.start().await.expect("neo4j start");

    // Wait until Neo4j is reachable again.
    let neo4j = loop {
        match Neo4jWriter::connect(
            &stack.neo4j_uri,
            &stack.neo4j_user,
            &stack.neo4j_password,
            "neo4j",
        )
        .await
        {
            Ok(w) => break w,
            Err(_) => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    };

    let conn = consumer.conn_mut();
    let replayed = etl::dlq::replay_all(conn, &dlq_stream, &stream, None)
        .await
        .expect("replay all");
    assert_eq!(replayed, msgs.len());

    let mut reporter = ProcessProgressReporter::new(&stack.redis_url, "chaos-neo-recover")
        .await
        .expect("reporter");
    let processed = drain_with_deadline(
        &mut consumer,
        &pg_reader,
        &pg_writer,
        &neo4j,
        &mut reporter,
        Duration::from_secs(60),
    )
    .await;
    assert!(
        processed > 0,
        "after replay + recovery, expected drain to make progress (got {})",
        processed
    );
}

// Quiet the unused-import warning if a chaos case is removed.
#[allow(dead_code)]
fn _force_link(_: TestcontainersError) {}
