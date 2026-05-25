use eyre::Result;
use crate::pipeline::{ProgressReporter, RetryPolicy};
use redis::AsyncCommands;
use crate::sinks::redis_stream::TransactionWriter;
use tracing::{info, warn};

use super::{ingest_block_range_pipelined, DynBlockSource};

/// Drain `ingest:failed_blocks:{source}` by re-fetching each block and
/// pushing it through the normal pipelined writer. On success the block
/// is SREM'd from the set; on failure it stays and can be retried again.
#[allow(clippy::too_many_arguments)]
pub async fn reprocess_failed_blocks(
    config: &crate::config::Config,
    source_label: &str,
    block_source: DynBlockSource,
    writer: Box<dyn TransactionWriter>,
    progress_reporter: ProgressReporter,
    retry_policy: &RetryPolicy,
    with_traces: bool,
    with_transfers: bool,
    fetch_concurrency: usize,
) -> Result<(Box<dyn TransactionWriter>, ProgressReporter, u64, u64)> {
    let client = redis::Client::open(config.redis_url.clone())?;
    let mut conn = client.get_multiplexed_async_connection().await?;
    let key = format!("ingest:failed_blocks:{}", source_label);

    let blocks: Vec<u64> = conn.smembers(&key).await?;
    if blocks.is_empty() {
        info!(source = source_label, "No failed blocks to reprocess");
        return Ok((writer, progress_reporter, 0, 0));
    }

    info!(source = source_label, count = blocks.len(), "Reprocessing failed blocks");

    // The pipelined range driver expects contiguous ranges, so run each
    // failed block as a single-block range. That's fine — DLQ is a rare path.
    let mut writer = writer;
    let mut progress_reporter = progress_reporter;
    let mut total_txs = 0u64;
    let mut ok_count = 0u64;

    for block_num in &blocks {
        let (w, r, txs_after) = ingest_block_range_pipelined(
            block_source.clone(),
            *block_num,
            *block_num,
            writer,
            progress_reporter,
            retry_policy,
            with_traces,
            with_transfers,
            fetch_concurrency,
            1,
            total_txs,
        )
        .await?;
        writer = w;
        progress_reporter = r;
        total_txs = txs_after;

        if let Err(e) = conn.srem::<_, _, ()>(&key, *block_num).await {
            warn!(block = block_num, error = %e, "Failed to remove block from failed set");
        } else {
            ok_count += 1;
        }
    }

    info!(source = source_label, reprocessed = ok_count, total_txs, "Reprocessing complete");
    Ok((writer, progress_reporter, ok_count, total_txs))
}
