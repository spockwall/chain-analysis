use clap::{Parser, Subcommand};
use color_eyre::eyre::Result;
use etl::ingest::reprocess::reprocess_failed_blocks;
use etl::ingest::targeted::{run_targeted, TargetSpec};
use etl::ingest::{get_latest_block, ingest_address, ingest_block_range_pipelined, DynBlockSource};
use etl::pipeline::{install_shutdown, ProgressReporter, RetryPolicy};
use etl::sinks::postgres_writer::PostgresWriter;
use etl::sinks::redis_stream::{RedisStreamWriter, StdoutWriter, TransactionWriter};
use etl::sources::{make_source, SourceConfig};
use std::sync::Arc;
use std::time::Duration;
use tracing::info;

fn build_source(config: &etl::config::Config) -> Result<DynBlockSource> {
    let src_cfg = SourceConfig {
        ingest_source: config.ingest_source.clone(),
        etherscan_api_key: config.etherscan_api_key.clone(),
        etherscan_base_url: config.etherscan_base_url.clone(),
        etherscan_chain_id: config.etherscan_chain_id,
        alchemy_api_key: config.alchemy_api_key.clone(),
        alchemy_base_url: config.alchemy_base_url.clone(),
    };
    let boxed = make_source(&src_cfg)?;
    Ok(Arc::from(boxed))
}

#[derive(Parser)]
#[command(
    name = "ingest",
    about = "Blockchain transaction ingestion worker",
    long_about = "Fetches Ethereum transactions from Etherscan and writes them to Redis Streams.\n\
                  \n\
                  Subcommands (preferred): `ingest block`, `ingest address`, `ingest targeted`,\n\
                  `ingest reprocess-failed`. If no subcommand is given, the legacy flat args\n\
                  (--address / --start-block / --end-block / --follow) are parsed for\n\
                  backwards compatibility."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,

    #[command(flatten)]
    legacy: LegacyArgs,
}

#[derive(clap::Args)]
struct LegacyArgs {
    /// First block to fetch (block mode). Defaults to last saved cursor, or chain tip.
    #[arg(long)]
    start_block: Option<u64>,
    /// Last block to fetch (block mode). Defaults to current chain tip.
    #[arg(long)]
    end_block: Option<u64>,
    /// Keep polling for new blocks after the initial range is processed.
    #[arg(long, default_value_t = false)]
    follow: bool,
    /// Seconds between block polls in follow mode.
    #[arg(long, default_value_t = 12)]
    poll_interval: u64,
    /// How many block fetches to keep in flight concurrently.
    #[arg(long, default_value_t = 5)]
    fetch_concurrency: usize,
    /// Ethereum address to fetch (enables address mode).
    #[arg(long)]
    address: Option<String>,
    /// Earliest block to include when fetching by address.
    #[arg(long, default_value_t = 0)]
    addr_start_block: u64,
    /// Latest block to include when fetching by address.
    #[arg(long, default_value_t = 99_999_999)]
    addr_end_block: u64,
    /// Also fetch internal transactions (traces).
    #[arg(long, default_value_t = false)]
    with_traces: bool,
    /// Also fetch ERC-20 token transfers.
    #[arg(long, default_value_t = false)]
    with_transfers: bool,
    /// Print fetched data to stdout instead of writing to Redis.
    #[arg(long, default_value_t = false)]
    dry_run: bool,
    /// Label used for the Redis cursor key.
    #[arg(long, default_value = "etherscan")]
    source: String,
    /// Max retries per Etherscan request.
    #[arg(long, default_value_t = 5)]
    max_retries: u32,
    /// Initial retry backoff in seconds.
    #[arg(long, default_value_t = 1)]
    retry_backoff_secs: u64,
    /// Unique identifier for this run.
    #[arg(long, default_value_t = uuid::Uuid::new_v4().to_string())]
    run_id: String,
}

#[derive(Subcommand)]
enum Cmd {
    /// Fetch a block range via Etherscan proxy APIs (falls back to mock data without an API key).
    Block {
        #[arg(long)]
        start: Option<u64>,
        #[arg(long)]
        end: Option<u64>,
        #[arg(long, default_value_t = false)]
        follow: bool,
        #[arg(long, default_value_t = 12)]
        poll_interval: u64,
        #[arg(long, default_value_t = 5)]
        fetch_concurrency: usize,
        #[arg(long, default_value_t = false)]
        with_traces: bool,
        #[arg(long, default_value_t = false)]
        with_transfers: bool,
        #[arg(long, default_value_t = false)]
        dry_run: bool,
        #[arg(long, default_value = "etherscan")]
        source: String,
    },
    /// Fetch all transactions for a single address.
    Address {
        addr: String,
        #[arg(long, default_value_t = 0)]
        start: u64,
        #[arg(long, default_value_t = 99_999_999)]
        end: u64,
        #[arg(long, default_value_t = false)]
        with_traces: bool,
        #[arg(long, default_value_t = false)]
        with_transfers: bool,
        #[arg(long, default_value_t = false)]
        dry_run: bool,
        #[arg(long, default_value = "etherscan")]
        source: String,
    },
    /// Drain `ingest:failed_blocks:{source}` by re-fetching each block.
    ReprocessFailed {
        #[arg(long, default_value = "etherscan")]
        source: String,
        #[arg(long, default_value_t = 5)]
        fetch_concurrency: usize,
        #[arg(long, default_value_t = false)]
        with_traces: bool,
        #[arg(long, default_value_t = false)]
        with_transfers: bool,
    },
    /// Targeted fetching for manual labeling workflows.
    Targeted {
        #[command(subcommand)]
        mode: TargetedMode,
    },
    /// Inspect, replay, or drop messages stuck in a DLQ stream.
    Dlq {
        #[command(subcommand)]
        action: DlqAction,
    },
}

#[derive(Subcommand)]
enum DlqAction {
    /// Print up to `--limit` entries from `{stream}{suffix}`.
    List {
        /// Original stream name; the DLQ name is `{stream}{suffix}`.
        #[arg(long)]
        stream: String,
        #[arg(long, default_value = "_dlq")]
        suffix: String,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Re-`XADD` DLQ entries onto their original stream, then `XDEL` from DLQ.
    Replay {
        #[arg(long)]
        stream: String,
        #[arg(long, default_value = "_dlq")]
        suffix: String,
        /// Replay only this DLQ entry id (e.g. `1700000000000-0`).
        #[arg(long, conflicts_with = "all")]
        id: Option<String>,
        /// Replay every entry in the DLQ.
        #[arg(long, default_value_t = false)]
        all: bool,
        /// Cap the number of entries replayed when `--all` is set.
        #[arg(long)]
        max: Option<usize>,
    },
    /// Permanently delete DLQ entries (the original is already ACKed and gone).
    Drop {
        #[arg(long)]
        stream: String,
        #[arg(long, default_value = "_dlq")]
        suffix: String,
        #[arg(long, conflicts_with = "all")]
        id: Option<String>,
        #[arg(long, default_value_t = false)]
        all: bool,
    },
}

#[derive(Subcommand)]
enum TargetedMode {
    /// Fetch transactions for a comma-separated list of addresses.
    Addresses {
        #[arg(long, value_delimiter = ',')]
        addrs: Vec<String>,
        #[arg(long, default_value_t = false)]
        with_traces: bool,
        #[arg(long, default_value_t = false)]
        with_transfers: bool,
    },
    /// Fetch specific transactions by hash.
    Hashes {
        #[arg(long, value_delimiter = ',')]
        hashes: Vec<String>,
    },
    /// BFS a neighborhood around a seed address up to N hops.
    Neighborhood {
        seed: String,
        #[arg(long, default_value_t = 1)]
        hops: u8,
        #[arg(long, default_value_t = false)]
        with_traces: bool,
        #[arg(long, default_value_t = false)]
        with_transfers: bool,
    },
}


async fn make_writer(
    dry_run: bool,
    redis_url: &str,
    source: &str,
    maxlen: Option<u64>,
) -> Result<Box<dyn TransactionWriter>> {
    if dry_run {
        Ok(Box::new(StdoutWriter))
    } else {
        Ok(Box::new(
            RedisStreamWriter::connect(redis_url, source, maxlen).await?,
        ))
    }
}

async fn make_reporter(
    dry_run: bool,
    redis_url: &str,
    run_id: &str,
) -> Result<ProgressReporter> {
    if dry_run {
        Ok(ProgressReporter::new_dry_run(run_id))
    } else {
        Ok(ProgressReporter::new_redis(redis_url, run_id).await?)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    let _tracing_guard = etl::logging::init_tracing("ingest");

    let metrics_port = std::env::var("METRICS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(etl::observability::DEFAULT_METRICS_PORT);
    etl::observability::init_best_effort("ingest", metrics_port);

    let cli = Cli::parse();
    let config = etl::config::Config::from_env();
    let run_id = uuid::Uuid::new_v4().to_string();

    match cli.cmd {
        Some(Cmd::Block {
            start,
            end,
            follow,
            poll_interval,
            fetch_concurrency,
            with_traces,
            with_transfers,
            dry_run,
            source,
        }) => {
            let block_source = build_source(&config)?;
            run_block_mode(
                &config,
                block_source,
                &run_id,
                start,
                end,
                follow,
                poll_interval,
                fetch_concurrency,
                with_traces,
                with_transfers,
                dry_run,
                &source,
            )
            .await
        }
        Some(Cmd::Address {
            addr,
            start,
            end,
            with_traces,
            with_transfers,
            dry_run,
            source,
        }) => {
            run_address_mode(
                &config,
                &run_id,
                &addr,
                start,
                end,
                with_traces,
                with_transfers,
                dry_run,
                &source,
            )
            .await
        }
        Some(Cmd::ReprocessFailed {
            source,
            fetch_concurrency,
            with_traces,
            with_transfers,
        }) => {
            let block_source = build_source(&config)?;
            let provider = block_source.name();
            let writer = make_writer(false, &config.redis_url, &source, config.stream_maxlen).await?;
            let reporter = make_reporter(false, &config.redis_url, &run_id).await?;
            let retry_policy = RetryPolicy::default();
            let (_w, _r, ok, txs) = reprocess_failed_blocks(
                &config,
                &source,
                block_source,
                writer,
                reporter,
                &retry_policy,
                with_traces,
                with_transfers,
                fetch_concurrency,
            )
            .await?;
            info!(provider, reprocessed = ok, transactions = txs, "reprocess-failed done");
            Ok(())
        }
        Some(Cmd::Targeted { mode }) => run_targeted_mode(&config, &run_id, mode).await,
        Some(Cmd::Dlq { action }) => run_dlq_action(&config, action).await,
        None => run_legacy(cli.legacy, &config).await,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_block_mode(
    config: &etl::config::Config,
    block_source: DynBlockSource,
    run_id: &str,
    start: Option<u64>,
    end: Option<u64>,
    follow: bool,
    poll_interval: u64,
    fetch_concurrency: usize,
    with_traces: bool,
    with_transfers: bool,
    dry_run: bool,
    source: &str,
) -> Result<()> {
    let provider = block_source.name();
    info!(provider, "Block ingestion using data source");
    // When the CLI user passes a custom `--source` label we honor it for the
    // Redis cursor key; otherwise prefer the provider name so mock runs don't
    // collide with real ingestion cursors.
    let source_label = if source == "etherscan" { provider } else { source };

    let retry_policy = RetryPolicy::default();

    let mut writer = make_writer(dry_run, &config.redis_url, source_label, config.stream_maxlen).await?;

    let start_block = match start {
        Some(sb) => sb,
        None => match writer.get_cursor().await? {
            Some(last) => {
                info!(last_ingested = last, resuming_from = last + 1, "Resuming from Redis cursor");
                last + 1
            }
            None => {
                let latest = get_latest_block(block_source.as_ref()).await?;
                info!(latest_block = latest, "No cursor found, starting from chain tip");
                latest
            }
        },
    };

    let end_block = match end {
        Some(eb) => eb,
        None => {
            let latest = get_latest_block(block_source.as_ref()).await?;
            info!(latest_block = latest, "No --end specified, using chain tip");
            latest
        }
    };

    info!(
        %run_id,
        start_block, end_block, follow, dry_run,
        with_traces, with_transfers, fetch_concurrency,
        "Starting block ingestion"
    );

    let progress_reporter = make_reporter(dry_run, &config.redis_url, run_id).await?;

    let total_blocks = if start_block <= end_block { end_block - start_block + 1 } else { 0 };

    let (mut writer, mut progress_reporter, mut total_txs) = ingest_block_range_pipelined(
        block_source.clone(),
        start_block,
        end_block,
        writer,
        progress_reporter,
        &retry_policy,
        with_traces,
        with_transfers,
        fetch_concurrency,
        total_blocks,
        0,
    )
    .await?;

    if !follow {
        progress_reporter.report_complete(total_blocks, total_txs).await?;
        info!(%run_id, blocks = total_blocks, transactions = total_txs, "Ingestion complete");
        return Ok(());
    }

    let poll = Duration::from_secs(poll_interval);
    let mut cursor = end_block + 1;
    info!(poll_interval_secs = poll_interval, next_block = cursor, "Entering follow mode (SIGINT/SIGTERM to stop)");

    let mut shutdown = install_shutdown();
    loop {
        if shutdown.is_shutdown() {
            info!("Shutdown signal received, exiting follow loop");
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep(poll) => {}
            _ = shutdown.wait() => break,
        }

        let latest = match get_latest_block(block_source.as_ref()).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(error = %e, "Failed to fetch latest block number, retrying next cycle");
                continue;
            }
        };
        if latest < cursor {
            continue;
        }
        info!(from = cursor, to = latest, new_blocks = latest - cursor + 1, "New blocks detected");

        let (w, r, txs_after) = ingest_block_range_pipelined(
            block_source.clone(), cursor, latest, writer, progress_reporter,
            &retry_policy, with_traces, with_transfers, fetch_concurrency, 0, total_txs,
        )
        .await?;

        writer = w;
        progress_reporter = r;
        total_txs = txs_after;
        cursor = latest + 1;
    }

    progress_reporter.report_complete(0, total_txs).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_address_mode(
    config: &etl::config::Config,
    run_id: &str,
    addr: &str,
    start: u64,
    end: u64,
    with_traces: bool,
    with_transfers: bool,
    dry_run: bool,
    source: &str,
) -> Result<()> {
    let mut writer = make_writer(dry_run, &config.redis_url, source, config.stream_maxlen).await?;
    let mut progress_reporter = make_reporter(dry_run, &config.redis_url, run_id).await?;

    let total = ingest_address(
        config,
        addr,
        start,
        end,
        &mut writer,
        &mut progress_reporter,
        with_traces,
        with_transfers,
    )
    .await?;

    info!(%addr, transactions = total, "Address ingestion complete");
    Ok(())
}

async fn run_targeted_mode(
    config: &etl::config::Config,
    run_id: &str,
    mode: TargetedMode,
) -> Result<()> {
    let (spec, with_traces, with_transfers) = match mode {
        TargetedMode::Addresses { addrs, with_traces, with_transfers } => (
            TargetSpec::Addresses { addrs, from_block: None },
            with_traces,
            with_transfers,
        ),
        TargetedMode::Hashes { hashes } => (TargetSpec::Hashes(hashes), false, false),
        TargetedMode::Neighborhood { seed, hops, with_traces, with_transfers } => {
            (TargetSpec::Neighborhood { seed, hops }, with_traces, with_transfers)
        }
    };

    let mut writer = make_writer(false, &config.redis_url, "etherscan", config.stream_maxlen).await?;
    let mut reporter = make_reporter(false, &config.redis_url, run_id).await?;

    // Optional: if DATABASE_URL is set, emit ingestion_runs transitions for
    // queued entries that carry a `run_id` (e.g. web-triggered fetches).
    let pg_writer = match config.postgres_url.as_deref() {
        Some(url) => match sqlx::PgPool::connect(url).await {
            Ok(pool) => Some(PostgresWriter::new(pool)),
            Err(e) => {
                tracing::warn!(error = %e, "ingestion_runs updates disabled: PG connect failed");
                None
            }
        },
        None => None,
    };

    let total = run_targeted(
        config,
        spec,
        &mut writer,
        &mut reporter,
        pg_writer.as_ref(),
        with_traces,
        with_transfers,
    )
    .await?;
    info!(transactions = total, "Targeted ingestion complete");
    Ok(())
}

async fn redis_conn(redis_url: &str) -> Result<redis::aio::MultiplexedConnection> {
    let client = redis::Client::open(redis_url)?;
    Ok(client.get_multiplexed_async_connection().await?)
}

fn truncate_for_display(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…(+{}B)", &s[..max], s.len() - max)
    }
}

async fn run_dlq_action(
    config: &etl::config::Config,
    action: DlqAction,
) -> Result<()> {
    use etl::dlq::{
        dlq_len, dlq_stream_name, drop_all, drop_entry, list_dlq, replay_all, replay_entry,
    };

    let mut conn = redis_conn(&config.redis_url).await?;

    match action {
        DlqAction::List { stream, suffix, limit } => {
            let dlq = dlq_stream_name(&stream, &suffix);
            let total = dlq_len(&mut conn, &dlq).await?;
            let entries = list_dlq(&mut conn, &dlq, Some(limit)).await?;
            println!("DLQ {} (XLEN={}, showing {})", dlq, total, entries.len());
            for e in &entries {
                let orig = e.original_id().unwrap_or("-");
                let summary: Vec<String> = e
                    .fields
                    .iter()
                    .filter(|(k, _)| k != "original_id")
                    .map(|(k, v)| format!("{}={}", k, truncate_for_display(v, 80)))
                    .collect();
                println!("  {}\torig={}\t{}", e.id, orig, summary.join(" "));
            }
            Ok(())
        }
        DlqAction::Replay { stream, suffix, id, all, max } => {
            let dlq = dlq_stream_name(&stream, &suffix);
            match (id, all) {
                (Some(target), false) => {
                    let entries = list_dlq(&mut conn, &dlq, None).await?;
                    let entry = entries
                        .into_iter()
                        .find(|e| e.id == target)
                        .ok_or_else(|| eyre::eyre!("DLQ entry {} not found in {}", target, dlq))?;
                    let new_id = replay_entry(&mut conn, &dlq, &stream, &entry).await?;
                    info!(dlq = %dlq, original = %stream, replayed_as = %new_id, "replayed 1 entry");
                    println!("replayed {} → {} as {}", entry.id, stream, new_id);
                    Ok(())
                }
                (None, true) => {
                    let n = replay_all(&mut conn, &dlq, &stream, max).await?;
                    println!("replayed {} entries from {} → {}", n, dlq, stream);
                    Ok(())
                }
                _ => Err(eyre::eyre!(
                    "replay: pass exactly one of --id <ID> or --all"
                )),
            }
        }
        DlqAction::Drop { stream, suffix, id, all } => {
            let dlq = dlq_stream_name(&stream, &suffix);
            match (id, all) {
                (Some(target), false) => {
                    let removed = drop_entry(&mut conn, &dlq, &target).await?;
                    println!(
                        "{} {} from {}",
                        if removed { "dropped" } else { "no-op (not found):" },
                        target,
                        dlq
                    );
                    Ok(())
                }
                (None, true) => {
                    let n = drop_all(&mut conn, &dlq).await?;
                    println!("dropped {} entries from {}", n, dlq);
                    Ok(())
                }
                _ => Err(eyre::eyre!(
                    "drop: pass exactly one of --id <ID> or --all"
                )),
            }
        }
    }
}

/// Legacy flat-arg path: if no subcommand is given, dispatch exactly as the
/// pre-subcommand binary did (address vs block mode).
async fn run_legacy(args: LegacyArgs, config: &etl::config::Config) -> Result<()> {
    if let Some(addr) = args.address {
        run_address_mode(
            config,
            &args.run_id,
            &addr,
            args.addr_start_block,
            args.addr_end_block,
            args.with_traces,
            args.with_transfers,
            args.dry_run,
            &args.source,
        )
        .await
    } else {
        let block_source = build_source(config)?;
        run_block_mode(
            config,
            block_source,
            &args.run_id,
            args.start_block,
            args.end_block,
            args.follow,
            args.poll_interval,
            args.fetch_concurrency,
            args.with_traces,
            args.with_transfers,
            args.dry_run,
            &args.source,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn cli_parses_block_subcommand() {
        let cli = Cli::try_parse_from(["ingest", "block", "--start", "10", "--end", "15"]).unwrap();
        match cli.cmd {
            Some(Cmd::Block { start, end, follow, .. }) => {
                assert_eq!(start, Some(10));
                assert_eq!(end, Some(15));
                assert!(!follow);
            }
            other => panic!("wrong variant: {:?}", other.is_some()),
        }
    }

    #[test]
    fn cli_parses_targeted_addresses_csv() {
        let cli = Cli::try_parse_from([
            "ingest",
            "targeted",
            "addresses",
            "--addrs",
            "0xa,0xb,0xc",
        ])
        .unwrap();
        match cli.cmd {
            Some(Cmd::Targeted {
                mode: TargetedMode::Addresses { addrs, .. },
            }) => assert_eq!(addrs, vec!["0xa", "0xb", "0xc"]),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn cli_parses_targeted_neighborhood_default_hops() {
        let cli = Cli::try_parse_from(["ingest", "targeted", "neighborhood", "0xseed"]).unwrap();
        match cli.cmd {
            Some(Cmd::Targeted {
                mode: TargetedMode::Neighborhood { seed, hops, .. },
            }) => {
                assert_eq!(seed, "0xseed");
                assert_eq!(hops, 1);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn cli_parses_reprocess_failed_default_source() {
        let cli = Cli::try_parse_from(["ingest", "reprocess-failed"]).unwrap();
        match cli.cmd {
            Some(Cmd::ReprocessFailed { source, .. }) => assert_eq!(source, "etherscan"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn cli_parses_dlq_list() {
        let cli = Cli::try_parse_from([
            "ingest", "dlq", "list", "--stream", "ingested_txs", "--limit", "10",
        ])
        .unwrap();
        match cli.cmd {
            Some(Cmd::Dlq {
                action: DlqAction::List { stream, suffix, limit },
            }) => {
                assert_eq!(stream, "ingested_txs");
                assert_eq!(suffix, "_dlq");
                assert_eq!(limit, 10);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn cli_parses_dlq_replay_all() {
        let cli = Cli::try_parse_from([
            "ingest", "dlq", "replay", "--stream", "ingested_txs", "--all",
        ])
        .unwrap();
        match cli.cmd {
            Some(Cmd::Dlq {
                action: DlqAction::Replay { all, id, .. },
            }) => {
                assert!(all);
                assert!(id.is_none());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn cli_dlq_replay_id_and_all_conflict() {
        let res = Cli::try_parse_from([
            "ingest", "dlq", "replay", "--stream", "s", "--id", "1-0", "--all",
        ]);
        assert!(res.is_err(), "id and all should conflict");
    }

    #[test]
    fn cli_parses_legacy_flat_args() {
        let cli = Cli::try_parse_from([
            "ingest",
            "--address",
            "0xabcdef",
            "--with-traces",
            "--dry-run",
        ])
        .unwrap();
        assert!(cli.cmd.is_none());
        assert_eq!(cli.legacy.address.as_deref(), Some("0xabcdef"));
        assert!(cli.legacy.with_traces);
        assert!(cli.legacy.dry_run);
    }
}
