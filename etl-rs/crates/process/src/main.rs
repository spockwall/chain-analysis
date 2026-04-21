use pipeline::dlq::{self, BatchKey, DlqPolicy};
use pipeline::{install_shutdown, ProcessProgressReporter};
use process::{process_batch, process_read_batch, read_batch};
use sinks::neo4j::Neo4jWriter;
use sinks::postgres_reader::PostgresReader;
use sinks::postgres_writer::PostgresWriter;
use sinks::redis_consumer::StreamConsumer;
use clap::Parser;
use color_eyre::eyre::Result;
use tracing::{error, info, warn};

#[derive(Parser)]
#[command(
    name = "process",
    about = "Redis consumer → Neo4j graph writer",
    long_about = "Consumes IngestionMessages from Redis Streams and writes entities,\n\
                  transactions, traces, and transfers to Neo4j and PostgreSQL.\n\
                  \n\
                  Run after `ingest` has written data to Redis:\n\
                  \n\
                  One-shot:   process --one-shot   (read one batch then exit)\n\
                  Continuous: process              (read until Ctrl+C)"
)]
struct Cli {
    /// Unique identifier for this run (auto-generated UUID if not set).
    #[arg(long, default_value_t = uuid::Uuid::new_v4().to_string())]
    run_id: String,

    /// Read one batch from Redis then exit. Useful for manual runs or orchestration.
    /// Without this flag the worker runs continuously until Ctrl+C.
    #[arg(long, default_value_t = false)]
    one_shot: bool,

    /// Max messages to read per XREADGROUP call (per stream).
    #[arg(long, default_value_t = 500)]
    batch_size: usize,

    /// How long to block waiting for new Redis messages, in milliseconds.
    /// 0 = non-blocking (returns immediately if no messages).
    #[arg(long, default_value_t = 5000)]
    block_ms: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let config = config::ProcessConfig::from_env();

    info!(
        run_id = %cli.run_id,
        one_shot = cli.one_shot,
        batch_size = cli.batch_size,
        consumer_group = %config.consumer_group,
        "Starting process worker"
    );

    let mut consumer = StreamConsumer::connect(
        &config.redis_url,
        &config.consumer_group,
        &config.consumer_name,
        cli.batch_size,
        cli.block_ms,
    )
    .await?;
    consumer.ensure_groups().await?;

    let neo4j = Neo4jWriter::connect(
        &config.neo4j_uri,
        &config.neo4j_user,
        &config.neo4j_password,
        &config.neo4j_database,
    )
    .await?;

    let pg_pool = sqlx::PgPool::connect(&config.postgres_url).await?;
    let pg = PostgresReader::new(pg_pool.clone());
    let pg_writer = PostgresWriter::new(pg_pool);

    pg_writer
        .insert_ingestion_run(&cli.run_id, 0, 0)
        .await
        .unwrap_or_else(|e| warn!(error = %e, "Failed to insert ingestion run"));

    let mut reporter = ProcessProgressReporter::new(&config.redis_url, &cli.run_id).await?;

    let mut total_entities = 0u64;
    let mut total_txs = 0u64;
    let mut total_traces = 0u64;

    if cli.one_shot {
        let (ent, txs, traces) =
            process_batch(&mut consumer, &pg, &pg_writer, &neo4j, &mut reporter).await?;
        total_entities += ent;
        total_txs += txs;
        total_traces += traces;
    } else {
        info!("Running in continuous mode (SIGINT/SIGTERM to stop)");

        let mut shutdown = install_shutdown();
        let dlq_policy = DlqPolicy {
            max_attempts: config.dlq_max_attempts,
            dlq_suffix: config.dlq_suffix.clone(),
            attempt_ttl_secs: config.dlq_attempt_ttl_secs,
        };

        loop {
            if shutdown.is_shutdown() {
                info!("Received shutdown signal");
                break;
            }

            let batch = tokio::select! {
                r = read_batch(&mut consumer) => match r {
                    Ok(b) => b,
                    Err(e) => {
                        error!(error = %e, "Failed to read batch, backing off");
                        reporter.report_error(&e.to_string()).await?;
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {},
                            _ = shutdown.wait() => break,
                        }
                        continue;
                    }
                },
                _ = shutdown.wait() => { info!("Received shutdown signal"); break; }
            };

            // Snapshot raw messages for potential DLQ routing. `process_read_batch`
            // consumes the batch on the happy path.
            let raw_snapshot = batch.raw_by_stream.clone();

            let result = process_read_batch(
                &mut consumer,
                &pg,
                &pg_writer,
                &neo4j,
                &mut reporter,
                batch,
            )
            .await;

            match result {
                Ok((ent, txs, traces)) => {
                    total_entities += ent;
                    total_txs += txs;
                    total_traces += traces;
                }
                Err(e) => {
                    error!(error = %e, "Batch processing failed");
                    reporter.report_error(&e.to_string()).await?;

                    let group = consumer.group().to_string();
                    let conn = consumer.conn_mut();
                    for (stream, msgs) in &raw_snapshot {
                        if msgs.is_empty() { continue; }
                        let first = msgs.first().map(|(id, _)| id.clone()).unwrap_or_default();
                        let last = msgs.last().map(|(id, _)| id.clone()).unwrap_or_default();
                        let key = BatchKey {
                            stream: stream.clone(),
                            first_id: first,
                            last_id: last,
                        };
                        let attempts = match dlq::incr_attempt(conn, &key, dlq_policy.attempt_ttl_secs).await {
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
                            if let Err(e) =
                                dlq::move_batch_to_dlq(conn, stream, &group, msgs, &dlq_policy).await
                            {
                                error!(stream, error = %e, "DLQ relocation failed");
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
        }
    }

    pg_writer
        .update_ingestion_run(
            &cli.run_id,
            "completed",
            total_txs as i64,
            total_traces as i64,
            total_entities as i64,
            None,
        )
        .await
        .unwrap_or_else(|e| warn!(error = %e, "Failed to update ingestion run"));

    reporter.report_complete(total_entities, total_txs).await?;

    info!(
        entities = total_entities,
        transactions = total_txs,
        "Process worker finished"
    );

    Ok(())
}
