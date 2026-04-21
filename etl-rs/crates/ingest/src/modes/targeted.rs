use eyre::{Context, Result};
use pipeline::ProgressReporter;
use redis::AsyncCommands;
use serde::Deserialize;
use sinks::redis_stream::TransactionWriter;
use sources::etherscan;
use std::collections::HashSet;
use tracing::{info, warn};
use types::Transaction;

use crate::ingest_address;

#[derive(Clone, Debug)]
pub enum TargetSpec {
    Addresses(Vec<String>),
    Hashes(Vec<String>),
    Neighborhood { seed: String, hops: u8 },
    FromLabelTasks { limit: u32 },
}

#[derive(Deserialize, Debug)]
struct QueuedTask {
    #[serde(default)]
    task_id: Option<i64>,
    spec: QueuedSpec,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum QueuedSpec {
    Addresses { addrs: Vec<String> },
    Hashes { hashes: Vec<String> },
    Neighborhood { seed: String, hops: u8 },
}

/// Execute a targeted fetch. Returns total transactions ingested.
pub async fn run_targeted(
    config: &config::Config,
    spec: TargetSpec,
    writer: &mut Box<dyn TransactionWriter>,
    reporter: &mut ProgressReporter,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    match spec {
        TargetSpec::Addresses(addrs) => {
            run_addresses(config, &addrs, writer, reporter, with_traces, with_transfers).await
        }
        TargetSpec::Hashes(hashes) => run_hashes(config, &hashes, writer).await,
        TargetSpec::Neighborhood { seed, hops } => {
            run_neighborhood(
                config,
                &seed,
                hops,
                writer,
                reporter,
                with_traces,
                with_transfers,
            )
            .await
        }
        TargetSpec::FromLabelTasks { limit } => {
            run_from_label_tasks(config, limit, writer, reporter, with_traces, with_transfers)
                .await
        }
    }
}

async fn run_addresses(
    config: &config::Config,
    addrs: &[String],
    writer: &mut Box<dyn TransactionWriter>,
    reporter: &mut ProgressReporter,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    let mut total = 0u64;
    for addr in addrs {
        info!(address = %addr, "targeted: fetching address");
        total += ingest_address(
            config,
            addr,
            0,
            99_999_999,
            writer,
            reporter,
            with_traces,
            with_transfers,
        )
        .await?;
    }
    Ok(total)
}

async fn run_hashes(
    config: &config::Config,
    hashes: &[String],
    writer: &mut Box<dyn TransactionWriter>,
) -> Result<u64> {
    let api_key = config
        .etherscan_api_key
        .as_deref()
        .ok_or_else(|| eyre::eyre!("ETHERSCAN_API_KEY required for hash mode"))?;

    let mut txs: Vec<Transaction> = Vec::with_capacity(hashes.len());
    for h in hashes {
        match etherscan::tx::fetch_by_hash(
            &config.etherscan_base_url,
            api_key,
            config.etherscan_chain_id,
            h,
        )
        .await
        {
            Ok(Some(tx)) => txs.push(tx),
            Ok(None) => warn!(tx_hash = %h, "tx not found on chain"),
            Err(e) => warn!(tx_hash = %h, error = %e, "tx fetch failed, skipping"),
        }
    }

    let count = txs.len() as u64;
    writer.write_transactions_batch(&txs).await?;
    info!(count, "targeted: wrote tx batch from hashes");
    Ok(count)
}

async fn run_neighborhood(
    config: &config::Config,
    seed: &str,
    hops: u8,
    writer: &mut Box<dyn TransactionWriter>,
    reporter: &mut ProgressReporter,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    let api_key = config
        .etherscan_api_key
        .as_deref()
        .ok_or_else(|| eyre::eyre!("ETHERSCAN_API_KEY required for neighborhood mode"))?;
    let chain_id = config.etherscan_chain_id;
    let base = &config.etherscan_base_url;

    let mut visited: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = vec![seed.to_lowercase()];
    let mut total = 0u64;

    for hop in 0..=hops {
        if frontier.is_empty() {
            break;
        }
        info!(hop, count = frontier.len(), "targeted neighborhood: hop");
        let mut next: HashSet<String> = HashSet::new();

        for addr in &frontier {
            if !visited.insert(addr.clone()) {
                continue;
            }
            total += ingest_address(
                config,
                addr,
                0,
                99_999_999,
                writer,
                reporter,
                with_traces,
                with_transfers,
            )
            .await?;

            if hop < hops {
                // Collect counterparties from Etherscan page-1 txlist (cheap).
                match etherscan::address::fetch_address_transactions(
                    base,
                    api_key,
                    chain_id,
                    addr,
                    0,
                    99_999_999,
                    1,
                    100,
                )
                .await
                {
                    Ok(txs) => {
                        for tx in txs {
                            for peer in [tx.from_address, tx.to_address] {
                                let p = peer.to_lowercase();
                                if !p.is_empty() && !visited.contains(&p) {
                                    next.insert(p);
                                }
                            }
                        }
                    }
                    Err(e) => warn!(address = %addr, error = %e, "counterparty scan failed"),
                }
            }
        }

        frontier = next.into_iter().collect();
    }

    Ok(total)
}

async fn run_from_label_tasks(
    config: &config::Config,
    limit: u32,
    writer: &mut Box<dyn TransactionWriter>,
    reporter: &mut ProgressReporter,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    let client = redis::Client::open(config.redis_url.clone())?;
    let mut conn = client.get_multiplexed_async_connection().await?;
    let queue = &config.targeted_queue_key;
    let mut total = 0u64;
    let mut drained = 0u32;

    while drained < limit {
        let payload: Option<String> = conn
            .rpop(queue, None)
            .await
            .with_context(|| format!("RPOP {}", queue))?;
        let Some(payload) = payload else {
            break;
        };
        drained += 1;

        let task: QueuedTask = match serde_json::from_str(&payload) {
            Ok(t) => t,
            Err(e) => {
                warn!(error = %e, payload, "Skipping malformed queued task");
                continue;
            }
        };

        info!(task_id = ?task.task_id, "Draining targeted queue entry");
        let spec = match task.spec {
            QueuedSpec::Addresses { addrs } => TargetSpec::Addresses(addrs),
            QueuedSpec::Hashes { hashes } => TargetSpec::Hashes(hashes),
            QueuedSpec::Neighborhood { seed, hops } => TargetSpec::Neighborhood { seed, hops },
        };

        total +=
            Box::pin(run_targeted(config, spec, writer, reporter, with_traces, with_transfers))
                .await?;
    }

    info!(drained, total, "from-label-tasks complete");
    Ok(total)
}
