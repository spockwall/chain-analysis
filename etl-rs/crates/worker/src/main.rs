//! chain-analysis-worker: single long-running binary that combines
//! (A) targeted-queue consumer, (B) background refresh loop,
//! (C) Redis-Streams → Neo4j+Postgres writer.

mod config;
mod refresh;
mod stream;
mod targeted;

use color_eyre::eyre::Result;
use pipeline::install_shutdown;
use sinks::neo4j::Neo4jWriter;
use std::sync::Arc;
use tracing::{error, info};

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let metrics_port = std::env::var("METRICS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(observability::DEFAULT_METRICS_PORT);
    observability::init_best_effort("worker", metrics_port);

    let cfg = config::WorkerConfig::from_env();

    info!(
        queue = %cfg.ingest.targeted_queue_key,
        refresh_interval_secs = cfg.refresh_interval_secs,
        refresh_cooldown_secs = cfg.refresh_cooldown_secs,
        "Starting chain-analysis-worker"
    );

    // Shared resources
    let ingest_cfg = Arc::new(cfg.ingest);
    let process_cfg = Arc::new(cfg.process);

    let pg = sqlx::PgPool::connect(&process_cfg.postgres_url).await?;

    // One ConnectionManager for A+B (queue), a second one implicit inside
    // StreamConsumer for C. Manager clones cheaply share the socket.
    let redis_client = redis::Client::open(ingest_cfg.redis_url.clone())?;
    let redis_mgr = redis::aio::ConnectionManager::new(redis_client).await?;

    let neo4j = Neo4jWriter::connect(
        &process_cfg.neo4j_uri,
        &process_cfg.neo4j_user,
        &process_cfg.neo4j_password,
        &process_cfg.neo4j_database,
    )
    .await?;

    let shutdown = install_shutdown();

    // Task A: targeted queue consumer
    let a = tokio::spawn(targeted::run(
        ingest_cfg.clone(),
        cfg.brpop_timeout_secs,
        pg.clone(),
        redis_mgr.clone(),
        shutdown.clone(),
    ));

    // Task B: refresh loop
    let b = tokio::spawn(refresh::run(
        ingest_cfg.targeted_queue_key.clone(),
        cfg.refresh_interval_secs,
        cfg.refresh_cooldown_secs,
        pg.clone(),
        redis_mgr.clone(),
        shutdown.clone(),
    ));

    // Task C: stream consumer
    let c = tokio::spawn(stream::run(
        process_cfg.clone(),
        pg.clone(),
        neo4j,
        cfg.stream_batch_size,
        cfg.stream_block_ms,
        shutdown.clone(),
    ));

    // Wait for any task to finish; log which one exited first, then wait
    // for the others to drain.
    tokio::select! {
        r = a => report("targeted", r),
        r = b => report("refresh", r),
        r = c => report("stream", r),
    }

    info!("Worker exiting");
    Ok(())
}

fn report(name: &str, r: Result<Result<()>, tokio::task::JoinError>) {
    match r {
        Ok(Ok(())) => info!(task = name, "task exited cleanly"),
        Ok(Err(e)) => error!(task = name, error = %e, "task returned error"),
        Err(e) => error!(task = name, error = %e, "task panicked or was cancelled"),
    }
}
