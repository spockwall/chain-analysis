use crate::types::Transaction;
use eyre::{bail, Result};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tracing::{debug, warn};

use super::hex;

const MAX_RETRIES: u32 = 5;
const INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn fetch_latest_block_number(
    base_url: &str,
    api_key: &str,
    chain_id: u64,
) -> Result<u64> {
    let client = Client::builder().timeout(REQUEST_TIMEOUT).build()?;

    let mut attempt = 0u32;
    let mut backoff = INITIAL_BACKOFF;

    loop {
        attempt += 1;

        let response = client
            .get(base_url)
            .query(&[
                ("chainid", chain_id.to_string()),
                ("module", "proxy".into()),
                ("action", "eth_blockNumber".into()),
                ("apikey", api_key.into()),
            ])
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!("Rate limit exceeded fetching latest block number");
            }
            warn!(attempt, "HTTP 429 fetching latest block, backing off");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !response.status().is_success() {
            bail!("HTTP {} fetching latest block number", response.status());
        }

        let body: Value = response.json().await?;
        let hex_str = body
            .get("result")
            .and_then(|r| r.as_str())
            .ok_or_else(|| eyre::eyre!("Missing result in eth_blockNumber response"))?;

        return hex::hex_to_u64(hex_str);
    }
}

pub async fn fetch_block_transactions(
    base_url: &str,
    api_key: &str,
    chain_id: u64,
    block_number: u64,
) -> Result<Vec<Transaction>> {
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
                ("module", "proxy".into()),
                ("action", "eth_getBlockByNumber".into()),
                ("tag", block_hex.clone()),
                ("boolean", "true".into()),
                ("apikey", api_key.into()),
            ])
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!(
                    "Rate limit exceeded after {} retries for block {}",
                    MAX_RETRIES,
                    block_number
                );
            }
            warn!(block = block_number, attempt, "HTTP 429, backing off");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !response.status().is_success() {
            bail!("HTTP {} for block {}", response.status(), block_number);
        }

        let body: Value = response.json().await?;

        if let Some(s) = body.as_str() {
            if s.contains("Max rate limit reached") {
                if attempt > MAX_RETRIES {
                    bail!(
                        "Rate limit in body after {} retries for block {}",
                        MAX_RETRIES,
                        block_number
                    );
                }
                warn!(block = block_number, attempt, "Rate limit in body string");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        }

        if body.get("status").and_then(|s| s.as_str()) == Some("0") {
            let msg = body.get("message").and_then(|m| m.as_str()).unwrap_or("");
            if msg.to_lowercase().contains("rate limit") {
                if attempt > MAX_RETRIES {
                    bail!(
                        "Rate limit in status after {} retries for block {}",
                        MAX_RETRIES,
                        block_number
                    );
                }
                warn!(block = block_number, attempt, "Rate limit in status field");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        }

        let result = match body.get("result") {
            Some(Value::Object(obj)) => Value::Object(obj.clone()),
            Some(Value::String(s)) if s.to_lowercase().contains("rate limit") => {
                if attempt > MAX_RETRIES {
                    bail!(
                        "Rate limit in result after {} retries for block {}",
                        MAX_RETRIES,
                        block_number
                    );
                }
                warn!(block = block_number, attempt, "Rate limit in result string");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
            Some(Value::String(s)) => {
                bail!("Unexpected string result for block {}: {}", block_number, s);
            }
            _ => {
                warn!(block = block_number, "Empty result, skipping");
                return Ok(Vec::new());
            }
        };

        let block_timestamp = result
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(|t| hex::hex_to_u64(t).unwrap_or(0))
            .unwrap_or(0);

        let transactions = result
            .get("transactions")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        debug!(
            block = block_number,
            tx_count = transactions.len(),
            "Parsed block"
        );

        let mut txs = Vec::with_capacity(transactions.len());
        for raw_tx in &transactions {
            match parse_etherscan_tx(raw_tx, block_number, block_timestamp) {
                Ok(tx) => txs.push(tx),
                Err(e) => {
                    warn!(block = block_number, error = %e, "Skipping unparseable transaction");
                }
            }
        }

        return Ok(txs);
    }
}

fn parse_etherscan_tx(raw: &Value, block_number: u64, block_timestamp: u64) -> Result<Transaction> {
    let hash = raw
        .get("hash")
        .and_then(|h| h.as_str())
        .ok_or_else(|| eyre::eyre!("Missing hash"))?
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
