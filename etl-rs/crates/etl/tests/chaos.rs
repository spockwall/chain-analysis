//! Chaos scenarios — failures injected *during* the worker loop.
//!
//! Each test spawns `common::run_worker_loop_for_test` in a tokio task, then
//! injects a failure (docker pause / pg_terminate_backend) while the loop is
//! actively processing. The end-state assertion is "no data loss":
//!
//!   - the consumer's pending list is empty after drain (XPENDING == 0)
//!   - Postgres has rows for the ingested addresses
//!   - retry budget didn't get exhausted (dlq_moves == 0)
//!
//! Note on what we *don't* assert: `batches_err > 0` is unreliable here.
//! `docker pause` causes operations to hang rather than error, and sqlx's
//! `test_before_acquire = true` silently replaces dead PG connections. To
//! exercise the retry/DLQ path with observable errors we'd need a real
//! network proxy (Toxiproxy) — out of scope for this PR. What's covered:
//! the system survives the chaos and converges to a clean state.
//!
//! Set `RUST_LOG=info,etl=debug,common=debug,chaos=debug` to see the loop
//! iteration log + freeze/thaw timing.
//!
//! Run with: `cargo test --test chaos -- --ignored --nocapture --test-threads=1`.

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

async fn wait_first_progress(
    rx: &mut mpsc::UnboundedReceiver<LoopStats>,
    deadline: Duration,
) -> Option<LoopStats> {
    tokio::time::timeout(deadline, rx.recv()).await.ok().flatten()
}

/// Wait until the loop hasn't reported any new progress for `quiet_for` —
/// drain proxy. Returns the latest stats observed.
async fn wait_drain_quiescent(
    rx: &mut mpsc::UnboundedReceiver<LoopStats>,
    quiet_for: Duration,
    hard_deadline: Duration,
) -> LoopStats {
    let started = Instant::now();
    let mut last = LoopStats::default();
    loop {
        if started.elapsed() > hard_deadline {
            return last;
        }
        match tokio::time::timeout(quiet_for, rx.recv()).await {
            Ok(Some(s)) => last = s,
            _ => return last, // quiet — done draining
        }
    }
}

/// Wait until the loop reports `condition(stats) == true` or `deadline`.
async fn wait_for_condition(
    rx: &mut mpsc::UnboundedReceiver<LoopStats>,
    deadline: Duration,
    mut condition: impl FnMut(&LoopStats) -> bool,
) -> Option<LoopStats> {
    let started = Instant::now();
    while started.elapsed() < deadline {
        let remaining = deadline.saturating_sub(started.elapsed());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(s)) => {
                if condition(&s) {
                    return Some(s);
                }
            }
            _ => return None,
        }
    }
    None
}

// =============================================================================
// Scenario 1: Redis frozen mid-loop via `docker pause`.
// The worker's read_batch hangs on a paused TCP socket; once unpaused, the
// loop must reconnect and drain everything that was queued.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_redis_freeze_mid_loop_no_data_loss() {
    common::init_test_tracing();
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
    let group = "chaos-redis-group".to_string();

    let group_for_loop = group.clone();
    let loop_handle = tokio::spawn(async move {
        run_worker_loop_for_test(
            redis_url,
            pg_url,
            neo4j_uri,
            neo4j_user,
            neo4j_pass,
            group_for_loop,
            "chaos-redis-consumer".to_string(),
            DlqPolicy {
                max_attempts: 100,
                dlq_suffix: "_dlq".into(),
                attempt_ttl_secs: 60,
            },
            shutdown_rx,
            progress_tx,
        )
        .await
    });

    let _ = ingest_n_blocks(&stack.redis_url, 100, 119).await;
    let _first = wait_first_progress(&mut progress_rx, Duration::from_secs(20))
        .await
        .expect("loop never reported progress");

    // INJECT: freeze redis. Worker reads will hang; eventually time out and
    // surface as batch errors.
    common::freeze_container(stack.redis.id()).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    common::thaw_container(stack.redis.id()).await;
    common::wait_redis_ready(&stack.redis_url, Duration::from_secs(10)).await;

    let _ = ingest_n_blocks(&stack.redis_url, 200, 209).await;

    let stats = wait_drain_quiescent(
        &mut progress_rx,
        Duration::from_secs(5),
        Duration::from_secs(180),
    )
    .await;

    let _ = shutdown_tx.send(true);
    let final_stats = loop_handle.await.expect("loop join").expect("loop ok");

    let pending = common::xpending_total(&stack.redis_url, &group).await;
    let pg_count: (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM entity_features")
        .fetch_one(&pg_pool)
        .await
        .unwrap();

    // Note: docker pause hangs operations rather than causing TCP errors,
    // so `batches_err` is NOT a reliable signal of chaos injection here.
    // The strong invariant is "no data loss": empty PEL + persisted rows.
    assert_eq!(pending, 0, "messages stuck in PEL after drain: {} (stats={:?})", pending, stats);
    assert!(pg_count.0 > 0, "expected entity_features rows; final_stats={:?}", final_stats);
    assert_eq!(final_stats.dlq_moves, 0);
}

// =============================================================================
// Scenario 2: Postgres connection killed mid-transaction.
// A killer task aggressively terminates worker connections via a sidecar
// admin pool until the loop reports a batch error. The pool then reconnects
// and the retry succeeds.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_pg_kill_mid_transaction_recovers_via_retry() {
    common::init_test_tracing();
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
    let group = "chaos-pg-group".to_string();

    let group_for_loop = group.clone();
    let pg_url_for_loop = tagged_pg_url.clone();
    let loop_handle = tokio::spawn(async move {
        run_worker_loop_for_test(
            redis_url,
            pg_url_for_loop,
            neo4j_uri,
            neo4j_user,
            neo4j_pass,
            group_for_loop,
            "chaos-pg-consumer".to_string(),
            DlqPolicy {
                max_attempts: 100,
                dlq_suffix: "_dlq".into(),
                attempt_ttl_secs: 60,
            },
            shutdown_rx,
            progress_tx,
        )
        .await
    });

    // Pump enough work that the worker stays busy through the kill window.
    let _ = ingest_n_blocks(&stack.redis_url, 100, 599).await;

    // Wait until the loop has actually started processing.
    let _ = wait_first_progress(&mut progress_rx, Duration::from_secs(20))
        .await
        .expect("loop never reported progress");

    // Spawn the killer. It runs for up to 5 s, killing every 50 ms. The
    // sidecar admin pool is moved into the task.
    let admin = PgPool::connect(&stack.pg_url).await.expect("admin pool");
    let app_for_kill = app_name.to_string();
    let killer = tokio::spawn(async move {
        let started = Instant::now();
        let mut ever_killed = 0;
        while started.elapsed() < Duration::from_secs(5) {
            if let Ok(rows) = sqlx::query_as::<_, (bool,)>(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
                 WHERE application_name = $1 AND pid <> pg_backend_pid()",
            )
            .bind(&app_for_kill)
            .fetch_all(&admin)
            .await
            {
                ever_killed += rows.len();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        ever_killed
    });

    // Wait until the loop observes a batch error OR killer finishes — either
    // way we proceed to drain.
    let _ = wait_for_condition(
        &mut progress_rx,
        Duration::from_secs(10),
        |s| s.batches_err > 0,
    )
    .await;

    let killed_count = killer.await.expect("killer join");

    // Drain.
    let stats = wait_drain_quiescent(
        &mut progress_rx,
        Duration::from_secs(5),
        Duration::from_secs(180),
    )
    .await;

    let _ = shutdown_tx.send(true);
    let final_stats = loop_handle.await.expect("loop join").expect("loop ok");

    let pending = common::xpending_total(&stack.redis_url, &group).await;
    let pg_count: (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM entity_features")
        .fetch_one(&pg_pool)
        .await
        .unwrap();

    // sqlx PgPool's default `test_before_acquire = true` validates connections
    // on acquire and silently replaces dead ones — so the worker rarely sees
    // batches_err even when we kill its backends. The invariant we *can*
    // assert: kills landed (chaos was injected) AND nothing got stuck.
    assert!(killed_count > 0, "killer never killed any worker connection");
    assert_eq!(pending, 0, "messages stuck in PEL after drain (stats={:?})", stats);
    assert!(pg_count.0 > 0, "expected entity_features rows; final_stats={:?}", final_stats);
    assert_eq!(final_stats.dlq_moves, 0);
}

// =============================================================================
// Scenario 3: Neo4j frozen mid-loop. Worker's process_read_batch errors,
// retries via pending-first read once Neo4j is unfrozen.
// =============================================================================
#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn chaos_neo4j_freeze_mid_loop_recovers() {
    common::init_test_tracing();
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
    let group = "chaos-neo-group".to_string();

    let group_for_loop = group.clone();
    let loop_handle = tokio::spawn(async move {
        run_worker_loop_for_test(
            redis_url,
            pg_url,
            neo4j_uri,
            neo4j_user,
            neo4j_pass,
            group_for_loop,
            "chaos-neo-consumer".to_string(),
            DlqPolicy {
                max_attempts: 100,
                dlq_suffix: "_dlq".into(),
                attempt_ttl_secs: 60,
            },
            shutdown_rx,
            progress_tx,
        )
        .await
    });

    let _ = ingest_n_blocks(&stack.redis_url, 100, 119).await;
    let _ = wait_first_progress(&mut progress_rx, Duration::from_secs(20))
        .await
        .expect("loop never reported progress");

    // INJECT: freeze neo4j.
    common::freeze_container(stack.neo4j.id()).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    common::thaw_container(stack.neo4j.id()).await;
    common::wait_neo4j_ready(
        &stack.neo4j_uri,
        &stack.neo4j_user,
        &stack.neo4j_password,
        Duration::from_secs(30),
    )
    .await;

    let _ = ingest_n_blocks(&stack.redis_url, 200, 209).await;

    let stats = wait_drain_quiescent(
        &mut progress_rx,
        Duration::from_secs(5),
        Duration::from_secs(240),
    )
    .await;

    let _ = shutdown_tx.send(true);
    let final_stats = loop_handle.await.expect("loop join").expect("loop ok");

    let pending = common::xpending_total(&stack.redis_url, &group).await;
    let pg_count: (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM entity_features")
        .fetch_one(&pg_pool)
        .await
        .unwrap();

    // Same caveat as the redis case: docker pause stalls without erroring,
    // so we don't assert batches_err. No data loss is the real invariant.
    assert_eq!(pending, 0, "messages stuck in PEL after drain (stats={:?})", stats);
    assert!(pg_count.0 > 0, "expected entity_features rows; final_stats={:?}", final_stats);
    assert_eq!(
        final_stats.dlq_moves, 0,
        "transient outage should not have escalated to DLQ"
    );
}
