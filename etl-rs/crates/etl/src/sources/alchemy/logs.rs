//! `eth_getLogs` filtered to ERC-20 Transfer logs for a single block.
//!
//! Transfer signature: `Transfer(address,address,uint256)` →
//! topic0 = `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`.
//! Indexed `from` / `to` land in topics[1] / topics[2] (left-padded to 32 bytes),
//! value is the raw `data` field (hex uint256).

use eyre::Result;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::warn;
use crate::types::Transfer;

use super::rpc;
use super::super::etherscan::hex;

pub const TRANSFER_TOPIC0: &str =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

pub async fn fetch_transfers(
    provider: &'static str,
    client: &Client,
    url: &str,
    block_num: u64,
) -> Result<Vec<Transfer>> {
    let tag = format!("0x{:x}", block_num);
    let params = json!([{
        "fromBlock": tag,
        "toBlock": tag,
        "topics": [TRANSFER_TOPIC0],
    }]);
    let result = rpc::call(provider, client, url, "eth_getLogs", params).await?;
    let entries = result.as_array().cloned().unwrap_or_default();

    let mut out = Vec::with_capacity(entries.len());
    for raw in &entries {
        match parse_transfer_log(raw) {
            Ok(Some(t)) => out.push(t),
            Ok(None) => {} // not a 3-topic Transfer (skip ERC-721 or malformed)
            Err(e) => warn!(block = block_num, error = %e, "skipping unparseable log"),
        }
    }
    Ok(out)
}

pub(crate) fn parse_transfer_log(raw: &Value) -> Result<Option<Transfer>> {
    let topics = raw
        .get("topics")
        .and_then(|t| t.as_array())
        .ok_or_else(|| eyre::eyre!("missing topics"))?;

    // ERC-20 Transfer has exactly 3 topics: [sig, from, to]. ERC-721 has 4
    // (last topic is tokenId). Skip anything that doesn't match ERC-20 shape.
    if topics.len() != 3 {
        return Ok(None);
    }

    let token_address = raw
        .get("address")
        .and_then(|v| v.as_str())
        .map(hex::normalize_address)
        .unwrap_or_default();

    let from_address = topic_to_address(topics[1].as_str().unwrap_or_default());
    let to_address = topic_to_address(topics[2].as_str().unwrap_or_default());

    let data = raw.get("data").and_then(|v| v.as_str()).unwrap_or("0x");
    let value = hex_u256_to_decimal(data);

    let transaction_hash = raw
        .get("transactionHash")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let log_index = raw
        .get("logIndex")
        .and_then(|v| v.as_str())
        .and_then(|s| hex::hex_to_u64(s).ok())
        .unwrap_or(0);

    let block_number = raw
        .get("blockNumber")
        .and_then(|v| v.as_str())
        .and_then(|s| hex::hex_to_u64(s).ok())
        .unwrap_or(0);

    Ok(Some(Transfer {
        transaction_hash,
        log_index,
        token_address,
        from_address,
        to_address,
        value,
        block_number,
        timestamp: 0,
    }))
}

/// 32-byte topic → 20-byte hex address. Strips `0x` and the 24-hex-char
/// zero-padding, re-prefixes with `0x`.
fn topic_to_address(topic: &str) -> String {
    let stripped = topic.strip_prefix("0x").unwrap_or(topic);
    if stripped.len() < 40 {
        return hex::normalize_address(topic);
    }
    // last 40 hex chars = 20 bytes
    let addr = &stripped[stripped.len() - 40..];
    format!("0x{}", addr.to_lowercase())
}

/// Decode a hex uint256 (`0x...` up to 64 hex chars) to a decimal string.
/// Values beyond u128 saturate at u128::MAX with a warn log — matches the
/// ClickHouse u128 writer caveat documented in the README.
fn hex_u256_to_decimal(raw: &str) -> String {
    let stripped = raw.strip_prefix("0x").unwrap_or(raw);
    if stripped.is_empty() {
        return "0".into();
    }
    if stripped.len() <= 32 {
        // Fits in u128 guaranteed.
        return hex::hex_to_u128(raw).unwrap_or(0).to_string();
    }
    // Longer than u128: take the low 32 hex chars (low 128 bits). Warn once —
    // full U256 preservation is a later enhancement, see ClickHouse u128 caveat.
    let tail = &stripped[stripped.len() - 32..];
    match u128::from_str_radix(tail, 16) {
        Ok(v) => {
            tracing::warn!(value = raw, "Transfer value exceeds u128; storing low 128 bits");
            v.to_string()
        }
        Err(_) => {
            tracing::warn!(value = raw, "unparseable Transfer value, storing 0");
            "0".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_erc20_transfer_log() {
        let raw = json!({
            "address": "0xDAC17F958D2ee523a2206206994597C13D831ec7",
            "topics": [
                TRANSFER_TOPIC0,
                "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            ],
            "data": "0x00000000000000000000000000000000000000000000000000000000000f4240",
            "blockNumber": "0x112a880",
            "transactionHash": "0xdeadbeef",
            "logIndex": "0x3"
        });
        let t = parse_transfer_log(&raw).unwrap().unwrap();
        assert_eq!(t.token_address, "0xdac17f958d2ee523a2206206994597c13d831ec7");
        assert_eq!(t.from_address, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(t.to_address, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        assert_eq!(t.value, "1000000");
        assert_eq!(t.block_number, 18_000_000);
        assert_eq!(t.log_index, 3);
    }

    #[test]
    fn skips_erc721_four_topic_transfer() {
        let raw = json!({
            "address": "0xabc",
            "topics": [TRANSFER_TOPIC0, "0x0", "0x0", "0x0"],
            "data": "0x",
            "blockNumber": "0x1",
            "transactionHash": "0xaa",
            "logIndex": "0x0"
        });
        let r = parse_transfer_log(&raw).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn large_value_truncates_to_u128() {
        // 33 hex nybbles → exceeds u128. Should warn and take low 128 bits.
        let raw = json!({
            "address": "0xabc",
            "topics": [
                TRANSFER_TOPIC0,
                "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            ],
            "data": "0x1ffffffffffffffffffffffffffffffff",
            "blockNumber": "0x1",
            "transactionHash": "0xaa",
            "logIndex": "0x0"
        });
        let t = parse_transfer_log(&raw).unwrap().unwrap();
        // low 128 bits of 0x1ffffffffffffffffffffffffffffffff = 0xffffffffffffffffffffffffffffffff
        assert_eq!(t.value, u128::MAX.to_string());
    }
}
