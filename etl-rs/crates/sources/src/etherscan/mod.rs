pub mod address;
pub mod block;
pub mod erc20;
pub mod traces;
pub mod tx;
pub(crate) mod hex;

use async_trait::async_trait;
use eyre::Result;
use types::{Trace, Transaction, Transfer};

use crate::block_source::BlockSource;

/// BlockSource impl backed by the Etherscan v2 proxy API.
pub struct EtherscanSource {
    base_url: String,
    api_key: String,
    chain_id: u64,
}

impl EtherscanSource {
    pub fn new(base_url: String, api_key: String, chain_id: u64) -> Self {
        Self {
            base_url,
            api_key,
            chain_id,
        }
    }
}

#[async_trait]
impl BlockSource for EtherscanSource {
    fn name(&self) -> &'static str {
        "etherscan"
    }

    async fn latest_block(&self) -> Result<u64> {
        block::fetch_latest_block_number(&self.base_url, &self.api_key, self.chain_id).await
    }

    async fn fetch_block(&self, block_num: u64) -> Result<Vec<Transaction>> {
        block::fetch_block_transactions(&self.base_url, &self.api_key, self.chain_id, block_num)
            .await
    }

    async fn fetch_traces(&self, block_num: u64) -> Result<Vec<Trace>> {
        traces::fetch_block_traces(&self.base_url, &self.api_key, self.chain_id, block_num).await
    }

    async fn fetch_transfers(&self, block_num: u64) -> Result<Vec<Transfer>> {
        erc20::fetch_block_transfers(&self.base_url, &self.api_key, self.chain_id, block_num).await
    }

    async fn fetch_tx_by_hash(&self, tx_hash: &str) -> Result<Option<Transaction>> {
        tx::fetch_by_hash(&self.base_url, &self.api_key, self.chain_id, tx_hash).await
    }
}
