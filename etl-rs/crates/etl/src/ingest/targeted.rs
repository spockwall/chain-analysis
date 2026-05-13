use eyre::Result;
use metrics::histogram;
use crate::observability::LABEL_TASK_DURATION_SECONDS;
use crate::pipeline::ProgressReporter;
use serde::Deserialize;
use crate::sinks::postgres_writer::PostgresWriter;
use crate::sinks::redis_stream::TransactionWriter;
use crate::sources::etherscan;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use tracing::{info, warn};
use crate::types::Transaction;

use super::ingest_address_capped;

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
        /// Optional cap on transactions fetched per address. `None` means no
        /// cap (fetch every tx in [from_block, latest]). Used by Task B
        /// refresh to keep whale fetches bounded; user-triggered single
        /// `pipeline/ingest-address` requests still pass `None` to get the
        /// full history.
        tx_limit: Option<usize>,
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
        /// Optional per-address tx cap. Task B refresh sets this so whale
        /// addresses don't time out trying to pull a full history. Web-
        /// triggered runs (`pipeline/ingest-address`) leave it unset for
        /// uncapped behaviour. Defaults to `None` for backward compatibility
        /// with payloads written before this field existed.
        #[serde(default)]
        tx_limit: Option<usize>,
    },
    Hashes {
        hashes: Vec<String>,
    },
    Neighborhood {
        seed: String,
        hops: u8,
    },
}

/// Short static tag describing a `QueuedSpec` variant. Used as a Prometheus
/// label value on `label_task_duration_seconds`, so the histogram can be
/// broken down by mode in Grafana without parsing the JSON payload.
fn spec_kind(spec: &QueuedSpec) -> &'static str {
    match spec {
        QueuedSpec::Addresses { .. } => "addresses",
        QueuedSpec::Hashes { .. } => "hashes",
        QueuedSpec::Neighborhood { .. } => "neighborhood",
    }
}

impl From<QueuedSpec> for TargetSpec {
    fn from(spec: QueuedSpec) -> Self {
        match spec {
            QueuedSpec::Addresses {
                addrs,
                from_block,
                tx_limit,
            } => TargetSpec::Addresses {
                addrs,
                from_block,
                tx_limit,
            },
            QueuedSpec::Hashes { hashes } => TargetSpec::Hashes(hashes),
            QueuedSpec::Neighborhood { seed, hops } => TargetSpec::Neighborhood { seed, hops },
        }
    }
}

/// Execute a targeted fetch. Returns total transactions ingested.
pub async fn run_targeted(
    config: &crate::config::Config,
    spec: TargetSpec,
    writer: &mut Box<dyn TransactionWriter>,
    reporter: &mut ProgressReporter,
    pg_writer: Option<&PostgresWriter>,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    match spec {
        TargetSpec::Addresses {
            addrs,
            from_block,
            tx_limit,
        } => {
            run_addresses(
                config,
                &addrs,
                from_block.unwrap_or(0),
                writer,
                reporter,
                pg_writer,
                with_traces,
                with_transfers,
                tx_limit,
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

#[allow(clippy::too_many_arguments)]
async fn run_addresses(
    config: &crate::config::Config,
    addrs: &[String],
    from_block: u64,
    writer: &mut Box<dyn TransactionWriter>,
    reporter: &mut ProgressReporter,
    pg_writer: Option<&PostgresWriter>,
    with_traces: bool,
    with_transfers: bool,
    tx_limit: Option<usize>,
) -> Result<u64> {
    let mut total = 0u64;
    let run_started = Instant::now();
    for addr in addrs {
        let start = effective_from_block(pg_writer, addr, from_block).await;
        let addr_started = Instant::now();
        info!(
            address = %addr,
            requested_from = from_block,
            effective_from = start,
            ?tx_limit,
            "targeted: fetching address"
        );
        // ingest_address_capped handles both capped (Some(n)) and uncapped
        // (None) — `ingest_address` is just a thin wrapper around the same
        // path with `max_per_kind=None`. Calling it directly keeps the call
        // sites uniform.
        let txs = ingest_address_capped(
            config,
            addr,
            start,
            99_999_999,
            writer,
            reporter,
            with_traces,
            with_transfers,
            tx_limit,
        )
        .await?;
        info!(
            address = %addr,
            tx_count = txs,
            elapsed_ms = addr_started.elapsed().as_millis() as u64,
            "targeted: address done"
        );
        total += txs;
    }
    info!(
        addresses = addrs.len(),
        total_txs = total,
        elapsed_ms = run_started.elapsed().as_millis() as u64,
        "targeted: addresses run done"
    );
    Ok(total)
}

async fn run_hashes(
    config: &crate::config::Config,
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

#[allow(clippy::too_many_arguments)]
async fn run_neighborhood(
    config: &crate::config::Config,
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

    let run_started = Instant::now();
    let mut visited: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = vec![seed.to_lowercase()];
    let mut total = 0u64;

    for hop in 0..=hops {
        if frontier.is_empty() {
            break;
        }
        let hop_started = Instant::now();
        info!(hop, count = frontier.len(), "targeted neighborhood: hop start");
        let mut peer_counts: HashMap<String, u32> = HashMap::new();
        let mut ingest_ms_total: u64 = 0;
        let mut peer_scan_ms_total: u64 = 0;
        let mut addresses_processed: usize = 0;

        for addr in &frontier {
            if !visited.insert(addr.clone()) {
                continue;
            }
            let start = effective_from_block(pg_writer, addr, 0).await;
            let ingest_started = Instant::now();
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
            ingest_ms_total += ingest_started.elapsed().as_millis() as u64;
            addresses_processed += 1;

            if hop < hops {
                let scan_started = Instant::now();
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
                peer_scan_ms_total += scan_started.elapsed().as_millis() as u64;
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

        info!(
            hop,
            addresses_processed,
            ingest_ms_total,
            peer_scan_ms_total,
            elapsed_ms = hop_started.elapsed().as_millis() as u64,
            next_frontier_size = frontier.len(),
            "targeted neighborhood: hop done"
        );
    }

    info!(
        seed = %seed.to_lowercase(),
        hops,
        total_txs = total,
        elapsed_ms = run_started.elapsed().as_millis() as u64,
        "targeted neighborhood: run done"
    );

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

/// Owns the full targeted-fetch lifecycle: picks up a `QueuedTask`, flips
/// `label_tasks` + `ingestion_runs` rows to `running`, runs the spec, then
/// flips the rows to their terminal state. The worker's Task-A loop reduces
/// to `job.execute(task).await`.
pub struct TargetedJob<'a> {
    pub config: &'a crate::config::Config,
    pub pg: &'a PgPool,
    pub writer: &'a mut Box<dyn TransactionWriter>,
    pub reporter: &'a mut ProgressReporter,
    pub pg_writer: Option<&'a PostgresWriter>,
    pub with_traces: bool,
    pub with_transfers: bool,
}

impl<'a> TargetedJob<'a> {
    /// Full lifecycle for a queue payload: pickup → run → terminal. Returns
    /// the number of transactions ingested on success. Records the wall-
    /// clock duration into [`LABEL_TASK_DURATION_SECONDS`] labelled by spec
    /// kind and outcome so dashboards can split deep-trace from single-
    /// address fetches and happy-path latency from failure-path latency.
    pub async fn execute(&mut self, task: QueuedTask) -> Result<u64> {
        let QueuedTask { task_id, run_id, spec } = task;
        info!(?task_id, ?run_id, "Picked up targeted entry");

        let kind = spec_kind(&spec);
        let started = Instant::now();

        Self::mark_pickup(self.pg, task_id, run_id.as_deref()).await;
        let result = run_targeted(
            self.config,
            spec.into(),
            self.writer,
            self.reporter,
            self.pg_writer,
            self.with_traces,
            self.with_transfers,
        )
        .await;
        Self::mark_terminal(self.pg, task_id, run_id.as_deref(), &result).await;

        let outcome = if result.is_ok() { "success" } else { "failure" };
        histogram!(
            LABEL_TASK_DURATION_SECONDS,
            "kind" => kind,
            "outcome" => outcome,
        )
        .record(started.elapsed().as_secs_f64());

        result
    }

    async fn mark_pickup(pg: &PgPool, task_id: Option<i64>, run_id: Option<&str>) {
        if let Some(tid) = task_id {
            // pickup_at = NOW() drives the `label_task_duration_seconds`
            // Prometheus histogram (see observability.rs) and is useful
            // for ad-hoc SQL like "median time spent in queue vs running".
            if let Err(e) = sqlx::query(
                "UPDATE label_tasks
                    SET status='running', pickup_at=NOW(), updated_at=NOW()
                  WHERE id=$1",
            )
            .bind(tid)
            .execute(pg)
            .await
            {
                warn!(task_id = tid, error = %e, "Failed to mark label_task as running");
            }
        }
        if let Some(rid) = run_id {
            if let Err(e) =
                sqlx::query("UPDATE ingestion_runs SET status='running' WHERE run_id=$1")
                    .bind(rid)
                    .execute(pg)
                    .await
            {
                warn!(run_id = rid, error = %e, "Failed to mark ingestion_run as running");
            }
        }
    }

    async fn mark_terminal(
        pg: &PgPool,
        task_id: Option<i64>,
        run_id: Option<&str>,
        result: &Result<u64>,
    ) {
        match result {
            Ok(n) => {
                if let Some(tid) = task_id {
                    if let Err(e) = sqlx::query(
                        "UPDATE label_tasks SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1",
                    )
                    .bind(tid)
                    .execute(pg)
                    .await
                    {
                        warn!(task_id = tid, error = %e, "Failed to mark label_task as completed");
                    }
                }
                if let Some(rid) = run_id {
                    if let Err(e) = sqlx::query(
                        "UPDATE ingestion_runs SET status='completed', transactions_processed=$2, completed_at=NOW() WHERE run_id=$1",
                    )
                    .bind(rid)
                    .bind(*n as i64)
                    .execute(pg)
                    .await
                    {
                        warn!(run_id = rid, error = %e, "Failed to mark ingestion_run as completed");
                    }
                }
                info!(?task_id, ?run_id, transactions = n, "Targeted fetch complete");
            }
            Err(e) => {
                let tag = classify_error(e);
                let msg = format!("{}: {}", tag, e);
                warn!(?task_id, ?run_id, tag, error = %e, "Targeted fetch failed");
                if let Some(rid) = run_id {
                    if let Err(e2) = sqlx::query(
                        "UPDATE ingestion_runs SET status='failed', error_message=$2, completed_at=NOW() WHERE run_id=$1",
                    )
                    .bind(rid)
                    .bind(&msg)
                    .execute(pg)
                    .await
                    {
                        warn!(run_id = rid, error = %e2, "Failed to mark ingestion_run as failed");
                    }
                }
                // label_tasks has no 'failed' enum value — leave as running.
            }
        }
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
            QueuedSpec::Addresses {
                addrs,
                from_block,
                tx_limit,
            } => {
                assert_eq!(addrs, vec!["0xabc", "0xdef"]);
                assert_eq!(from_block, None);
                assert_eq!(tx_limit, None, "missing tx_limit must default to None");
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
    fn queued_spec_parses_addresses_with_tx_limit() {
        let json =
            r#"{"spec":{"mode":"addresses","addrs":["0xabc"],"from_block":1000,"tx_limit":500}}"#;
        let task: QueuedTask = serde_json::from_str(json).unwrap();
        match task.spec {
            QueuedSpec::Addresses {
                from_block,
                tx_limit,
                ..
            } => {
                assert_eq!(from_block, Some(1000));
                assert_eq!(tx_limit, Some(500));
            }
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
