use async_trait::async_trait;
use eyre::Result;
use crate::types::{Trace, Transaction, Transfer};

/// Provider-agnostic interface for fetching on-chain block data. One impl per
/// data source (Etherscan proxy, Alchemy JSON-RPC, deterministic mock).
#[async_trait]
pub trait BlockSource: Send + Sync {
    fn name(&self) -> &'static str;

    async fn latest_block(&self) -> Result<u64>;

    async fn fetch_block(&self, block_num: u64) -> Result<Vec<Transaction>>;

    async fn fetch_traces(&self, block_num: u64) -> Result<Vec<Trace>>;

    async fn fetch_transfers(&self, block_num: u64) -> Result<Vec<Transfer>>;

    async fn fetch_tx_by_hash(&self, tx_hash: &str) -> Result<Option<Transaction>>;
}

/// Configuration for selecting and constructing a [`BlockSource`].
/// Kept as a plain struct so the `sources` crate stays independent of `config`.
#[derive(Debug, Clone)]
pub struct SourceConfig {
    /// Explicit selection: "etherscan" | "alchemy" | "mock". None → inferred.
    pub ingest_source: Option<String>,
    pub etherscan_api_key: Option<String>,
    pub etherscan_base_url: String,
    pub etherscan_chain_id: u64,
    pub alchemy_api_key: Option<String>,
    pub alchemy_base_url: String,
}

/// Build a `BlockSource` from config. Selection rules:
/// - Explicit `ingest_source` wins.
/// - Unset → "alchemy" if its key is set; else "etherscan" if its key is set; else "mock".
pub fn make_source(cfg: &SourceConfig) -> Result<Box<dyn BlockSource>> {
    let selected = cfg
        .ingest_source
        .as_deref()
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| infer(cfg).to_string());

    match selected.as_str() {
        "mock" => Ok(Box::new(super::mock::MockSource)),
        "etherscan" => {
            let key = cfg
                .etherscan_api_key
                .as_deref()
                .ok_or_else(|| eyre::eyre!("ETHERSCAN_API_KEY required for etherscan source"))?;
            Ok(Box::new(super::etherscan::EtherscanSource::new(
                cfg.etherscan_base_url.clone(),
                key.to_string(),
                cfg.etherscan_chain_id,
            )))
        }
        "alchemy" => {
            let key = cfg
                .alchemy_api_key
                .as_deref()
                .ok_or_else(|| eyre::eyre!("ALCHEMY_API_KEY required for alchemy source"))?;
            Ok(Box::new(super::alchemy::AlchemySource::new(
                cfg.alchemy_base_url.clone(),
                key.to_string(),
            )))
        }
        other => Err(eyre::eyre!("unknown INGEST_SOURCE: {}", other)),
    }
}

fn infer(cfg: &SourceConfig) -> &'static str {
    if cfg.alchemy_api_key.as_deref().is_some_and(|s| !s.is_empty()) {
        "alchemy"
    } else if cfg
        .etherscan_api_key
        .as_deref()
        .is_some_and(|s| !s.is_empty())
    {
        "etherscan"
    } else {
        "mock"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_cfg() -> SourceConfig {
        SourceConfig {
            ingest_source: None,
            etherscan_api_key: None,
            etherscan_base_url: "https://api.etherscan.io/v2/api".into(),
            etherscan_chain_id: 1,
            alchemy_api_key: None,
            alchemy_base_url: "https://eth-mainnet.g.alchemy.com/v2/".into(),
        }
    }

    #[test]
    fn make_source_falls_back_to_mock_when_no_keys() {
        let src = make_source(&base_cfg()).unwrap();
        assert_eq!(src.name(), "mock");
    }

    #[test]
    fn make_source_picks_etherscan_when_key_present_and_source_unset() {
        let mut cfg = base_cfg();
        cfg.etherscan_api_key = Some("abc".into());
        let src = make_source(&cfg).unwrap();
        assert_eq!(src.name(), "etherscan");
    }

    #[test]
    fn make_source_prefers_alchemy_when_both_keys_set_and_source_unset() {
        let mut cfg = base_cfg();
        cfg.etherscan_api_key = Some("abc".into());
        cfg.alchemy_api_key = Some("def".into());
        let src = make_source(&cfg).unwrap();
        assert_eq!(src.name(), "alchemy");
    }

    #[test]
    fn make_source_prefers_explicit_setting() {
        let mut cfg = base_cfg();
        cfg.ingest_source = Some("mock".into());
        cfg.etherscan_api_key = Some("abc".into());
        let src = make_source(&cfg).unwrap();
        assert_eq!(src.name(), "mock");
    }

    #[test]
    fn make_source_errors_when_explicit_alchemy_but_no_key() {
        let mut cfg = base_cfg();
        cfg.ingest_source = Some("alchemy".into());
        assert!(make_source(&cfg).is_err());
    }

    #[test]
    fn make_source_errors_on_unknown_source() {
        let mut cfg = base_cfg();
        cfg.ingest_source = Some("infura".into());
        assert!(make_source(&cfg).is_err());
    }
}
