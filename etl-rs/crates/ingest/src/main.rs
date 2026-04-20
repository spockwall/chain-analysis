use ingest::{get_latest_block, ingest_address, ingest_block_range_pipelined};
use pipeline::{ProgressReporter, RetryPolicy};
use sinks::redis_stream::{RedisStreamWriter, StdoutWriter, TransactionWriter};
use clap::Parser;
use color_eyre::eyre::Result;
use std::time::Duration;
use tracing::info;

#[derive(Parser)]
#[command(
    name = "ingest",
    about = "Blockchain transaction ingestion worker",
    long_about = "Fetches Ethereum transactions from Etherscan and writes them to Redis Streams.\n\
                  \n\
                  Two modes:\n\
                  \n\
                  ADDRESS MODE  (--address 0x...)\n\
                    Fetches all transactions for a specific address via Etherscan account APIs.\n\
                    Requires ETHERSCAN_API_KEY. No mock fallback.\n\
                  \n\
                  BLOCK MODE  (--start-block N --end-block M)\n\
                    Fetches all transactions in a block range via Etherscan proxy APIs.\n\
                    Falls back to deterministic mock data when ETHERSCAN_API_KEY is not set.\n\
                  \n\
                  After running ingest, run the `process` binary to consume Redis → Neo4j + PostgreSQL."
)]
struct Cli {
    // ── Block-range mode ─────────────────────────────────────────────────────

    /// First block to fetch (block mode). Defaults to last saved cursor, or chain tip if no cursor.
    #[arg(long)]
    start_block: Option<u64>,

    /// Last block to fetch (block mode). Defaults to current chain tip.
    #[arg(long)]
    end_block: Option<u64>,

    /// Keep polling for new blocks after the initial range is processed (block mode only).
    #[arg(long, default_value_t = false)]
    follow: bool,

    /// Seconds between block polls in follow mode.
    #[arg(long, default_value_t = 12)]
    poll_interval: u64,

    /// How many block fetches to keep in flight concurrently (block mode).
    #[arg(long, default_value_t = 5)]
    fetch_concurrency: usize,

    // ── Address mode ─────────────────────────────────────────────────────────

    /// Ethereum address to fetch (enables address mode). Requires ETHERSCAN_API_KEY.
    #[arg(long)]
    address: Option<String>,

    /// Earliest block to include when fetching by address (address mode).
    #[arg(long, default_value_t = 0)]
    addr_start_block: u64,

    /// Latest block to include when fetching by address (address mode, default = latest).
    #[arg(long, default_value_t = 99_999_999)]
    addr_end_block: u64,

    // ── Data options ─────────────────────────────────────────────────────────

    /// Also fetch internal transactions (traces) — both modes.
    #[arg(long, default_value_t = false)]
    with_traces: bool,

    /// Also fetch ERC-20 token transfers — both modes.
    #[arg(long, default_value_t = false)]
    with_transfers: bool,

    // ── Output / behaviour ───────────────────────────────────────────────────

    /// Print fetched data to stdout instead of writing to Redis (testing).
    #[arg(long, default_value_t = false)]
    dry_run: bool,

    /// Label used for the Redis cursor key (identifies which source last ran).
    #[arg(long, default_value = "etherscan")]
    source: String,

    /// Max retries per Etherscan request before giving up.
    #[arg(long, default_value_t = 5)]
    max_retries: u32,

    /// Initial retry backoff in seconds (doubles on each retry, capped at 30s).
    #[arg(long, default_value_t = 1)]
    retry_backoff_secs: u64,

    /// Unique identifier for this run (auto-generated UUID if not set).
    #[arg(long, default_value_t = uuid::Uuid::new_v4().to_string())]
    run_id: String,
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
    let config = config::Config::from_env();

    let use_mock = config.etherscan_api_key.is_none();
    if use_mock {
        info!("No ETHERSCAN_API_KEY set; using mock data");
    }

    let source = if use_mock { "mock" } else { &cli.source };

    let retry_policy = RetryPolicy {
        max_retries: cli.max_retries,
        initial_backoff: Duration::from_secs(cli.retry_backoff_secs),
        ..RetryPolicy::default()
    };

    let mut writer: Box<dyn TransactionWriter> = if cli.dry_run {
        Box::new(StdoutWriter)
    } else {
        Box::new(RedisStreamWriter::connect(&config.redis_url, source).await?)
    };

    // ─── Address mode ───────────────────────────────────────────────────
    if let Some(ref address) = cli.address {
        info!(
            address = %address,
            start_block = cli.addr_start_block,
            end_block = cli.addr_end_block,
            with_traces = cli.with_traces,
            with_transfers = cli.with_transfers,
            "Starting address ingestion"
        );

        let mut progress_reporter = if cli.dry_run {
            ProgressReporter::new_dry_run(&cli.run_id)
        } else {
            ProgressReporter::new_redis(&config.redis_url, &cli.run_id).await?
        };

        let total = ingest_address(
            &config,
            address,
            cli.addr_start_block,
            cli.addr_end_block,
            &mut writer,
            &mut progress_reporter,
            cli.with_traces,
            cli.with_transfers,
        )
        .await?;

        info!(address = %address, transactions = total, "Address ingestion complete");
        return Ok(());
    }

    // ─── Block-range mode ────────────────────────────────────────────────
    let start_block = match cli.start_block {
        Some(sb) => sb,
        None => {
            if let Some(last) = writer.get_cursor().await? {
                let resume = last + 1;
                info!(last_ingested = last, resuming_from = resume, "Resuming from Redis cursor");
                resume
            } else {
                let latest = get_latest_block(&config, use_mock, 0).await?;
                info!(latest_block = latest, "No cursor found, starting from chain tip");
                latest
            }
        }
    };

    let end_block = match cli.end_block {
        Some(eb) => eb,
        None => {
            let latest = get_latest_block(&config, use_mock, start_block).await?;
            info!(latest_block = latest, "No --end-block specified, using chain tip");
            latest
        }
    };

    info!(
        run_id = %cli.run_id,
        start_block, end_block,
        follow = cli.follow,
        dry_run = cli.dry_run,
        with_traces = cli.with_traces,
        with_transfers = cli.with_transfers,
        fetch_concurrency = cli.fetch_concurrency,
        source = %cli.source,
        "Starting ingestion (pipelined)"
    );

    if start_block > end_block {
        info!("start_block > end_block, nothing to ingest in initial range");
        if !cli.follow {
            return Ok(());
        }
    }

    let progress_reporter = if cli.dry_run {
        ProgressReporter::new_dry_run(&cli.run_id)
    } else {
        ProgressReporter::new_redis(&config.redis_url, &cli.run_id).await?
    };

    let total_blocks = if start_block <= end_block {
        end_block - start_block + 1
    } else {
        0
    };

    // Initial range — pipelined fetch + batched writer task.
    let (mut writer, mut progress_reporter, mut total_txs) = ingest_block_range_pipelined(
        &config,
        start_block,
        end_block,
        use_mock,
        writer,
        progress_reporter,
        &retry_policy,
        cli.with_traces,
        cli.with_transfers,
        cli.fetch_concurrency,
        total_blocks,
        0,
    )
    .await?;

    if !cli.follow {
        progress_reporter
            .report_complete(total_blocks, total_txs)
            .await?;
        info!(
            run_id = %cli.run_id,
            blocks = total_blocks,
            transactions = total_txs,
            "Ingestion complete"
        );
        return Ok(());
    }

    // ─── Follow mode ────────────────────────────────────────────────────
    let poll = Duration::from_secs(cli.poll_interval);
    let mut cursor = end_block + 1;

    info!(
        poll_interval_secs = cli.poll_interval,
        next_block = cursor,
        "Entering follow mode (Ctrl+C to stop)"
    );

    loop {
        tokio::time::sleep(poll).await;

        let latest = match get_latest_block(&config, use_mock, start_block).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(error = %e, "Failed to fetch latest block number, retrying next cycle");
                continue;
            }
        };

        if latest < cursor {
            continue;
        }

        info!(
            from = cursor,
            to = latest,
            new_blocks = latest - cursor + 1,
            "New blocks detected"
        );

        // Reuse writer + reporter across cycles by passing/receiving ownership.
        let (w, r, txs_after) = ingest_block_range_pipelined(
            &config,
            cursor,
            latest,
            use_mock,
            writer,
            progress_reporter,
            &retry_policy,
            cli.with_traces,
            cli.with_transfers,
            cli.fetch_concurrency,
            0,
            total_txs,
        )
        .await?;

        writer = w;
        progress_reporter = r;
        total_txs = txs_after;
        cursor = latest + 1;
    }
}
