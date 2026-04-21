//! ClickHouse consumer — runs as an independent consumer group on the same
//! Redis streams that the Neo4j/Postgres `process` binary consumes. Each
//! batch XREADGROUP'd here is inserted into ClickHouse analytical tables and
//! XACK'd independently of the primary consumer group.
//!
//! Failure handling mirrors `process`: per-batch attempt counter with a DLQ
//! suffix (`CLICKHOUSE_DLQ_SUFFIX`, default `_dlq`). On `CLICKHOUSE_DLQ_MAX_ATTEMPTS`
//! failures, the batch is moved to `{stream}_dlq` and XACK'd.

use clap::Parser;
use color_eyre::eyre::Result;
use pipeline::dlq::{self, BatchKey, DlqPolicy};
use pipeline::install_shutdown;
use sinks::clickhouse::ClickhouseWriter;
use sinks::redis_consumer::{StreamConsumer, STREAM_TRACES, STREAM_TRANSFERS, STREAM_TXS};
use tracing::{error, info, warn};

#[derive(Parser)]
#[command(
    name = "clickhouse-process",
    about = "Redis consumer → ClickHouse analytical writer",
    long_about = "Consumes from the same Redis streams as `process` under a separate\n\
                  consumer group (default: chain-analysis-clickhouse). Inserts rows\n\
                  into ClickHouse tables with strict ethereum-etl column naming."
)]
struct Cli {
    /// Read one batch then exit.
    #[arg(long, default_value_t = false)]
    one_shot: bool,

    /// Max messages per XREADGROUP call (per stream).
    #[arg(long, default_value_t = 1000)]
    batch_size: usize,

    /// Block duration for XREADGROUP, in ms. 0 = non-blocking.
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
    let config = config::ClickhouseConfig::from_env();

    info!(
        one_shot = cli.one_shot,
        batch_size = cli.batch_size,
        consumer_group = %config.consumer_group,
        clickhouse_url = %config.clickhouse_url,
        "Starting clickhouse-process worker"
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

    let writer = ClickhouseWriter::connect(
        &config.clickhouse_url,
        &config.clickhouse_database,
        &config.clickhouse_user,
        &config.clickhouse_password,
    )?;

    let dlq_policy = DlqPolicy {
        max_attempts: config.dlq_max_attempts,
        dlq_suffix: config.dlq_suffix.clone(),
        attempt_ttl_secs: config.dlq_attempt_ttl_secs,
    };

    let mut total_txs = 0u64;
    let mut total_traces = 0u64;
    let mut total_transfers = 0u64;

    if cli.one_shot {
        let (t, tr, tf) = consume_once(&mut consumer, &writer).await?;
        total_txs += t;
        total_traces += tr;
        total_transfers += tf;
    } else {
        info!("Running in continuous mode (SIGINT/SIGTERM to stop)");
        let mut shutdown = install_shutdown();

        loop {
            if shutdown.is_shutdown() {
                break;
            }

            let batch = tokio::select! {
                r = consumer.read_all_batches() => match r {
                    Ok(b) => b,
                    Err(e) => {
                        error!(error = %e, "Failed to read batch, backing off");
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {},
                            _ = shutdown.wait() => break,
                        }
                        continue;
                    }
                },
                _ = shutdown.wait() => break,
            };

            if batch.txs.is_empty() && batch.traces.is_empty() && batch.transfers.is_empty() {
                continue;
            }

            let raw_snapshot = batch.raw_by_stream.clone();

            let tx_items: Vec<_> = batch.txs.iter().map(|(_, t)| t.clone()).collect();
            let trace_items: Vec<_> = batch.traces.iter().map(|(_, t)| t.clone()).collect();
            let transfer_items: Vec<_> = batch.transfers.iter().map(|(_, t)| t.clone()).collect();

            let tx_ids: Vec<String> = batch.txs.iter().map(|(id, _)| id.clone()).collect();
            let trace_ids: Vec<String> = batch.traces.iter().map(|(id, _)| id.clone()).collect();
            let transfer_ids: Vec<String> =
                batch.transfers.iter().map(|(id, _)| id.clone()).collect();

            let result = async {
                writer.insert_transactions(&tx_items).await?;
                writer.insert_traces(&trace_items).await?;
                writer.insert_transfers(&transfer_items).await?;
                eyre::Ok(())
            }
            .await;

            match result {
                Ok(()) => {
                    consumer.ack_txs(&tx_ids).await.ok();
                    consumer.ack_traces(&trace_ids).await.ok();
                    consumer.ack_transfers(&transfer_ids).await.ok();
                    total_txs += tx_ids.len() as u64;
                    total_traces += trace_ids.len() as u64;
                    total_transfers += transfer_ids.len() as u64;
                    info!(
                        txs = tx_ids.len(),
                        traces = trace_ids.len(),
                        transfers = transfer_ids.len(),
                        "Batch written to ClickHouse"
                    );
                }
                Err(e) => {
                    error!(error = %e, "ClickHouse batch insert failed");
                    let group = consumer.group().to_string();
                    let conn = consumer.conn_mut();
                    for stream in [STREAM_TXS, STREAM_TRACES, STREAM_TRANSFERS] {
                        let Some(msgs) = raw_snapshot.get(stream) else {
                            continue;
                        };
                        if msgs.is_empty() {
                            continue;
                        }
                        let first = msgs.first().map(|(id, _)| id.clone()).unwrap_or_default();
                        let last = msgs.last().map(|(id, _)| id.clone()).unwrap_or_default();
                        let key = BatchKey {
                            stream: stream.to_string(),
                            first_id: first,
                            last_id: last,
                        };
                        let attempts =
                            match dlq::incr_attempt(conn, &key, dlq_policy.attempt_ttl_secs).await {
                                Ok(n) => n,
                                Err(e) => {
                                    warn!(stream, error = %e, "incr_attempt failed");
                                    continue;
                                }
                            };
                        if attempts >= dlq_policy.max_attempts {
                            warn!(stream, attempts, count = msgs.len(), "Routing batch to DLQ");
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

    info!(
        transactions = total_txs,
        traces = total_traces,
        transfers = total_transfers,
        "clickhouse-process finished"
    );

    Ok(())
}

async fn consume_once(
    consumer: &mut StreamConsumer,
    writer: &ClickhouseWriter,
) -> Result<(u64, u64, u64)> {
    let batch = consumer.read_all_batches().await?;

    let tx_items: Vec<_> = batch.txs.iter().map(|(_, t)| t.clone()).collect();
    let trace_items: Vec<_> = batch.traces.iter().map(|(_, t)| t.clone()).collect();
    let transfer_items: Vec<_> = batch.transfers.iter().map(|(_, t)| t.clone()).collect();

    writer.insert_transactions(&tx_items).await?;
    writer.insert_traces(&trace_items).await?;
    writer.insert_transfers(&transfer_items).await?;

    let tx_ids: Vec<String> = batch.txs.iter().map(|(id, _)| id.clone()).collect();
    let trace_ids: Vec<String> = batch.traces.iter().map(|(id, _)| id.clone()).collect();
    let transfer_ids: Vec<String> = batch.transfers.iter().map(|(id, _)| id.clone()).collect();
    consumer.ack_txs(&tx_ids).await.ok();
    consumer.ack_traces(&trace_ids).await.ok();
    consumer.ack_transfers(&transfer_ids).await.ok();

    Ok((
        tx_ids.len() as u64,
        trace_ids.len() as u64,
        transfer_ids.len() as u64,
    ))
}
