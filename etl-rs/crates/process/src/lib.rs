pub mod features;
pub mod resolver;

use eyre::Result;
use pipeline::ProcessProgressReporter;
use sinks::{
    neo4j::Neo4jWriter,
    postgres_reader::PostgresReader,
    postgres_writer::PostgresWriter,
    redis_consumer::{CombinedBatch, StreamConsumer},
};
use tracing::{info, warn};

/// Read one combined batch from Redis without processing. The caller decides
/// what to do with the batch on failure (e.g. DLQ).
pub async fn read_batch(consumer: &mut StreamConsumer) -> Result<CombinedBatch> {
    consumer.read_all_batches().await
}

/// Process a batch read via [`read_batch`]. On success, messages are XACK'd.
/// On failure, the caller is responsible for retry / DLQ using the raw
/// messages preserved in `batch.raw_by_stream`.
pub async fn process_read_batch(
    consumer: &mut StreamConsumer,
    pg: &PostgresReader,
    pg_writer: &PostgresWriter,
    neo4j: &Neo4jWriter,
    reporter: &mut ProcessProgressReporter,
    batch: CombinedBatch,
) -> Result<(u64, u64, u64)> {
    if batch.txs.is_empty() && batch.traces.is_empty() && batch.transfers.is_empty() {
        return Ok((0, 0, 0));
    }

    let tx_msg_ids: Vec<String> = batch.txs.iter().map(|(id, _)| id.clone()).collect();
    let trace_msg_ids: Vec<String> = batch.traces.iter().map(|(id, _)| id.clone()).collect();
    let transfer_msg_ids: Vec<String> = batch.transfers.iter().map(|(id, _)| id.clone()).collect();

    let txs: Vec<_> = batch.txs.into_iter().map(|(_, tx)| tx).collect();
    let traces: Vec<_> = batch.traces.into_iter().map(|(_, t)| t).collect();
    let transfers: Vec<_> = batch.transfers.into_iter().map(|(_, t)| t).collect();

    let tx_count = txs.len() as u64;
    let trace_count = traces.len() as u64;
    let transfer_count = transfers.len() as u64;

    info!(tx_count, trace_count, transfer_count, "Read batch from Redis");

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

    let enriched = features::compute_features(&entities, &txs);

    reporter
        .report_stage("compute_features", enriched.len() as u64, entity_count)
        .await?;

    let neo4j_entities_fut = neo4j.upsert_entities(&enriched);
    let pg_features_fut = async {
        match pg_writer.upsert_entity_features(&enriched).await {
            Ok(count) => {
                info!(count, "Entity features written to PostgreSQL");
                Ok::<u64, eyre::Report>(count)
            }
            Err(e) => {
                warn!(error = %e, "Failed to write entity features to PostgreSQL, continuing");
                Ok(0)
            }
        }
    };
    let (nodes_upserted, _) = tokio::try_join!(neo4j_entities_fut, pg_features_fut)?;

    reporter
        .report_stage("upsert_entities", nodes_upserted, entity_count)
        .await?;

    let txs_fut = async {
        if txs.is_empty() {
            Ok(0u64)
        } else {
            neo4j.upsert_transactions(&txs).await
        }
    };
    let traces_fut = async {
        if traces.is_empty() {
            Ok(0u64)
        } else {
            neo4j.upsert_traces(&traces).await
        }
    };
    let transfers_fut = async {
        if transfers.is_empty() {
            Ok(0u64)
        } else {
            neo4j.upsert_transfers(&transfers).await
        }
    };

    let (txs_upserted, traces_upserted, transfers_upserted) =
        tokio::try_join!(txs_fut, traces_fut, transfers_fut)?;

    reporter
        .report_stage("upsert_transactions", txs_upserted, tx_count)
        .await?;

    if !traces.is_empty() {
        reporter
            .report_stage("upsert_traces", traces_upserted, trace_count)
            .await?;
    }

    if !transfers.is_empty() {
        reporter
            .report_stage("upsert_transfers", transfers_upserted, transfer_count)
            .await?;
    }

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

/// Back-compat convenience: read + process in one call. Preserves old API
/// used by one-shot mode.
pub async fn process_batch(
    consumer: &mut StreamConsumer,
    pg: &PostgresReader,
    pg_writer: &PostgresWriter,
    neo4j: &Neo4jWriter,
    reporter: &mut ProcessProgressReporter,
) -> Result<(u64, u64, u64)> {
    let batch = read_batch(consumer).await?;
    process_read_batch(consumer, pg, pg_writer, neo4j, reporter, batch).await
}
