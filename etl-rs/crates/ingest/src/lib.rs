pub mod modes;
pub mod writer_pipeline;

use eyre::Result;
use futures::stream::{self, StreamExt};
use metrics::{counter, histogram};
use observability::{INGEST_BLOCKS_FAILED, INGEST_BLOCKS_FETCHED, INGEST_FETCH_DURATION};
use pipeline::{with_retry, ProgressReporter, RetryPolicy};
use sinks::redis_stream::TransactionWriter;
use sources::{etherscan, BlockSource};
use std::sync::Arc;
use std::time::Instant;
use tracing::{error, info, warn};
use types::{Trace, Transaction, Transfer};
use writer_pipeline::{spawn_writer, WriterCommand, WriterHandles};

/// Convenience alias. All pipelined ingest functions accept a shared handle so
/// they can clone it into spawned fetch tasks.
pub type DynBlockSource = Arc<dyn BlockSource>;

pub async fn fetch_block(source: &dyn BlockSource, block_num: u64) -> Result<Vec<Transaction>> {
    source.fetch_block(block_num).await
}

pub async fn get_latest_block(source: &dyn BlockSource) -> Result<u64> {
    source.latest_block().await
}

async fn fetch_block_data(
    source: &dyn BlockSource,
    block_num: u64,
    retry_policy: &RetryPolicy,
    with_traces: bool,
    with_transfers: bool,
) -> Result<(Vec<Transaction>, Vec<Trace>, Vec<Transfer>)> {
    let source_name = source.name();
    let started = Instant::now();
    let txs = match with_retry(retry_policy, &format!("fetch_block_{}", block_num), || {
        fetch_block(source, block_num)
    })
    .await
    {
        Ok(txs) => {
            histogram!(INGEST_FETCH_DURATION, "source" => source_name)
                .record(started.elapsed().as_secs_f64());
            counter!(INGEST_BLOCKS_FETCHED, "source" => source_name).increment(1);
            txs
        }
        Err(e) => {
            histogram!(INGEST_FETCH_DURATION, "source" => source_name)
                .record(started.elapsed().as_secs_f64());
            counter!(INGEST_BLOCKS_FAILED, "source" => source_name).increment(1);
            return Err(e);
        }
    };

    let traces_fut = async {
        if with_traces {
            match source.fetch_traces(block_num).await {
                Ok(t) => t,
                Err(e) => {
                    warn!(block = block_num, error = %e, "Failed to fetch traces, skipping");
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        }
    };

    let transfers_fut = async {
        if with_transfers {
            match source.fetch_transfers(block_num).await {
                Ok(t) => t,
                Err(e) => {
                    warn!(block = block_num, error = %e, "Failed to fetch transfers, skipping");
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        }
    };

    let (traces, transfers) = tokio::join!(traces_fut, transfers_fut);
    Ok((txs, traces, transfers))
}

/// Address-mode ingestion. Only valid when the active source is Etherscan
/// (Alchemy's JSON-RPC has no `txlist`-equivalent; Alchemy users should rely
/// on `ingest block --follow` or targeted hash fetches instead).
#[allow(clippy::too_many_arguments)]
pub async fn ingest_address(
    config: &config::Config,
    address: &str,
    start_block: u64,
    end_block: u64,
    writer: &mut Box<dyn TransactionWriter>,
    progress_reporter: &mut ProgressReporter,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    ingest_address_capped(
        config,
        address,
        start_block,
        end_block,
        writer,
        progress_reporter,
        with_traces,
        with_transfers,
        None,
    )
    .await
}

/// Same as `ingest_address` but caps each of txs / traces / transfers at
/// `max_per_kind` items. Used by neighborhood BFS so one very active peer
/// doesn't stall the whole crawl.
#[allow(clippy::too_many_arguments)]
pub async fn ingest_address_capped(
    config: &config::Config,
    address: &str,
    start_block: u64,
    end_block: u64,
    writer: &mut Box<dyn TransactionWriter>,
    progress_reporter: &mut ProgressReporter,
    with_traces: bool,
    with_transfers: bool,
    max_per_kind: Option<usize>,
) -> Result<u64> {
    let base_url = &config.etherscan_base_url;
    let api_key = config
        .etherscan_api_key
        .as_deref()
        .ok_or_else(|| eyre::eyre!("ETHERSCAN_API_KEY required for address mode"))?;
    let chain_id = config.etherscan_chain_id;
    let addr = address.to_lowercase();

    info!(
        address = %addr,
        with_traces, with_transfers, ?max_per_kind,
        "Fetching address data (parallel)"
    );

    let txs_fut = etherscan::address::fetch_pages_capped(
        |page, offset| {
            etherscan::address::fetch_address_transactions(
                base_url, api_key, chain_id, &addr, start_block, end_block, page, offset,
            )
        },
        max_per_kind,
    );

    let traces_fut = async {
        if with_traces {
            etherscan::address::fetch_pages_capped(
                |page, offset| {
                    etherscan::address::fetch_address_internal_txs(
                        base_url, api_key, chain_id, &addr, start_block, end_block, page, offset,
                    )
                },
                max_per_kind,
            )
            .await
        } else {
            Ok(Vec::new())
        }
    };

    let transfers_fut = async {
        if with_transfers {
            etherscan::address::fetch_pages_capped(
                |page, offset| {
                    etherscan::address::fetch_address_token_transfers(
                        base_url, api_key, chain_id, &addr, start_block, end_block, page, offset,
                    )
                },
                max_per_kind,
            )
            .await
        } else {
            Ok(Vec::new())
        }
    };

    let (txs, traces, transfers) = tokio::try_join!(txs_fut, traces_fut, transfers_fut)?;

    info!(
        address = %addr,
        tx_count = txs.len(),
        trace_count = traces.len(),
        transfer_count = transfers.len(),
        "Fetched address data, batched write to Redis"
    );

    let total_txs = txs.len() as u64;

    writer.write_transactions_batch(&txs).await?;
    writer.write_traces_batch(&traces).await?;
    writer.write_transfers_batch(&transfers).await?;

    progress_reporter.report_complete(0, total_txs).await?;

    Ok(total_txs)
}

#[allow(clippy::too_many_arguments)]
pub async fn ingest_block_range_pipelined(
    source: DynBlockSource,
    start: u64,
    end: u64,
    writer: Box<dyn TransactionWriter>,
    mut progress_reporter: ProgressReporter,
    retry_policy: &RetryPolicy,
    with_traces: bool,
    with_transfers: bool,
    fetch_concurrency: usize,
    total_blocks_for_progress: u64,
    initial_total_txs: u64,
) -> Result<(Box<dyn TransactionWriter>, ProgressReporter, u64)> {
    let WriterHandles {
        cmd_tx,
        mut ack_rx,
        join,
    } = spawn_writer(writer, fetch_concurrency.max(2) * 2);

    let mut total_txs = initial_total_txs;

    if start <= end {
        let buffered = stream::iter(start..=end)
            .map(|block_num| {
                let source = Arc::clone(&source);
                async move {
                    let res = fetch_block_data(
                        source.as_ref(),
                        block_num,
                        retry_policy,
                        with_traces,
                        with_transfers,
                    )
                    .await;
                    (block_num, res)
                }
            })
            .buffered(fetch_concurrency);
        tokio::pin!(buffered);

        let mut fetch_done = false;
        while !fetch_done {
            tokio::select! {
                biased;

                Some(ack) = ack_rx.recv() => {
                    if let Some(bn) = ack.block_num {
                        total_txs += ack.tx_count as u64;
                        progress_reporter
                            .report_progress(bn, total_blocks_for_progress, total_txs)
                            .await?;
                        info!(
                            block = bn,
                            tx_count = ack.tx_count,
                            trace_count = ack.trace_count,
                            transfer_count = ack.transfer_count,
                            total_txs,
                            "Block flushed"
                        );
                    }
                }

                next = buffered.next() => {
                    match next {
                        Some((block_num, Ok((txs, traces, transfers)))) => {
                            cmd_tx
                                .send(WriterCommand::Block {
                                    block_num,
                                    txs,
                                    traces,
                                    transfers,
                                })
                                .await
                                .map_err(|_| eyre::eyre!("Writer channel closed unexpectedly"))?;
                        }
                        Some((block_num, Err(e))) => {
                            error!(block = block_num, error = %e, "Fetch failed after retries");
                            progress_reporter
                                .report_error(&format!("Block {} fetch failed: {}", block_num, e))
                                .await?;
                            cmd_tx
                                .send(WriterCommand::FailedBlock(block_num))
                                .await
                                .map_err(|_| eyre::eyre!("Writer channel closed unexpectedly"))?;
                        }
                        None => {
                            fetch_done = true;
                        }
                    }
                }
            }
        }
    }

    drop(cmd_tx);
    while let Some(ack) = ack_rx.recv().await {
        if let Some(bn) = ack.block_num {
            total_txs += ack.tx_count as u64;
            progress_reporter
                .report_progress(bn, total_blocks_for_progress, total_txs)
                .await?;
            info!(
                block = bn,
                tx_count = ack.tx_count,
                total_txs,
                "Block flushed (drain)"
            );
        }
    }

    let writer = join
        .await
        .map_err(|e| eyre::eyre!("Writer task panicked: {}", e))??;

    Ok((writer, progress_reporter, total_txs))
}
