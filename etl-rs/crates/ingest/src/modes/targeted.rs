use eyre::Result;
use pipeline::ProgressReporter;
use serde::Deserialize;
use sinks::postgres_writer::PostgresWriter;
use sinks::redis_stream::TransactionWriter;
use sources::etherscan;
use std::collections::{HashMap, HashSet};
use tracing::{info, warn};
use types::Transaction;

use crate::{ingest_address, ingest_address_capped};

/// Default cap on transactions fetched per peer during neighborhood BFS.
/// Override with `NEIGHBORHOOD_TX_LIMIT_PER_ADDR`.
const DEFAULT_NEIGHBORHOOD_TX_LIMIT: usize = 500;
/// Default cap on peers expanded per hop (ranked by counterparty frequency).
/// Override with `MAX_PEERS_PER_HOP`.
const DEFAULT_MAX_PEERS_PER_HOP: usize = 20;

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[derive(Clone, Debug)]
pub enum TargetSpec {
    Addresses {
        addrs: Vec<String>,
        /// Earliest block to include. Defaults to 0 when None.
        from_block: Option<u64>,
    },
    Hashes(Vec<String>),
    Neighborhood {
        seed: String,
        hops: u8,
    },
}

/// Queue payload written by the backend (`/api/labels/fetch`,
/// `/api/pipeline/ingest-address`) and by the worker's own refresh loop.
#[derive(Deserialize, Debug)]
pub struct QueuedTask {
    #[serde(default)]
    pub task_id: Option<i64>,
    /// Web-originated runs carry a pre-inserted ingestion_runs row. Label-task
    /// entries and refresh-loop entries omit this field.
    #[serde(default)]
    pub run_id: Option<String>,
    pub spec: QueuedSpec,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum QueuedSpec {
    Addresses {
        addrs: Vec<String>,
        #[serde(default)]
        from_block: Option<u64>,
    },
    Hashes {
        hashes: Vec<String>,
    },
    Neighborhood {
        seed: String,
        hops: u8,
    },
}

impl From<QueuedSpec> for TargetSpec {
    fn from(spec: QueuedSpec) -> Self {
        match spec {
            QueuedSpec::Addresses { addrs, from_block } => {
                TargetSpec::Addresses { addrs, from_block }
            }
            QueuedSpec::Hashes { hashes } => TargetSpec::Hashes(hashes),
            QueuedSpec::Neighborhood { seed, hops } => TargetSpec::Neighborhood { seed, hops },
        }
    }
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
        TargetSpec::Addresses { addrs, from_block } => {
            run_addresses(
                config,
                &addrs,
                from_block.unwrap_or(0),
                writer,
                reporter,
                pg_writer,
                with_traces,
                with_transfers,
            )
            .await
        }
        TargetSpec::Hashes(hashes) => run_hashes(config, &hashes, writer).await,
        TargetSpec::Neighborhood { seed, hops } => {
            run_neighborhood(
                config,
                &seed,
                hops,
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

/// Resolve the effective `from_block` for `addr`: skip history we've already
/// ingested by advancing past `entity_features.last_synced_block`, but never
/// go earlier than the caller-requested floor.
async fn effective_from_block(
    pg_writer: Option<&PostgresWriter>,
    addr: &str,
    requested_from: u64,
) -> u64 {
    let Some(pg) = pg_writer else {
        return requested_from;
    };
    match pg.read_last_synced_blocks(&[addr.to_string()]).await {
        Ok(map) => {
            let synced = map.get(&addr.to_lowercase()).copied().unwrap_or(0);
            let resume = synced.saturating_add(1);
            requested_from.max(resume)
        }
        Err(e) => {
            warn!(address = %addr, error = %e, "read_last_synced_blocks failed, ingesting full range");
            requested_from
        }
    }
}

async fn run_addresses(
    config: &config::Config,
    addrs: &[String],
    from_block: u64,
    writer: &mut Box<dyn TransactionWriter>,
    reporter: &mut ProgressReporter,
    pg_writer: Option<&PostgresWriter>,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    let mut total = 0u64;
    for addr in addrs {
        let start = effective_from_block(pg_writer, addr, from_block).await;
        info!(address = %addr, requested_from = from_block, effective_from = start, "targeted: fetching address");
        total += ingest_address(
            config,
            addr,
            start,
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
    pg_writer: Option<&PostgresWriter>,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    let api_key = config
        .etherscan_api_key
        .as_deref()
        .ok_or_else(|| eyre::eyre!("ETHERSCAN_API_KEY required for neighborhood mode"))?;
    let chain_id = config.etherscan_chain_id;
    let base = &config.etherscan_base_url;

    let tx_limit = env_usize("NEIGHBORHOOD_TX_LIMIT_PER_ADDR", DEFAULT_NEIGHBORHOOD_TX_LIMIT);
    let max_peers = env_usize("MAX_PEERS_PER_HOP", DEFAULT_MAX_PEERS_PER_HOP);
    info!(tx_limit, max_peers, "neighborhood caps");

    let mut visited: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = vec![seed.to_lowercase()];
    let mut total = 0u64;

    for hop in 0..=hops {
        if frontier.is_empty() {
            break;
        }
        info!(hop, count = frontier.len(), "targeted neighborhood: hop");
        let mut peer_counts: HashMap<String, u32> = HashMap::new();

        for addr in &frontier {
            if !visited.insert(addr.clone()) {
                continue;
            }
            let start = effective_from_block(pg_writer, addr, 0).await;
            total += ingest_address_capped(
                config,
                addr,
                start,
                99_999_999,
                writer,
                reporter,
                with_traces,
                with_transfers,
                Some(tx_limit),
            )
            .await?;

            if hop < hops {
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
                                    *peer_counts.entry(p).or_insert(0) += 1;
                                }
                            }
                        }
                    }
                    Err(e) => warn!(address = %addr, error = %e, "counterparty scan failed"),
                }
            }
        }

        // Rank by frequency, keep the top N most-connected peers.
        let mut ranked: Vec<(String, u32)> = peer_counts.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        let kept = ranked.len().min(max_peers);
        if ranked.len() > max_peers {
            info!(
                hop,
                total_candidates = ranked.len(),
                kept,
                "peer cap applied — dropping low-frequency counterparties"
            );
        }
        frontier = ranked.into_iter().take(max_peers).map(|(p, _)| p).collect();
    }

    Ok(total)
}

/// Classify a fetch error into a short tag the frontend can map to an
/// actionable help message (see `RunStatusPill`).
pub fn classify_error(err: &eyre::Report) -> &'static str {
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
            QueuedSpec::Addresses { addrs, from_block } => {
                assert_eq!(addrs, vec!["0xabc", "0xdef"]);
                assert_eq!(from_block, None);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn queued_spec_parses_addresses_with_from_block() {
        let json = r#"{"spec":{"mode":"addresses","addrs":["0xabc"],"from_block":18000000}}"#;
        let task: QueuedTask = serde_json::from_str(json).unwrap();
        match task.spec {
            QueuedSpec::Addresses { from_block, .. } => assert_eq!(from_block, Some(18000000)),
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
