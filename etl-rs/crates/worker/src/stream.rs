//! Task C: XREADGROUP consumer that writes batches to Neo4j + Postgres.
//! Ported from `crates/process/src/main.rs` continuous loop, minus the
//! `ingestion_runs` self-tracking row.

use consumer::{process_read_batch, read_batch};
use eyre::Result;
use metrics::counter;
use observability::{CONSUMER_BATCHES_PROCESSED, DLQ_MESSAGES_MOVED, DLQ_MOVES};
use pipeline::dlq::{self, BatchKey, DlqPolicy};
use pipeline::{ProcessProgressReporter, ShutdownHandle};
use sinks::neo4j::Neo4jWriter;
use sinks::postgres_reader::PostgresReader;
use sinks::postgres_writer::PostgresWriter;
use sinks::redis_consumer::StreamConsumer;
use sqlx::PgPool;
use tracing::{error, info, warn};

pub async fn run(
    cfg: std::sync::Arc<config::ProcessConfig>,
    pg: PgPool,
    neo4j: Neo4jWriter,
    batch_size: usize,
    block_ms: usize,
    mut shutdown: ShutdownHandle,
) -> Result<()> {
    let mut consumer = StreamConsumer::connect(
        &cfg.redis_url,
        &cfg.consumer_group,
        &cfg.consumer_name,
        batch_size,
        block_ms,
    )
    .await?;
    consumer.ensure_groups().await?;

    let pg_reader = PostgresReader::new(pg.clone());
    let pg_writer = PostgresWriter::new(pg);

    // Worker has no per-run_id — publish under a static label; listeners
    // filter by run_id client-side.
    let mut reporter = ProcessProgressReporter::new(&cfg.redis_url, "worker-stream").await?;

    let dlq_policy = DlqPolicy {
        max_attempts: cfg.dlq_max_attempts,
        dlq_suffix: cfg.dlq_suffix.clone(),
        attempt_ttl_secs: cfg.dlq_attempt_ttl_secs,
    };

    info!(
        consumer_group = %cfg.consumer_group,
        batch_size, block_ms,
        "Task C: stream consumer starting"
    );

    loop {
        if shutdown.is_shutdown() {
            break;
        }

        let batch = tokio::select! {
            r = read_batch(&mut consumer) => match r {
                Ok(b) => b,
                Err(e) => {
                    error!(error = %e, "Failed to read batch, backing off");
                    reporter.report_error(&e.to_string()).await.ok();
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {},
                        _ = shutdown.wait() => break,
                    }
                    continue;
                }
            },
            _ = shutdown.wait() => break,
        };

        let raw_snapshot = batch.raw_by_stream.clone();

        let result = process_read_batch(
            &mut consumer,
            &pg_reader,
            &pg_writer,
            &neo4j,
            &mut reporter,
            batch,
        )
        .await;

        if let Err(e) = result {
            error!(error = %e, "Batch processing failed");
            reporter.report_error(&e.to_string()).await.ok();

            let group = consumer.group().to_string();
            counter!(
                CONSUMER_BATCHES_PROCESSED,
                "group" => group.clone(),
                "outcome" => "error",
            )
            .increment(1);

            let conn = consumer.conn_mut();
            for (stream, msgs) in &raw_snapshot {
                if msgs.is_empty() {
                    continue;
                }
                let first = msgs.first().map(|(id, _)| id.clone()).unwrap_or_default();
                let last = msgs.last().map(|(id, _)| id.clone()).unwrap_or_default();
                let key = BatchKey {
                    stream: stream.clone(),
                    first_id: first,
                    last_id: last,
                };
                let attempts =
                    match dlq::incr_attempt(conn, &key, dlq_policy.attempt_ttl_secs).await {
                        Ok(n) => n,
                        Err(e) => {
                            warn!(stream, error = %e, "Failed to increment DLQ attempt counter");
                            continue;
                        }
                    };
                if attempts >= dlq_policy.max_attempts {
                    warn!(
                        stream,
                        attempts,
                        count = msgs.len(),
                        "Batch exceeded max attempts, routing to DLQ"
                    );
                    match dlq::move_batch_to_dlq(conn, stream, &group, msgs, &dlq_policy).await {
                        Ok(()) => {
                            let label = stream.clone();
                            counter!(DLQ_MOVES, "stream" => label.clone()).increment(1);
                            counter!(DLQ_MESSAGES_MOVED, "stream" => label)
                                .increment(msgs.len() as u64);
                        }
                        Err(e) => {
                            error!(stream, error = %e, "DLQ relocation failed");
                        }
                    }
                } else {
                    info!(stream, attempts, "Will retry batch");
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {},
                _ = shutdown.wait() => break,
            }
        }
    }

    info!("Task C: stream consumer shutting down");
    Ok(())
}
