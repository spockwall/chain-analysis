use clap::Parser;
use color_eyre::eyre::Result;
use std::time::Duration;
use tracing::{error, info, warn};

mod address_fetcher;
mod erc20_decoder;
mod etherscan;
mod hex;
mod mock;
mod progress;
mod redis_writer;
mod retry;
mod trace_fetcher;

use redis_writer::{RedisStreamWriter, StdoutWriter, TransactionWriter};
use retry::{with_retry, RetryPolicy};

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

async fn fetch_block(
    config: &chain_analysis_common::Config,
    block_num: u64,
    use_mock: bool,
) -> Result<Vec<chain_analysis_common::Transaction>> {
    if use_mock {
        Ok(mock::generate_mock_block(block_num))
    } else {
        etherscan::fetch_block_transactions(
            &config.etherscan_base_url,
            config.etherscan_api_key.as_deref().unwrap(),
            config.etherscan_chain_id,
            block_num,
        )
        .await
    }
}

async fn get_latest_block(
    config: &chain_analysis_common::Config,
    use_mock: bool,
    hint: u64,
) -> Result<u64> {
    if use_mock {
        Ok(mock::mock_latest_block(hint))
    } else {
        etherscan::fetch_latest_block_number(
            &config.etherscan_base_url,
            config.etherscan_api_key.as_deref().unwrap(),
            config.etherscan_chain_id,
        )
        .await
    }
}

async fn ingest_block(
    config: &chain_analysis_common::Config,
    block_num: u64,
    use_mock: bool,
    writer: &mut Box<dyn TransactionWriter>,
    progress_reporter: &mut progress::ProgressReporter,
    total_txs: &mut u64,
    total_blocks: u64,
    retry_policy: &RetryPolicy,
    with_traces: bool,
    with_transfers: bool,
) -> Result<bool> {
    // Fetch transactions with retry
    let transactions = match with_retry(retry_policy, &format!("fetch_block_{}", block_num), || {
        fetch_block(config, block_num, use_mock)
    })
    .await
    {
        Ok(txs) => txs,
        Err(e) => {
            error!(block = block_num, error = %e, "Failed to fetch block after retries");
            progress_reporter
                .report_error(&format!("Failed to fetch block {}: {}", block_num, e))
                .await?;
            // Record failed block for later retry
            writer.record_failed_block(block_num).await?;
            return Ok(false);
        }
    };

    for tx in &transactions {
        writer.write_transaction(tx).await?;
    }

    // Fetch traces if enabled
    if with_traces && !use_mock {
        match trace_fetcher::fetch_block_traces(
            &config.etherscan_base_url,
            config.etherscan_api_key.as_deref().unwrap(),
            config.etherscan_chain_id,
            block_num,
        )
        .await
        {
            Ok(traces) => {
                for trace in &traces {
                    writer.write_trace(trace).await?;
                }
            }
            Err(e) => {
                warn!(block = block_num, error = %e, "Failed to fetch traces, skipping");
            }
        }
    }

    // Fetch ERC-20 transfers if enabled
    if with_transfers && !use_mock {
        match erc20_decoder::fetch_block_transfers(
            &config.etherscan_base_url,
            config.etherscan_api_key.as_deref().unwrap(),
            config.etherscan_chain_id,
            block_num,
        )
        .await
        {
            Ok(transfers) => {
                for transfer in &transfers {
                    writer.write_transfer(transfer).await?;
                }
            }
            Err(e) => {
                warn!(block = block_num, error = %e, "Failed to fetch transfers, skipping");
            }
        }
    }

    writer.save_cursor(block_num).await?;

    *total_txs += transactions.len() as u64;

    progress_reporter
        .report_progress(block_num, total_blocks, *total_txs)
        .await?;

    info!(
        block = block_num,
        tx_count = transactions.len(),
        total_txs = *total_txs,
        "Processed block"
    );

    Ok(true)
}

async fn ingest_address(
    config: &chain_analysis_common::Config,
    address: &str,
    start_block: u64,
    end_block: u64,
    writer: &mut Box<dyn TransactionWriter>,
    progress_reporter: &mut progress::ProgressReporter,
    with_traces: bool,
    with_transfers: bool,
) -> Result<u64> {
    let base_url = &config.etherscan_base_url;
    let api_key = config
        .etherscan_api_key
        .as_deref()
        .ok_or_else(|| eyre::eyre!("ETHERSCAN_API_KEY required for address mode"))?;
    let chain_id = config.etherscan_chain_id;
    let addr = address.to_lowercase();

    // 1. Fetch all normal transactions
    info!(address = %addr, "Fetching normal transactions");
    let txs = address_fetcher::fetch_all_pages(|page, offset| {
        address_fetcher::fetch_address_transactions(
            base_url, api_key, chain_id, &addr, start_block, end_block, page, offset,
        )
    })
    .await?;

    info!(address = %addr, count = txs.len(), "Fetched normal transactions");
    for tx in &txs {
        writer.write_transaction(tx).await?;
    }
    let total_txs = txs.len() as u64;

    // 2. Fetch internal transactions (traces)
    if with_traces {
        info!(address = %addr, "Fetching internal transactions");
        let traces = address_fetcher::fetch_all_pages(|page, offset| {
            address_fetcher::fetch_address_internal_txs(
                base_url, api_key, chain_id, &addr, start_block, end_block, page, offset,
            )
        })
        .await?;

        info!(address = %addr, count = traces.len(), "Fetched internal transactions");
        for trace in &traces {
            writer.write_trace(trace).await?;
        }
    }

    // 3. Fetch ERC-20 token transfers
    if with_transfers {
        info!(address = %addr, "Fetching token transfers");
        let transfers = address_fetcher::fetch_all_pages(|page, offset| {
            address_fetcher::fetch_address_token_transfers(
                base_url, api_key, chain_id, &addr, start_block, end_block, page, offset,
            )
        })
        .await?;

        info!(address = %addr, count = transfers.len(), "Fetched token transfers");
        for transfer in &transfers {
            writer.write_transfer(transfer).await?;
        }
    }

    progress_reporter
        .report_complete(0, total_txs)
        .await?;

    Ok(total_txs)
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
    let config = chain_analysis_common::Config::from_env();

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
            progress::ProgressReporter::new_dry_run(&cli.run_id)
        } else {
            progress::ProgressReporter::new_redis(&config.redis_url, &cli.run_id).await?
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

    // ─── Block-range mode (original) ────────────────────────────────────
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
        source = %cli.source,
        "Starting ingestion"
    );

    if start_block > end_block {
        info!("start_block > end_block, nothing to ingest in initial range");
        if !cli.follow {
            return Ok(());
        }
    }

    let mut progress_reporter = if cli.dry_run {
        progress::ProgressReporter::new_dry_run(&cli.run_id)
    } else {
        progress::ProgressReporter::new_redis(&config.redis_url, &cli.run_id).await?
    };

    let total_blocks = if start_block <= end_block {
        end_block - start_block + 1
    } else {
        0
    };
    let mut total_txs: u64 = 0;

    // Phase 1: process the initial block range
    if start_block <= end_block {
        for block_num in start_block..=end_block {
            ingest_block(
                &config,
                block_num,
                use_mock,
                &mut writer,
                &mut progress_reporter,
                &mut total_txs,
                total_blocks,
                &retry_policy,
                cli.with_traces,
                cli.with_transfers,
            )
            .await?;
        }
    }

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

    // Phase 2: follow mode
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
                warn!(error = %e, "Failed to fetch latest block number, retrying next cycle");
                continue;
            }
        };

        if latest < cursor {
            continue;
        }

        info!(from = cursor, to = latest, new_blocks = latest - cursor + 1, "New blocks detected");

        for block_num in cursor..=latest {
            ingest_block(
                &config,
                block_num,
                use_mock,
                &mut writer,
                &mut progress_reporter,
                &mut total_txs,
                0,
                &retry_policy,
                cli.with_traces,
                cli.with_transfers,
            )
            .await?;
        }

        cursor = latest + 1;
    }
}
