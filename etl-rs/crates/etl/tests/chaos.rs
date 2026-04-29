//! Chaos scenarios — failures injected *during* worker loop processing.
//!
//! Each test follows the same shape:
//!   1. Start the testcontainers stack.
//!   2. Spawn `common::run_worker_loop_for_test` in a tokio task.
//!   3. Pump blocks via `ingest_block_range_pipelined`.
//!   4. Wait for the worker to make first progress (channel signal).
//!   5. Inject the failure (redis stop, pg_terminate_backend, neo4j stop).
//!   6. (Some scenarios) restore the dependency.
//!   7. Wait for the worker to drain to a quiescent state.
//!   8. Signal shutdown, await the loop task.
//!   9. Assert end-state: data made it through (or DLQ behaved correctly).
//!
//! Run with: `cargo test --test chaos -- --ignored --test-threads=1`.

mod common;

use common::{run_worker_loop_for_test, LoopStats};
use etl::ingest::{ingest_block_range_pipelined, DynBlockSource};
use etl::pipeline::{DlqPolicy, ProgressReporter, RetryPolicy};
use etl::sinks::redis_stream::{RedisStreamWriter, TransactionWriter};
use etl::sources::mock::MockSource;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};

async fn ingest_n_blocks(redis_url: &str, start: u64, end: u64) -> u64 {
    let writer: Box<dyn TransactionWriter> = Box::new(
        RedisStreamWriter::connect(redis_url, "mock", None)
            .await
            .expect("redis writer"),
    );
    let reporter = ProgressReporter::new_dry_run("chaos");
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
    .expect("ingest");
    total
}

/// Block until the loop reports its first observed batch (success OR error)
/// or `deadline` elapses.
async fn wait_first_progress(
    rx: &mut mpsc::UnboundedReceiver<LoopStats>,
    deadline: Duration,
) -> Option<LoopStats> {
    tokio::time::timeout(deadline, rx.recv()).await.ok().flatten()
}

/// Wait until the loop has processed at least `target` messages OR `deadline`
/// elapses. Returns the last stats observed.
async fn wait_messages_ok(
    rx: &mut mpsc::UnboundedReceiver<LoopStats>,
    target: usize,
    deadline: Duration,
) -> LoopStats {
    let started = Instant::now();
    let mut last = LoopStats::default();
    while started.elapsed() < deadline {
        let remaining = deadline.saturating_sub(started.elapsed());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(s)) => {
                last = s;
                if s.messages_ok >= target {
                    return s;
                }
            }
            _ => break,
        }
    }
    last
}

// =============================================================================
// Scenario 1: Redis restart while the worker is processing.
// AOF persistence (configured in common::start_stack) means un-ACKed messages
// survive. The worker loop must reconnect StreamConsumer and finish the drain.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_redis_restart_mid_loop_no_data_loss() {
    let stack = common::start_stack().await;

    let pg_pool = PgPool::connect(&stack.pg_url).await.expect("pg pool");
    common::apply_pg_schema(&pg_pool).await;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();

    let redis_url = stack.redis_url.clone();
    let pg_url = stack.pg_url.clone();
    let neo4j_uri = stack.neo4j_uri.clone();
    let neo4j_user = stack.neo4j_user.clone();
    let neo4j_pass = stack.neo4j_password.clone();

    let loop_handle = tokio::spawn(async move {
        run_worker_loop_for_test(
            redis_url,
            pg_url,
            neo4j_uri,
            neo4j_user,
            neo4j_pass,
            "chaos-redis-group".to_string(),
            "chaos-redis-consumer".to_string(),
            DlqPolicy::default(),
            shutdown_rx,
            progress_tx,
        )
        .await
    });

    // Pump blocks. 10 blocks × 3 mock txs = ~30 messages.
    let total = ingest_n_blocks(&stack.redis_url, 100, 109).await;
    assert!(total > 0);

    // Wait for the loop to get into processing (any batch attempt).
    let _first = wait_first_progress(&mut progress_rx, Duration::from_secs(15))
        .await
        .expect("loop never reported progress");

    // Give AOF time to fsync at least once (default 1s).
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // INJECT: restart Redis while the loop may be mid-batch.
    stack.redis.stop().await.expect("redis stop");
    stack.redis.start().await.expect("redis start");

    // Pump more blocks after restart so the loop has a clear post-failure
    // workload to drain.
    let total_post = ingest_n_blocks(&stack.redis_url, 200, 204).await;

    // Wait until the loop has processed at least the post-restart batch.
    let stats =
        wait_messages_ok(&mut progress_rx, total_post as usize, Duration::from_secs(60)).await;

    let _ = shutdown_tx.send(true);
    let final_stats = loop_handle.await.expect("loop join").expect("loop ok");

    assert!(
        final_stats.messages_ok >= total_post as usize,
        "post-restart messages_ok={} expected>={}; mid-stats={:?}",
        final_stats.messages_ok,
        total_post,
        stats
    );
    assert!(
        final_stats.batches_err > 0,
        "expected at least one batch_err during the restart window"
    );

    // PG entity_features must have rows from the ingested data.
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM entity_features")
        .fetch_one(&pg_pool)
        .await
        .unwrap();
    assert!(count.0 > 0);
}

// =============================================================================
// Scenario 2: Postgres terminates the worker's connection during a write.
// The worker pool (sqlx) must reconnect; the failed batch must retry until
// success without ending up in DLQ.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_pg_kill_mid_transaction_recovers_via_retry() {
    let stack = common::start_stack().await;

    let app_name = "chaos-pg-worker";
    let tagged_pg_url = format!("{}?application_name={}", stack.pg_url, app_name);

    let pg_pool = PgPool::connect(&stack.pg_url).await.expect("pg pool");
    common::apply_pg_schema(&pg_pool).await;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();

    let redis_url = stack.redis_url.clone();
    let neo4j_uri = stack.neo4j_uri.clone();
    let neo4j_user = stack.neo4j_user.clone();
    let neo4j_pass = stack.neo4j_password.clone();
    let pg_url_for_loop = tagged_pg_url.clone();

    let loop_handle = tokio::spawn(async move {
        run_worker_loop_for_test(
            redis_url,
            pg_url_for_loop,
            neo4j_uri,
            neo4j_user,
            neo4j_pass,
            "chaos-pg-group".to_string(),
            "chaos-pg-consumer".to_string(),
            // Generous max_attempts so transient kills don't DLQ.
            DlqPolicy {
                max_attempts: 10,
                dlq_suffix: "_dlq".into(),
                attempt_ttl_secs: 60,
            },
            shutdown_rx,
            progress_tx,
        )
        .await
    });

    // Pump 10 blocks (~30 messages).
    let total = ingest_n_blocks(&stack.redis_url, 100, 109).await;

    // Wait for the loop to have processed something so we know the pool has
    // a live connection to terminate.
    let mut got_messages = false;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if let Some(s) = wait_first_progress(&mut progress_rx, Duration::from_secs(5)).await {
            if s.messages_ok > 0 {
                got_messages = true;
                break;
            }
        }
    }
    assert!(got_messages, "loop never processed before kill window");

    // INJECT: kill all worker connections via sidecar admin pool.
    let admin = PgPool::connect(&stack.pg_url).await.expect("admin pool");
    let killed: Vec<(bool,)> = sqlx::query_as(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
         WHERE application_name = $1 AND pid <> pg_backend_pid()",
    )
    .bind(app_name)
    .fetch_all(&admin)
    .await
    .expect("kill");
    assert!(!killed.is_empty(), "no worker connections to kill");

    // Pump more so the loop has fresh work after the kill.
    let total_post = ingest_n_blocks(&stack.redis_url, 200, 209).await;

    let _ =
        wait_messages_ok(&mut progress_rx, (total + total_post) as usize, Duration::from_secs(90))
            .await;

    let _ = shutdown_tx.send(true);
    let final_stats = loop_handle.await.expect("loop join").expect("loop ok");

    assert!(
        final_stats.messages_ok >= (total + total_post) as usize,
        "post-kill messages_ok={} expected>={}",
        final_stats.messages_ok,
        total + total_post
    );
    assert!(
        final_stats.batches_err > 0,
        "expected the kill to fail at least one batch"
    );
    assert_eq!(
        final_stats.dlq_moves, 0,
        "transient kill should not have escalated to DLQ"
    );
}

// =============================================================================
// Scenario 3: Neo4j returns transient errors (we simulate by stopping the
// container briefly). The worker's retry counter increments; once Neo4j is
// back, retries succeed without DLQ.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_neo4j_transient_outage_retries_succeed() {
    let stack = common::start_stack().await;

    let pg_pool = PgPool::connect(&stack.pg_url).await.expect("pg pool");
    common::apply_pg_schema(&pg_pool).await;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();

    let redis_url = stack.redis_url.clone();
    let pg_url = stack.pg_url.clone();
    let neo4j_uri = stack.neo4j_uri.clone();
    let neo4j_user = stack.neo4j_user.clone();
    let neo4j_pass = stack.neo4j_password.clone();

    let loop_handle = tokio::spawn(async move {
        run_worker_loop_for_test(
            redis_url,
            pg_url,
            neo4j_uri,
            neo4j_user,
            neo4j_pass,
            "chaos-neo-group".to_string(),
            "chaos-neo-consumer".to_string(),
            // Set max_attempts high so a brief outage stays within the
            // retry budget — this scenario asserts retry recovers.
            DlqPolicy {
                max_attempts: 50,
                dlq_suffix: "_dlq".into(),
                attempt_ttl_secs: 60,
            },
            shutdown_rx,
            progress_tx,
        )
        .await
    });

    let total = ingest_n_blocks(&stack.redis_url, 100, 109).await;

    // Wait for the loop to have processed at least one batch so we know
    // we're truly mid-stream when Neo4j drops.
    let _ = wait_first_progress(&mut progress_rx, Duration::from_secs(20)).await;

    // INJECT: brief Neo4j outage.
    stack.neo4j.stop().await.expect("neo4j stop");
    tokio::time::sleep(Duration::from_secs(2)).await;
    stack.neo4j.start().await.expect("neo4j start");

    let total_post = ingest_n_blocks(&stack.redis_url, 200, 204).await;

    let _ = wait_messages_ok(
        &mut progress_rx,
        (total + total_post) as usize,
        Duration::from_secs(120),
    )
    .await;

    let _ = shutdown_tx.send(true);
    let final_stats = loop_handle.await.expect("loop join").expect("loop ok");

    assert!(
        final_stats.messages_ok >= (total + total_post) as usize,
        "after Neo4j recovery messages_ok={} expected>={}",
        final_stats.messages_ok,
        total + total_post
    );
    assert!(
        final_stats.batches_err > 0,
        "expected at least one batch error while Neo4j was down"
    );
    assert_eq!(
        final_stats.dlq_moves, 0,
        "transient Neo4j outage within retry budget should not DLQ"
    );
}
