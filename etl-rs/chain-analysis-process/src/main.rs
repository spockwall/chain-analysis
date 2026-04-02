use clap::Parser;
use color_eyre::eyre::Result;
use tracing::{error, info, warn};

mod consumer;
mod features;
mod neo4j_writer;
mod postgres_reader;
mod postgres_writer;
mod progress;
mod resolver;

use consumer::StreamConsumer;
use neo4j_writer::Neo4jWriter;
use postgres_reader::PostgresReader;
use postgres_writer::PostgresWriter;
use progress::ProcessProgressReporter;

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

async fn process_batch(
    consumer: &mut StreamConsumer,
    pg: &PostgresReader,
    pg_writer: &PostgresWriter,
    neo4j: &Neo4jWriter,
    reporter: &mut ProcessProgressReporter,
) -> Result<(u64, u64, u64)> {
    // 1. Read from all three streams
    let tx_batch = consumer.read_batch().await?;
    let trace_batch = consumer.read_trace_batch().await?;
    let transfer_batch = consumer.read_transfer_batch().await?;

    if tx_batch.is_empty() && trace_batch.is_empty() && transfer_batch.is_empty() {
        return Ok((0, 0, 0));
    }

    let tx_msg_ids: Vec<String> = tx_batch.iter().map(|(id, _)| id.clone()).collect();
    let trace_msg_ids: Vec<String> = trace_batch.iter().map(|(id, _)| id.clone()).collect();
    let transfer_msg_ids: Vec<String> = transfer_batch.iter().map(|(id, _)| id.clone()).collect();

    let txs: Vec<_> = tx_batch.into_iter().map(|(_, tx)| tx).collect();
    let traces: Vec<_> = trace_batch.into_iter().map(|(_, t)| t).collect();
    let transfers: Vec<_> = transfer_batch.into_iter().map(|(_, t)| t).collect();

    let tx_count = txs.len() as u64;
    let trace_count = traces.len() as u64;
    let transfer_count = transfers.len() as u64;

    info!(
        tx_count,
        trace_count,
        transfer_count,
        "Read batch from Redis"
    );

    // 2. Extract addresses from all sources
    let mut address_info = resolver::extract_addresses(&txs);
    resolver::extract_addresses_from_traces(&traces, &mut address_info);
    resolver::extract_addresses_from_transfers(&transfers, &mut address_info);

    let addresses: Vec<String> = address_info.keys().cloned().collect();

    let known_labels = match pg.get_known_labels(&addresses).await {
        Ok(labels) => labels,
        Err(e) => {
            warn!(error = %e, "Failed to query known_labels, proceeding without");
            std::collections::HashMap::new()
        }
    };

    let entities = resolver::resolve_entities(&address_info, &known_labels);
    let entity_count = entities.len() as u64;

    reporter
        .report_stage("resolve_entities", entity_count, entity_count)
        .await?;

    // 3. Compute features (from transactions only)
    let enriched = features::compute_features(&entities, &txs);

    reporter
        .report_stage("compute_features", enriched.len() as u64, entity_count)
        .await?;

    // 4. Upsert entity nodes to Neo4j
    let nodes_upserted = neo4j.upsert_entities(&enriched).await?;

    reporter
        .report_stage("upsert_entities", nodes_upserted, entity_count)
        .await?;

    // 4b. Upsert entity features to PostgreSQL
    match pg_writer.upsert_entity_features(&enriched).await {
        Ok(count) => {
            info!(count, "Entity features written to PostgreSQL");
        }
        Err(e) => {
            warn!(error = %e, "Failed to write entity features to PostgreSQL, continuing");
        }
    }

    // 5. Upsert transaction nodes + relationships to Neo4j
    let txs_upserted = if !txs.is_empty() {
        neo4j.upsert_transactions(&txs).await?
    } else {
        0
    };

    reporter
        .report_stage("upsert_transactions", txs_upserted, tx_count)
        .await?;

    // 6. Upsert trace nodes
    if !traces.is_empty() {
        let traces_upserted = neo4j.upsert_traces(&traces).await?;
        reporter
            .report_stage("upsert_traces", traces_upserted, trace_count)
            .await?;
    }

    // 7. Upsert token transfer nodes
    if !transfers.is_empty() {
        let transfers_upserted = neo4j.upsert_transfers(&transfers).await?;
        reporter
            .report_stage("upsert_transfers", transfers_upserted, transfer_count)
            .await?;
    }

    // 8. ACK all streams
    consumer.ack_txs(&tx_msg_ids).await?;
    consumer.ack_traces(&trace_msg_ids).await?;
    consumer.ack_transfers(&transfer_msg_ids).await?;

    info!(
        entities = entity_count,
        transactions = tx_count,
        traces = trace_count,
        transfers = transfer_count,
        "Batch processed successfully"
    );

    Ok((entity_count, tx_count, trace_count + transfer_count))
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
    let config = chain_analysis_common::ProcessConfig::from_env();

    info!(
        run_id = %cli.run_id,
        one_shot = cli.one_shot,
        batch_size = cli.batch_size,
        consumer_group = %config.consumer_group,
        "Starting process worker"
    );

    // Connect to services
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

    // Record this run in postgres
    pg_writer
        .insert_ingestion_run(&cli.run_id, 0, 0)
        .await
        .unwrap_or_else(|e| warn!(error = %e, "Failed to insert ingestion run"));

    let mut reporter = ProcessProgressReporter::new(&config.redis_url, &cli.run_id).await?;

    let mut total_entities = 0u64;
    let mut total_txs = 0u64;
    let mut total_traces = 0u64;

    if cli.one_shot {
        let (ent, txs, traces) = process_batch(&mut consumer, &pg, &pg_writer, &neo4j, &mut reporter).await?;
        total_entities += ent;
        total_txs += txs;
        total_traces += traces;
    } else {
        info!("Running in continuous mode (Ctrl+C to stop)");

        let shutdown = tokio::signal::ctrl_c();
        tokio::pin!(shutdown);

        loop {
            tokio::select! {
                result = process_batch(&mut consumer, &pg, &pg_writer, &neo4j, &mut reporter) => {
                    match result {
                        Ok((ent, txs, traces)) => {
                            total_entities += ent;
                            total_txs += txs;
                            total_traces += traces;
                        }
                        Err(e) => {
                            error!(error = %e, "Batch processing failed");
                            reporter.report_error(&e.to_string()).await?;
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        }
                    }
                }
                _ = &mut shutdown => {
                    info!("Received shutdown signal");
                    break;
                }
            }
        }
    }

    // Update run as completed
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

    reporter
        .report_complete(total_entities, total_txs)
        .await?;

    info!(
        entities = total_entities,
        transactions = total_txs,
        "Process worker finished"
    );

    Ok(())
}
