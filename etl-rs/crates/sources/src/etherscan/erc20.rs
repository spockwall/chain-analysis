use types::Transfer;
use eyre::{bail, Result};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tracing::{debug, warn};

use super::hex;

const ERC20_TRANSFER_TOPIC: &str =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const MAX_RETRIES: u32 = 5;
const INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn fetch_block_transfers(
    base_url: &str,
    api_key: &str,
    chain_id: u64,
    block_number: u64,
) -> Result<Vec<Transfer>> {
    let client = Client::builder().timeout(REQUEST_TIMEOUT).build()?;
    let block_hex = format!("0x{:x}", block_number);

    let mut attempt = 0u32;
    let mut backoff = INITIAL_BACKOFF;

    loop {
        attempt += 1;

        let response = client
            .get(base_url)
            .query(&[
                ("chainid", chain_id.to_string()),
                ("module", "logs".into()),
                ("action", "getLogs".into()),
                ("fromBlock", block_hex.clone()),
                ("toBlock", block_hex.clone()),
                ("topic0", ERC20_TRANSFER_TOPIC.into()),
                ("apikey", api_key.into()),
            ])
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!("Rate limit fetching ERC-20 logs for block {}", block_number);
            }
            warn!(block = block_number, attempt, "HTTP 429, backing off");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !response.status().is_success() {
            bail!("HTTP {} fetching ERC-20 logs for block {}", response.status(), block_number);
        }

        let body: Value = response.json().await?;

        if body.get("status").and_then(|s| s.as_str()) == Some("0") {
            let msg = body.get("message").and_then(|m| m.as_str()).unwrap_or("");
            if msg.to_lowercase().contains("rate limit") {
                if attempt > MAX_RETRIES {
                    bail!("Rate limit in ERC-20 logs response for block {}", block_number);
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
            return Ok(Vec::new());
        }

        let results = body
            .get("result")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default();

        debug!(block = block_number, count = results.len(), "Fetched ERC-20 Transfer logs");

        let mut transfers = Vec::with_capacity(results.len());
        for raw in &results {
            match decode_transfer_log(raw) {
                Ok(t) => transfers.push(t),
                Err(e) => debug!(block = block_number, error = %e, "Skipping non-standard Transfer log"),
            }
        }

        return Ok(transfers);
    }
}

fn decode_transfer_log(log: &Value) -> Result<Transfer> {
    let topics = log
        .get("topics")
        .and_then(|t| t.as_array())
        .ok_or_else(|| eyre::eyre!("Missing topics"))?;

    if topics.len() < 3 {
        bail!("Transfer event requires 3 topics, got {}", topics.len());
    }

    let from_address = decode_address_topic(topics[1].as_str().unwrap_or(""));
    let to_address = decode_address_topic(topics[2].as_str().unwrap_or(""));

    let value_hex = log
        .get("data")
        .and_then(|d| d.as_str())
        .unwrap_or("0x0");
    let value = hex::hex_to_u128(value_hex)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "0".into());

    let block_number = log
        .get("blockNumber")
        .and_then(|b| b.as_str())
        .map(|b| hex::hex_to_u64(b).unwrap_or(0))
        .unwrap_or(0);

    let log_index = log
        .get("logIndex")
        .and_then(|l| l.as_str())
        .map(|l| hex::hex_to_u64(l).unwrap_or(0))
        .unwrap_or(0);

    let timestamp = log
        .get("timeStamp")
        .and_then(|t| t.as_str())
        .map(|t| hex::hex_to_u64(t).unwrap_or(0))
        .unwrap_or(0);

    Ok(Transfer {
        transaction_hash: log
            .get("transactionHash")
            .and_then(|h| h.as_str())
            .unwrap_or("")
            .to_string(),
        log_index,
        token_address: log
            .get("address")
            .and_then(|a| a.as_str())
            .map(hex::normalize_address)
            .unwrap_or_default(),
        from_address,
        to_address,
        value,
        block_number,
        timestamp,
    })
}

/// Extract 20-byte address from 32-byte zero-padded topic
fn decode_address_topic(topic: &str) -> String {
    let stripped = topic.strip_prefix("0x").unwrap_or(topic);
    if stripped.len() >= 40 {
        let addr = &stripped[stripped.len() - 40..];
        format!("0x{}", addr.to_lowercase())
    } else if stripped.is_empty() {
        String::new()
    } else {
        format!("0x{}", stripped.to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_address_topic() {
        let topic = "0x000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7";
        assert_eq!(
            decode_address_topic(topic),
            "0xdac17f958d2ee523a2206206994597c13d831ec7"
        );
    }

    #[test]
    fn test_decode_address_topic_short() {
        assert_eq!(decode_address_topic("0xAbCdEf"), "0xabcdef");
    }

    #[test]
    fn test_decode_address_topic_empty() {
        assert_eq!(decode_address_topic(""), "");
    }

    #[test]
    fn test_decode_transfer_log() {
        let log = serde_json::json!({
            "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
            "topics": [
                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            ],
            "data": "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
            "blockNumber": "0x112a880",
            "logIndex": "0x0",
            "transactionHash": "0x0123456789abcdef",
            "timeStamp": "0x65432100"
        });

        let transfer = decode_transfer_log(&log).unwrap();
        assert_eq!(
            transfer.from_address,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            transfer.to_address,
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert_eq!(transfer.value, "1000000000000000000");
        assert_eq!(transfer.block_number, 18_000_000);
        assert_eq!(
            transfer.token_address,
            "0xdac17f958d2ee523a2206206994597c13d831ec7"
        );
    }
}
