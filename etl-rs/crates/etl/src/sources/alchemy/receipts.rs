//! `eth_getBlockReceipts` — batch-fetches all receipts for a block and joins
//! `gasUsed` / `contractAddress` back into the transactions produced by
//! `eth_getBlockByNumber`.

use eyre::Result;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashMap;
use crate::types::Transaction;

use super::rpc;
use super::super::etherscan::hex;

pub async fn enrich_with_receipts(
    provider: &'static str,
    client: &Client,
    url: &str,
    block_num: u64,
    txs: &mut [Transaction],
) -> Result<()> {
    if txs.is_empty() {
        return Ok(());
    }
    let tag = format!("0x{:x}", block_num);
    let result = rpc::call(provider, client, url, "eth_getBlockReceipts", json!([tag])).await?;
    let receipts = result.as_array().cloned().unwrap_or_default();

    // Map tx_hash → (gasUsed, contractAddress)
    let mut by_hash: HashMap<String, (u64, String)> = HashMap::with_capacity(receipts.len());
    for r in &receipts {
        let Some(hash) = r.get("transactionHash").and_then(Value::as_str) else {
            continue;
        };
        let gas_used = r
            .get("gasUsed")
            .and_then(Value::as_str)
            .and_then(|s| hex::hex_to_u64(s).ok())
            .unwrap_or(0);
        let contract_addr = r
            .get("contractAddress")
            .and_then(Value::as_str)
            .map(hex::normalize_address)
            .unwrap_or_default();
        by_hash.insert(hash.to_string(), (gas_used, contract_addr));
    }

    for tx in txs.iter_mut() {
        if let Some((gas_used, contract_addr)) = by_hash.get(&tx.hash) {
            tx.gas_used = *gas_used;
            tx.contract_address = contract_addr.clone();
        }
    }
    Ok(())
}
