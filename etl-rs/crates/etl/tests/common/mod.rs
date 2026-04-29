//! Shared testcontainers harness for end-to-end and chaos tests.
//!
//! Each test file that wants the harness should `mod common;` and call
//! `common::start_stack().await`. Tests are gated `#[ignore]` because the
//! containers take ~30-60s to spin up and require Docker.

#![allow(dead_code)]

use etl::pipeline::{
    incr_attempt, move_batch_to_dlq, BatchKey, DlqPolicy, ProcessProgressReporter,
};
use etl::sinks::neo4j::Neo4jWriter;
use etl::sinks::postgres_reader::PostgresReader;
use etl::sinks::postgres_writer::PostgresWriter;
use etl::sinks::redis_consumer::StreamConsumer;
use sqlx::PgPool;
use std::sync::Once;
use std::time::Duration;
use testcontainers::core::{ContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};
use testcontainers_modules::postgres::Postgres as PgImage;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

static TRACING_INIT: Once = Once::new();

/// Idempotent tracing subscriber for tests. Call from each `#[tokio::test]`.
/// Honors `RUST_LOG` (default: `info,etl=debug,common=debug,chaos=debug`).
pub fn init_test_tracing() {
    TRACING_INIT.call_once(|| {
        let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            tracing_subscriber::EnvFilter::new("info,etl=debug,common=debug,chaos=debug")
        });
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_test_writer()
            .try_init();
    });
}

/// Minimal Postgres schema covering the columns the worker stream consumer
/// reads/writes. Hand-written rather than running Alembic — schema drift
/// will surface here as a test failure, which is the whole point.
pub const PG_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS known_labels (
    address      text PRIMARY KEY,
    name         text,
    entity_type  text NOT NULL DEFAULT 'eoa',
    risk_level   text NOT NULL DEFAULT 'unknown',
    source       text NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS entity_features (
    address                    text NOT NULL,
    chain_id                   int  NOT NULL DEFAULT 1,
    out_degree                 int  NOT NULL DEFAULT 0,
    in_degree                  int  NOT NULL DEFAULT 0,
    unique_interacted_entities int  NOT NULL DEFAULT 0,
    volume_in_wei              numeric(78,0) NOT NULL DEFAULT 0,
    volume_out_wei             numeric(78,0) NOT NULL DEFAULT 0,
    is_labeled                 boolean NOT NULL DEFAULT false,
    first_seen_at              timestamptz,
    last_seen_at               timestamptz,
    last_synced_block          bigint,
    computed_at                timestamptz NOT NULL DEFAULT NOW(),
    updated_at                 timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (address)
);
"#;

pub struct Stack {
    pub redis: ContainerAsync<GenericImage>,
    pub pg: ContainerAsync<PgImage>,
    pub neo4j: ContainerAsync<GenericImage>,
    pub redis_url: String,
    pub pg_url: String,
    pub neo4j_uri: String,
    pub neo4j_user: String,
    pub neo4j_password: String,
}

pub async fn start_stack() -> Stack {
    // Redis: GenericImage (not the testcontainers-modules wrapper) so we can
    // enable AOF persistence — needed for chaos tests that restart Redis and
    // expect un-ACKed messages to survive.
    let redis = GenericImage::new("redis", "7-alpine")
        .with_exposed_port(ContainerPort::Tcp(6379))
        .with_wait_for(WaitFor::message_on_stdout("Ready to accept connections"))
        .with_cmd(["redis-server", "--appendonly", "yes"])
        .start()
        .await
        .expect("redis start");
    let redis_port = redis.get_host_port_ipv4(6379).await.expect("redis port");
    let redis_url = format!("redis://127.0.0.1:{}", redis_port);

    // Pin to the major version production runs (compose/infra.yml ships 17).
    let pg = PgImage::default()
        .with_tag("17-alpine")
        .start()
        .await
        .expect("postgres start");
    let pg_port = pg.get_host_port_ipv4(5432).await.expect("pg port");
    let pg_url = format!("postgres://postgres:postgres@127.0.0.1:{}/postgres", pg_port);

    let neo4j = GenericImage::new("neo4j", "5.26.0")
        .with_exposed_port(ContainerPort::Tcp(7687))
        .with_exposed_port(ContainerPort::Tcp(7474))
        .with_wait_for(WaitFor::message_on_stdout("Started."))
        .with_env_var("NEO4J_AUTH", "neo4j/password123")
        .with_env_var("NEO4J_dbms_memory_pagecache_size", "256m")
        .with_env_var("NEO4J_dbms_memory_heap_max__size", "512m")
        .start()
        .await
        .expect("neo4j start");
    let bolt = neo4j.get_host_port_ipv4(7687).await.expect("bolt port");
    let neo4j_uri = format!("bolt://127.0.0.1:{}", bolt);

    let stack = Stack {
        redis,
        pg,
        neo4j,
        redis_url,
        pg_url,
        neo4j_uri,
        neo4j_user: "neo4j".to_string(),
        neo4j_password: "password123".to_string(),
    };

    // Belt-and-suspenders: real handshake, not just a stdout match.
    wait_redis_ready(&stack.redis_url, Duration::from_secs(15)).await;
    wait_neo4j_ready(
        &stack.neo4j_uri,
        &stack.neo4j_user,
        &stack.neo4j_password,
        Duration::from_secs(45),
    )
    .await;

    stack
}

pub async fn apply_pg_schema(pool: &PgPool) {
    sqlx::raw_sql(PG_SCHEMA)
        .execute(pool)
        .await
        .expect("apply PG schema");
}

/// `WaitFor::message_on_stdout` only proves the line was logged, not that the
/// listener is bound. Race windows show up as `Connection refused` on the
/// first connect after a fresh start (or restart). Retry until a real PING
/// succeeds or `deadline` elapses.
pub async fn wait_redis_ready(redis_url: &str, deadline: Duration) {
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > deadline {
            panic!("redis never became ready at {}", redis_url);
        }
        if let Ok(client) = redis::Client::open(redis_url) {
            if let Ok(mut conn) = client.get_multiplexed_async_connection().await {
                let pong: redis::RedisResult<String> =
                    redis::cmd("PING").query_async(&mut conn).await;
                if pong.is_ok() {
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

pub async fn wait_neo4j_ready(uri: &str, user: &str, password: &str, deadline: Duration) {
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > deadline {
            panic!("neo4j never became ready at {}", uri);
        }
        if Neo4jWriter::connect(uri, user, password, "neo4j")
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// `docker pause` freezes the container's processes via cgroup freezer.
/// Unlike `stop()`, the container stays alive and the host port mapping
/// is preserved — so reconnect URLs remain valid. This is what real chaos
/// engineering tools (Toxiproxy, etc.) use to inject brief outages.
pub async fn freeze_container(container_id: &str) {
    info!(container_id, "chaos: docker pause");
    let out = tokio::process::Command::new("docker")
        .args(["pause", container_id])
        .output()
        .await
        .expect("docker pause spawn");
    assert!(
        out.status.success(),
        "docker pause failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

pub async fn thaw_container(container_id: &str) {
    info!(container_id, "chaos: docker unpause");
    let out = tokio::process::Command::new("docker")
        .args(["unpause", container_id])
        .output()
        .await
        .expect("docker unpause spawn");
    assert!(
        out.status.success(),
        "docker unpause failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Returns the number of messages currently in this consumer's pending
/// list across all three ingest streams. After a clean drain this should
/// be zero — non-zero means messages got stuck.
pub async fn xpending_total(
    redis_url: &str,
    group: &str,
) -> u64 {
    let client = redis::Client::open(redis_url).expect("redis client");
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("redis conn");
    let mut total = 0u64;
    for stream in ["ingested_txs", "ingested_traces", "ingested_transfers"] {
        // XPENDING <stream> <group> returns [count, min_id, max_id, consumers]
        // when there are no consumers it returns [0, nil, nil, nil].
        let res: redis::Value = redis::cmd("XPENDING")
            .arg(stream)
            .arg(group)
            .query_async(&mut conn)
            .await
            .unwrap_or(redis::Value::Nil);
        if let redis::Value::Array(items) = res {
            if let Some(redis::Value::Int(n)) = items.first() {
                total += *n as u64;
            }
        }
    }
    total
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LoopStats {
    pub batches_ok: usize,
    pub batches_err: usize,
    pub messages_ok: usize,
    pub dlq_moves: usize,
}

/// Mirrors `bin/worker/src/stream.rs::run` but with shorter backoff and
/// observability hooks suitable for chaos tests.
///
/// - `progress_tx`: receives one `LoopStats` after every loop iteration that
///   actually attempted work. Tests can `recv().await` to wait for the first
///   real batch before injecting chaos.
/// - `shutdown_rx`: when set to `true`, the loop drains in-flight work and
///   returns. Tests use this to terminate cleanly.
/// - `redis_url`/`pg_url`/`neo4j_*`: reconstructed inside the loop so a
///   container restart reconnects rather than holding a stale handle.
pub async fn run_worker_loop_for_test(
    redis_url: String,
    pg_url: String,
    neo4j_uri: String,
    neo4j_user: String,
    neo4j_password: String,
    consumer_group: String,
    consumer_name: String,
    dlq_policy: DlqPolicy,
    mut shutdown_rx: watch::Receiver<bool>,
    progress_tx: mpsc::UnboundedSender<LoopStats>,
) -> eyre::Result<LoopStats> {
    info!(group = %consumer_group, consumer = %consumer_name, "loop: starting");
    let mut consumer =
        StreamConsumer::connect(&redis_url, &consumer_group, &consumer_name, 100, 200).await?;
    consumer.ensure_groups().await?;

    let pg_pool = PgPool::connect(&pg_url).await?;
    let pg_reader = PostgresReader::new(pg_pool.clone());
    let pg_writer = PostgresWriter::new(pg_pool);

    let mut reporter = ProcessProgressReporter::new(&redis_url, "test-worker").await?;

    let mut neo4j_opt =
        Neo4jWriter::connect(&neo4j_uri, &neo4j_user, &neo4j_password, "neo4j")
            .await
            .ok();
    if neo4j_opt.is_none() {
        warn!("loop: initial Neo4j connect failed, will retry lazily");
    }

    let mut stats = LoopStats::default();
    let mut iter = 0u64;

    loop {
        iter += 1;
        if *shutdown_rx.borrow() {
            break;
        }

        // Lazy Neo4j reconnect — covers chaos case where Neo4j was down at
        // startup or got bounced.
        if neo4j_opt.is_none() {
            match Neo4jWriter::connect(&neo4j_uri, &neo4j_user, &neo4j_password, "neo4j").await
            {
                Ok(w) => neo4j_opt = Some(w),
                Err(_) => {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(200)) => {}
                        _ = shutdown_rx.changed() => break,
                    }
                    continue;
                }
            }
        }
        let neo4j = neo4j_opt.as_ref().unwrap();

        let read_started = std::time::Instant::now();
        let batch = tokio::select! {
            r = etl::consumer::read_batch(&mut consumer) => match r {
                Ok(b) => b,
                Err(e) => {
                    stats.batches_err += 1;
                    warn!(iter, error = %e, elapsed_ms = read_started.elapsed().as_millis() as u64, "loop: read_batch failed; reconnecting consumer");
                    let _ = progress_tx.send(stats);
                    consumer = match StreamConsumer::connect(
                        &redis_url, &consumer_group, &consumer_name, 100, 200,
                    )
                    .await
                    {
                        Ok(c) => c,
                        Err(e2) => {
                            warn!(iter, error = %e2, "loop: consumer reconnect failed");
                            tokio::select! {
                                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
                                _ = shutdown_rx.changed() => break,
                            }
                            continue;
                        }
                    };
                    let _ = consumer.ensure_groups().await;
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(200)) => {}
                        _ = shutdown_rx.changed() => break,
                    }
                    continue;
                }
            },
            _ = shutdown_rx.changed() => break,
        };

        if batch.txs.is_empty() && batch.traces.is_empty() && batch.transfers.is_empty() {
            // Nothing to do — keep looping but don't spam progress_tx.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                _ = shutdown_rx.changed() => break,
            }
            continue;
        }

        let raw_snapshot = batch.raw_by_stream.clone();
        let msg_total = batch.txs.len() + batch.traces.len() + batch.transfers.len();
        debug!(
            iter,
            txs = batch.txs.len(),
            traces = batch.traces.len(),
            transfers = batch.transfers.len(),
            read_ms = read_started.elapsed().as_millis() as u64,
            "loop: read batch"
        );

        let process_started = std::time::Instant::now();
        let result = etl::consumer::process_read_batch(
            &mut consumer,
            &pg_reader,
            &pg_writer,
            neo4j,
            &mut reporter,
            batch,
        )
        .await;

        match result {
            Ok(_) => {
                stats.batches_ok += 1;
                stats.messages_ok += msg_total;
                debug!(
                    iter,
                    msg_total,
                    process_ms = process_started.elapsed().as_millis() as u64,
                    total_messages_ok = stats.messages_ok,
                    "loop: batch ok"
                );
            }
            Err(e) => {
                stats.batches_err += 1;
                warn!(
                    iter,
                    error = %e,
                    process_ms = process_started.elapsed().as_millis() as u64,
                    "loop: process_read_batch failed"
                );
                // Drop the live Neo4j handle so next iteration reconnects.
                neo4j_opt = None;

                let group = consumer.group().to_string();
                let conn = consumer.conn_mut();
                for (stream, msgs) in &raw_snapshot {
                    if msgs.is_empty() {
                        continue;
                    }
                    let key = BatchKey {
                        stream: stream.clone(),
                        first_id: msgs.first().unwrap().0.clone(),
                        last_id: msgs.last().unwrap().0.clone(),
                    };
                    let attempts =
                        match incr_attempt(conn, &key, dlq_policy.attempt_ttl_secs).await {
                            Ok(n) => n,
                            Err(_) => continue,
                        };
                    debug!(stream, attempts, "loop: incr_attempt");
                    if attempts >= dlq_policy.max_attempts {
                        if move_batch_to_dlq(conn, stream, &group, msgs, &dlq_policy)
                            .await
                            .is_ok()
                        {
                            stats.dlq_moves += 1;
                            warn!(stream, count = msgs.len(), "loop: moved batch to DLQ");
                        }
                    }
                }

                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(200)) => {}
                    _ = shutdown_rx.changed() => break,
                }
            }
        }

        let _ = progress_tx.send(stats);
    }
    info!(?stats, "loop: shutdown");

    Ok(stats)
}
