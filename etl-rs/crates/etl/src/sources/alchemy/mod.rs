//! Alchemy JSON-RPC [`BlockSource`]. Fetches blocks, receipts, traces, and
//! ERC-20 logs via the standard Ethereum JSON-RPC methods (plus Parity-style
//! `trace_block`). Works with any provider that exposes the same surface
//! (Infura, QuickNode, self-hosted Geth/Reth) by overriding `ALCHEMY_BASE_URL`.

pub mod block;
pub mod logs;
pub mod receipts;
pub mod rpc;
pub mod traces;

use async_trait::async_trait;
use eyre::Result;
use reqwest::Client;
use std::time::Duration;
use crate::types::{Trace, Transaction, Transfer};

use super::block_source::BlockSource;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct AlchemySource {
    client: Client,
    /// Fully-resolved endpoint: `{base_url}{api_key}` (Alchemy uses the key as
    /// a path segment). E.g. `https://eth-mainnet.g.alchemy.com/v2/abc123`.
    url: String,
}

impl AlchemySource {
    pub fn new(base_url: String, api_key: String) -> Self {
        let url = if base_url.ends_with('/') {
            format!("{}{}", base_url, api_key)
        } else {
            format!("{}/{}", base_url, api_key)
        };
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("build reqwest client");
        Self { client, url }
    }
}

/// Tag identifying this source for the rate-limiter bucket. Lives as a
/// const so `&'static str` plumbing matches the alchemy submodule signature.
const PROVIDER: &str = "alchemy";

#[async_trait]
impl BlockSource for AlchemySource {
    fn name(&self) -> &'static str {
        PROVIDER
    }

    async fn latest_block(&self) -> Result<u64> {
        block::eth_block_number(PROVIDER, &self.client, &self.url).await
    }

    async fn fetch_block(&self, block_num: u64) -> Result<Vec<Transaction>> {
        let mut txs =
            block::eth_get_block_by_number(PROVIDER, &self.client, &self.url, block_num).await?;
        // Enrich with receipts (gas_used, contract_address). Non-fatal on failure.
        if let Err(e) =
            receipts::enrich_with_receipts(PROVIDER, &self.client, &self.url, block_num, &mut txs)
                .await
        {
            tracing::warn!(block = block_num, error = %e, "receipt enrichment failed");
        }
        Ok(txs)
    }

    async fn fetch_traces(&self, block_num: u64) -> Result<Vec<Trace>> {
        traces::trace_block(PROVIDER, &self.client, &self.url, block_num).await
    }

    async fn fetch_transfers(&self, block_num: u64) -> Result<Vec<Transfer>> {
        logs::fetch_transfers(PROVIDER, &self.client, &self.url, block_num).await
    }

    async fn fetch_tx_by_hash(&self, tx_hash: &str) -> Result<Option<Transaction>> {
        block::eth_get_transaction_by_hash(PROVIDER, &self.client, &self.url, tx_hash).await
    }
}
