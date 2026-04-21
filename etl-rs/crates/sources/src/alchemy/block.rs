//! `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionByHash`.

use eyre::Result;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::warn;
use types::Transaction;

use super::rpc;
use crate::etherscan::hex;

pub async fn eth_block_number(client: &Client, url: &str) -> Result<u64> {
    let result = rpc::call(client, url, "eth_blockNumber", json!([])).await?;
    let s = result
        .as_str()
        .ok_or_else(|| eyre::eyre!("eth_blockNumber: expected hex string"))?;
    hex::hex_to_u64(s)
}

pub async fn eth_get_block_by_number(
    client: &Client,
    url: &str,
    block_num: u64,
) -> Result<Vec<Transaction>> {
    let tag = format!("0x{:x}", block_num);
    let result = rpc::call(
        client,
        url,
        "eth_getBlockByNumber",
        json!([tag, true]),
    )
    .await?;

    if result.is_null() {
        warn!(block = block_num, "eth_getBlockByNumber returned null");
        return Ok(Vec::new());
    }

    let block_ts = result
        .get("timestamp")
        .and_then(|t| t.as_str())
        .map(|t| hex::hex_to_u64(t).unwrap_or(0))
        .unwrap_or(0);

    let raw_txs = result
        .get("transactions")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();

    let mut txs = Vec::with_capacity(raw_txs.len());
    for raw in &raw_txs {
        match parse_tx(raw, block_num, block_ts) {
            Ok(tx) => txs.push(tx),
            Err(e) => warn!(block = block_num, error = %e, "skipping unparseable tx"),
        }
    }
    Ok(txs)
}

pub async fn eth_get_transaction_by_hash(
    client: &Client,
    url: &str,
    tx_hash: &str,
) -> Result<Option<Transaction>> {
    let result = rpc::call(
        client,
        url,
        "eth_getTransactionByHash",
        json!([tx_hash]),
    )
    .await?;
    if result.is_null() {
        return Ok(None);
    }
    let block_num = result
        .get("blockNumber")
        .and_then(|v| v.as_str())
        .and_then(|s| hex::hex_to_u64(s).ok())
        .unwrap_or(0);
    Ok(Some(parse_tx(&result, block_num, 0)?))
}

pub(crate) fn parse_tx(raw: &Value, block_number: u64, block_timestamp: u64) -> Result<Transaction> {
    let hash = raw
        .get("hash")
        .and_then(|h| h.as_str())
        .ok_or_else(|| eyre::eyre!("missing hash"))?
        .to_string();

    let from_address = raw
        .get("from")
        .and_then(|f| f.as_str())
        .map(hex::normalize_address)
        .unwrap_or_default();

    let to_address = raw
        .get("to")
        .and_then(|t| t.as_str())
        .map(hex::normalize_address)
        .unwrap_or_default();

    let value = raw
        .get("value")
        .and_then(|v| v.as_str())
        .map(|v| hex::hex_to_u128(v).unwrap_or(0).to_string())
        .unwrap_or_else(|| "0".into());

    let gas_used = raw
        .get("gas")
        .and_then(|g| g.as_str())
        .map(|g| hex::hex_to_u64(g).unwrap_or(0))
        .unwrap_or(0);

    let gas_price = raw
        .get("gasPrice")
        .and_then(|g| g.as_str())
        .map(|g| hex::hex_to_u128(g).unwrap_or(0).to_string())
        .unwrap_or_else(|| "0".into());

    let input = raw
        .get("input")
        .and_then(|i| i.as_str())
        .unwrap_or("0x")
        .to_string();

    Ok(Transaction {
        hash,
        from_address,
        to_address,
        value,
        block_number,
        timestamp: block_timestamp,
        gas_used,
        gas_price,
        input,
        contract_address: String::new(),
    })
}
