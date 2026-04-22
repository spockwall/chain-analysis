//! Live Alchemy integration tests. Gated on `E2E_ALCHEMY_API_KEY`.
//!
//! ```sh
//! E2E_ALCHEMY_API_KEY=... cargo test -p sources --test alchemy_live -- --nocapture
//! ```
//!
//! The cross-provider equivalence case additionally requires
//! `E2E_ETHERSCAN_API_KEY`; it compares tx-hash sets for a historic mainnet
//! block fetched via both sources.

use etl::sources::BlockSource;
use etl::sources::alchemy::AlchemySource;
use etl::sources::etherscan::EtherscanSource;

const KNOWN_BLOCK: u64 = 18_000_000;

fn alchemy_key() -> Option<String> {
    std::env::var("E2E_ALCHEMY_API_KEY").ok()
}
fn etherscan_key() -> Option<String> {
    std::env::var("E2E_ETHERSCAN_API_KEY").ok()
}

#[tokio::test]
async fn alchemy_fetches_known_block() {
    let Some(key) = alchemy_key() else {
        eprintln!("E2E_ALCHEMY_API_KEY unset — skipping");
        return;
    };

    let src = AlchemySource::new(
        "https://eth-mainnet.g.alchemy.com/v2/".into(),
        key,
    );

    let txs = src
        .fetch_block(KNOWN_BLOCK)
        .await
        .expect("alchemy fetch_block");

    assert!(!txs.is_empty(), "block {} should have txs", KNOWN_BLOCK);
    assert_eq!(txs[0].block_number, KNOWN_BLOCK);
}

#[tokio::test]
async fn alchemy_and_etherscan_agree_on_tx_count() {
    let (Some(a_key), Some(e_key)) = (alchemy_key(), etherscan_key()) else {
        eprintln!("E2E_ALCHEMY_API_KEY and/or E2E_ETHERSCAN_API_KEY unset — skipping");
        return;
    };

    let alch = AlchemySource::new(
        "https://eth-mainnet.g.alchemy.com/v2/".into(),
        a_key,
    );
    let ether = EtherscanSource::new(
        "https://api.etherscan.io/v2/api".into(),
        e_key,
        1,
    );

    let (a_txs, e_txs) = tokio::join!(
        alch.fetch_block(KNOWN_BLOCK),
        ether.fetch_block(KNOWN_BLOCK)
    );
    let a_txs = a_txs.expect("alchemy fetch_block");
    let e_txs = e_txs.expect("etherscan fetch_block");

    assert_eq!(
        a_txs.len(),
        e_txs.len(),
        "tx count mismatch: alchemy={} etherscan={}",
        a_txs.len(),
        e_txs.len()
    );

    let a_set: std::collections::HashSet<_> = a_txs.iter().map(|t| t.hash.to_lowercase()).collect();
    for t in &e_txs {
        assert!(
            a_set.contains(&t.hash.to_lowercase()),
            "tx {} from etherscan missing in alchemy result",
            t.hash
        );
    }
}
