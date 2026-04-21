use eyre::{Context, Result};
use pipeline::ProgressReporter;
use redis::AsyncCommands;
use serde::Deserialize;
use sinks::postgres_writer::PostgresWriter;
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
    /// Web-originated runs carry a pre-inserted ingestion_runs row.
    /// Dagster-sensor drains of label-task entries omit this field and
    /// rely on the labeling workflow tables for progress instead.
    #[serde(default)]
    run_id: Option<String>,
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
    pg_writer: Option<&PostgresWriter>,
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
            run_from_label_tasks(
                config,
                limit,
                writer,
                reporter,
                pg_writer,
                with_traces,
                with_transfers,
            )
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
    pg_writer: Option<&PostgresWriter>,
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

        info!(task_id = ?task.task_id, run_id = ?task.run_id, "Draining targeted queue entry");

        // Transition run row to `running` before we start fetching so the
        // frontend poller can flip the pill out of `queued` within one tick.
        if let (Some(pg), Some(run_id)) = (pg_writer, task.run_id.as_deref()) {
            if let Err(e) = pg
                .update_ingestion_run(run_id, "running", 0, 0, 0, None)
                .await
            {
                warn!(run_id, error = %e, "Failed to mark run as running");
            }
        }

        let spec = match task.spec {
            QueuedSpec::Addresses { addrs } => TargetSpec::Addresses(addrs),
            QueuedSpec::Hashes { hashes } => TargetSpec::Hashes(hashes),
            QueuedSpec::Neighborhood { seed, hops } => TargetSpec::Neighborhood { seed, hops },
        };

        let result = Box::pin(run_targeted(
            config,
            spec,
            writer,
            reporter,
            pg_writer,
            with_traces,
            with_transfers,
        ))
        .await;

        match result {
            Ok(n) => {
                total += n;
                if let (Some(pg), Some(run_id)) = (pg_writer, task.run_id.as_deref()) {
                    if let Err(e) = pg
                        .update_ingestion_run(run_id, "completed", n as i64, 0, 0, None)
                        .await
                    {
                        warn!(run_id, error = %e, "Failed to mark run as completed");
                    }
                }
            }
            Err(e) => {
                let tag = classify_error(&e);
                let msg = format!("{}: {}", tag, e);
                warn!(run_id = ?task.run_id, error = %e, tag, "Targeted fetch failed");
                if let (Some(pg), Some(run_id)) = (pg_writer, task.run_id.as_deref()) {
                    if let Err(e2) = pg
                        .update_ingestion_run(run_id, "failed", 0, 0, 0, Some(&msg))
                        .await
                    {
                        warn!(run_id, error = %e2, "Failed to mark run as failed");
                    }
                }
                // Keep draining remaining queue entries even if one fails;
                // each run tracks its own status independently.
            }
        }
    }

    info!(drained, total, "from-label-tasks complete");
    Ok(total)
}

/// Classify a fetch error into a short tag the frontend can map to an
/// actionable help message (see `RunStatusPill`).
fn classify_error(err: &eyre::Report) -> &'static str {
    let s = format!("{:#}", err).to_lowercase();
    if s.contains("429") || s.contains("rate limit") {
        "rate_limited"
    } else if s.contains("401") || s.contains("403") || s.contains("api key") {
        "auth"
    } else if s.contains("timeout") || s.contains("connection") || s.contains("dns") {
        "network"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_spec_parses_addresses() {
        let json = r#"{"task_id":42,"spec":{"mode":"addresses","addrs":["0xabc","0xdef"]}}"#;
        let task: QueuedTask = serde_json::from_str(json).unwrap();
        assert_eq!(task.task_id, Some(42));
        match task.spec {
            QueuedSpec::Addresses { addrs } => assert_eq!(addrs, vec!["0xabc", "0xdef"]),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn queued_spec_parses_hashes() {
        let json = r#"{"spec":{"mode":"hashes","hashes":["0x1","0x2"]}}"#;
        let task: QueuedTask = serde_json::from_str(json).unwrap();
        assert_eq!(task.task_id, None);
        match task.spec {
            QueuedSpec::Hashes { hashes } => assert_eq!(hashes.len(), 2),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn queued_spec_parses_neighborhood() {
        let json = r#"{"task_id":1,"spec":{"mode":"neighborhood","seed":"0xseed","hops":2}}"#;
        let task: QueuedTask = serde_json::from_str(json).unwrap();
        match task.spec {
            QueuedSpec::Neighborhood { seed, hops } => {
                assert_eq!(seed, "0xseed");
                assert_eq!(hops, 2);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn queued_spec_parses_run_id() {
        let json = r#"{"task_id":null,"run_id":"abc123","spec":{"mode":"addresses","addrs":["0x1"]}}"#;
        let task: QueuedTask = serde_json::from_str(json).unwrap();
        assert_eq!(task.run_id.as_deref(), Some("abc123"));
    }

    #[test]
    fn queued_spec_rejects_unknown_mode() {
        let json = r#"{"spec":{"mode":"garbage","addrs":[]}}"#;
        let err = serde_json::from_str::<QueuedTask>(json);
        assert!(err.is_err());
    }
}
