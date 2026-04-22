//! Task A: BRPOP `ingest:targeted_queue`, run `ingest::run_targeted`, flip
//! Postgres row status before and after the fetch so the frontend pill
//! advances within one poll tick.

use eyre::Result;
use ingest::modes::targeted::{classify_error, run_targeted, QueuedTask};
use pipeline::{ProgressReporter, ShutdownHandle};
use redis::{aio::ConnectionManager, AsyncCommands};
use sinks::postgres_writer::PostgresWriter;
use sinks::redis_stream::{RedisStreamWriter, TransactionWriter};
use sqlx::PgPool;
use tracing::{info, warn};

pub async fn run(
    cfg: std::sync::Arc<config::Config>,
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

        let QueuedTask { task_id, run_id, spec } = task;
        info!(?task_id, ?run_id, "Picked up targeted entry");

        mark_pickup(&pg, task_id, run_id.as_deref()).await;

        let mut reporter = match run_id.as_deref() {
            Some(rid) => match ProgressReporter::new_redis(&cfg.redis_url, rid).await {
                Ok(r) => r,
                Err(e) => {
                    warn!(run_id = rid, error = %e, "Failed to connect progress reporter, using dry-run");
                    ProgressReporter::new_dry_run(rid)
                }
            },
            None => ProgressReporter::new_dry_run("worker"),
        };

        let result = run_targeted(
            &cfg,
            spec.into(),
            &mut writer,
            &mut reporter,
            Some(&pg_writer),
            true,
            true,
        )
        .await;

        mark_terminal(&pg, task_id, run_id.as_deref(), &result).await;
    }

    info!("Task A: targeted queue consumer shutting down");
    Ok(())
}

async fn mark_pickup(pg: &PgPool, task_id: Option<i64>, run_id: Option<&str>) {
    if let Some(tid) = task_id {
        if let Err(e) = sqlx::query(
            "UPDATE label_tasks SET status='running', updated_at=NOW() WHERE id=$1",
        )
        .bind(tid)
        .execute(pg)
        .await
        {
            warn!(task_id = tid, error = %e, "Failed to mark label_task as running");
        }
    }
    if let Some(rid) = run_id {
        if let Err(e) =
            sqlx::query("UPDATE ingestion_runs SET status='running' WHERE run_id=$1")
                .bind(rid)
                .execute(pg)
                .await
        {
            warn!(run_id = rid, error = %e, "Failed to mark ingestion_run as running");
        }
    }
}

async fn mark_terminal(
    pg: &PgPool,
    task_id: Option<i64>,
    run_id: Option<&str>,
    result: &Result<u64>,
) {
    match result {
        Ok(n) => {
            if let Some(tid) = task_id {
                if let Err(e) = sqlx::query(
                    "UPDATE label_tasks SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1",
                )
                .bind(tid)
                .execute(pg)
                .await
                {
                    warn!(task_id = tid, error = %e, "Failed to mark label_task as completed");
                }
            }
            if let Some(rid) = run_id {
                if let Err(e) = sqlx::query(
                    "UPDATE ingestion_runs SET status='completed', transactions_processed=$2, completed_at=NOW() WHERE run_id=$1",
                )
                .bind(rid)
                .bind(*n as i64)
                .execute(pg)
                .await
                {
                    warn!(run_id = rid, error = %e, "Failed to mark ingestion_run as completed");
                }
            }
            info!(?task_id, ?run_id, transactions = n, "Targeted fetch complete");
        }
        Err(e) => {
            let tag = classify_error(e);
            let msg = format!("{}: {}", tag, e);
            warn!(?task_id, ?run_id, tag, error = %e, "Targeted fetch failed");
            if let Some(rid) = run_id {
                if let Err(e2) = sqlx::query(
                    "UPDATE ingestion_runs SET status='failed', error_message=$2, completed_at=NOW() WHERE run_id=$1",
                )
                .bind(rid)
                .bind(&msg)
                .execute(pg)
                .await
                {
                    warn!(run_id = rid, error = %e2, "Failed to mark ingestion_run as failed");
                }
            }
            // label_tasks has no 'failed' enum value — leave as running.
        }
    }
}
