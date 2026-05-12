//! Public, no-API-key JSON-RPC [`BlockSource`]. Designed as the last-resort
//! tier in [`super::failover::FailoverSource`]: when both Etherscan and
//! Alchemy are rate-limited or unhealthy, fall through to a free public
//! endpoint (Ankr, Cloudflare, Llamarpc, ...) so the worker can still make
//! forward progress, albeit on a tighter shared budget.
//!
//! Implementation is a thin shell around the alchemy submodules, which are
//! already provider-agnostic — they speak the standard Ethereum JSON-RPC
//! surface plus Parity-style `trace_block`. Only the URL differs (no API
//! key path segment) and the source name (`"public_rpc"` for metrics).

use async_trait::async_trait;
use eyre::Result;
use reqwest::Client;
use std::time::Duration;

use super::alchemy;
use super::block_source::BlockSource;
use crate::types::{Trace, Transaction, Transfer};

/// Default public RPC endpoint when `PUBLIC_RPC_URL` is unset. Ankr's
/// open multichain endpoint requires no auth and supports `trace_block` on
/// mainnet; it's rate-limited (~1500 req/day per IP) which is fine as a
/// last-resort tier behind paid providers.
pub const DEFAULT_PUBLIC_RPC_URL: &str = "https://rpc.ankr.com/eth";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct PublicRpcSource {
    client: Client,
    url: String,
}

impl PublicRpcSource {
    pub fn new(url: String) -> Self {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("build reqwest client");
        Self { client, url }
    }
}

#[async_trait]
impl BlockSource for PublicRpcSource {
    fn name(&self) -> &'static str {
        "public_rpc"
    }

    async fn latest_block(&self) -> Result<u64> {
        alchemy::block::eth_block_number(&self.client, &self.url).await
    }

    async fn fetch_block(&self, block_num: u64) -> Result<Vec<Transaction>> {
        let mut txs =
            alchemy::block::eth_get_block_by_number(&self.client, &self.url, block_num).await?;
        // Receipt enrichment is best-effort; many public endpoints throttle
        // batch receipt RPCs even when block fetches succeed.
        if let Err(e) =
            alchemy::receipts::enrich_with_receipts(&self.client, &self.url, block_num, &mut txs)
                .await
        {
            tracing::warn!(block = block_num, source = "public_rpc", error = %e, "receipt enrichment failed");
        }
        Ok(txs)
    }

    async fn fetch_traces(&self, block_num: u64) -> Result<Vec<Trace>> {
        alchemy::traces::trace_block(&self.client, &self.url, block_num).await
    }

    async fn fetch_transfers(&self, block_num: u64) -> Result<Vec<Transfer>> {
        alchemy::logs::fetch_transfers(&self.client, &self.url, block_num).await
    }

    async fn fetch_tx_by_hash(&self, tx_hash: &str) -> Result<Option<Transaction>> {
        alchemy::block::eth_get_transaction_by_hash(&self.client, &self.url, tx_hash).await
    }
}
