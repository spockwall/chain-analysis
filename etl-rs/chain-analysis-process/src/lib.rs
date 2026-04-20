pub mod db;
pub mod pipeline;
pub mod progress;

use eyre::Result;
use tracing::{info, warn};

/// Read one combined batch from Redis, then resolve + enrich + write to Neo4j + PG.
///
/// Concurrency wins vs. the previous serial version:
/// - All three streams read in a single XREADGROUP (saves up to 2 × `block_ms`).
/// - Neo4j entity-upsert and PG entity_features upsert run in parallel.
/// - Neo4j transaction/trace/transfer upserts run in parallel.
pub async fn process_batch(
    consumer: &mut db::redis::StreamConsumer,
    pg: &db::postgres_reader::PostgresReader,
    pg_writer: &db::postgres_writer::PostgresWriter,
    neo4j: &db::neo4j::Neo4jWriter,
    reporter: &mut progress::ProcessProgressReporter,
) -> Result<(u64, u64, u64)> {
    let combined = consumer.read_all_batches().await?;

    if combined.txs.is_empty() && combined.traces.is_empty() && combined.transfers.is_empty() {
        return Ok((0, 0, 0));
    }

    let tx_msg_ids: Vec<String> = combined.txs.iter().map(|(id, _)| id.clone()).collect();
    let trace_msg_ids: Vec<String> = combined.traces.iter().map(|(id, _)| id.clone()).collect();
    let transfer_msg_ids: Vec<String> = combined.transfers.iter().map(|(id, _)| id.clone()).collect();

    let txs: Vec<_> = combined.txs.into_iter().map(|(_, tx)| tx).collect();
    let traces: Vec<_> = combined.traces.into_iter().map(|(_, t)| t).collect();
    let transfers: Vec<_> = combined.transfers.into_iter().map(|(_, t)| t).collect();

    let tx_count = txs.len() as u64;
    let trace_count = traces.len() as u64;
    let transfer_count = transfers.len() as u64;

    info!(tx_count, trace_count, transfer_count, "Read batch from Redis");

    let mut address_info = pipeline::resolver::extract_addresses(&txs);
    pipeline::resolver::extract_addresses_from_traces(&traces, &mut address_info);
    pipeline::resolver::extract_addresses_from_transfers(&transfers, &mut address_info);

    let addresses: Vec<String> = address_info.keys().cloned().collect();

    let known_labels = match pg.get_known_labels(&addresses).await {
        Ok(labels) => labels,
        Err(e) => {
            warn!(error = %e, "Failed to query known_labels, proceeding without");
            std::collections::HashMap::new()
        }
    };

    let entities = pipeline::resolver::resolve_entities(&address_info, &known_labels);
    let entity_count = entities.len() as u64;

    reporter
        .report_stage("resolve_entities", entity_count, entity_count)
        .await?;

    let enriched = pipeline::features::compute_features(&entities, &txs);

    reporter
        .report_stage("compute_features", enriched.len() as u64, entity_count)
        .await?;

    // Stage 1: entities → Neo4j (graph) and PG (features) in parallel.
    // Different databases — no contention.
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

    // Stage 2: transactions / traces / transfers to Neo4j in parallel.
    // All three MERGE entities, so order doesn't matter for final state.
    // Neo4j handles concurrent MERGE with internal locks; throughput wins from
    // overlapped network round-trips.
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
