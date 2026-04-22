//! Task A: BRPOP `ingest:targeted_queue`, dispatch each payload to
//! `TargetedJob::execute` (which owns the full label-task / ingestion-run
//! lifecycle).

use etl::ingest::targeted::{QueuedTask, TargetedJob};
use etl::pipeline::{ProgressReporter, ShutdownHandle};
use etl::sinks::postgres_writer::PostgresWriter;
use etl::sinks::redis_stream::{RedisStreamWriter, TransactionWriter};
use eyre::Result;
use redis::{aio::ConnectionManager, AsyncCommands};
use sqlx::PgPool;
use tracing::{info, warn};

pub async fn run(
    cfg: std::sync::Arc<etl::config::Config>,
    brpop_timeout_secs: u64,
    pg: PgPool,
    mut redis: ConnectionManager,
    mut shutdown: ShutdownHandle,
) -> Result<()> {
    let pg_writer = PostgresWriter::new(pg.clone());
    let mut writer: Box<dyn TransactionWriter> = Box::new(
        RedisStreamWriter::connect(&cfg.redis_url, "worker", cfg.stream_maxlen).await?,
    );

    info!(queue = %cfg.targeted_queue_key, brpop_timeout_secs, "Task A: targeted queue consumer starting");

    loop {
        if shutdown.is_shutdown() {
            break;
        }

        let payload: Option<(String, String)> = tokio::select! {
            r = redis.brpop(&cfg.targeted_queue_key, brpop_timeout_secs as f64) => match r {
                Ok(v) => v,
                Err(e) => {
                    warn!(error = %e, "BRPOP failed, backing off 1s");
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                        _ = shutdown.wait() => break,
                    }
                    continue;
                }
            },
            _ = shutdown.wait() => break,
        };

        let Some((_key, json)) = payload else { continue };

        let task: QueuedTask = match serde_json::from_str(&json) {
            Ok(t) => t,
            Err(e) => {
                warn!(error = %e, payload = %json, "Skipping malformed queued task");
                continue;
            }
        };

        let mut reporter = match task.run_id.as_deref() {
            Some(rid) => match ProgressReporter::new_redis(&cfg.redis_url, rid).await {
                Ok(r) => r,
                Err(e) => {
                    warn!(run_id = rid, error = %e, "Failed to connect progress reporter, using dry-run");
                    ProgressReporter::new_dry_run(rid)
                }
            },
            None => ProgressReporter::new_dry_run("worker"),
        };

        let mut job = TargetedJob {
            config: &cfg,
            pg: &pg,
            writer: &mut writer,
            reporter: &mut reporter,
            pg_writer: Some(&pg_writer),
            with_traces: true,
            with_transfers: true,
        };
        let _ = job.execute(task).await;
    }

    info!("Task A: targeted queue consumer shutting down");
    Ok(())
}
