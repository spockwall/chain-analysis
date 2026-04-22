use eyre::{bail, Result};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tracing::warn;
use crate::types::Transaction;

use super::hex;

const MAX_RETRIES: u32 = 5;
const INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Fetch a single transaction by hash via Etherscan `proxy/eth_getTransactionByHash`.
/// Returns `Ok(None)` if Etherscan reports no such transaction.
pub async fn fetch_by_hash(
    base_url: &str,
    api_key: &str,
    chain_id: u64,
    tx_hash: &str,
) -> Result<Option<Transaction>> {
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
                ("action", "eth_getTransactionByHash".into()),
                ("txhash", tx_hash.to_string()),
                ("apikey", api_key.into()),
            ])
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!("Rate limit exceeded fetching tx {}", tx_hash);
            }
            warn!(tx_hash, attempt, "HTTP 429 fetching tx, backing off");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !response.status().is_success() {
            bail!("HTTP {} fetching tx {}", response.status(), tx_hash);
        }

        let body: Value = response.json().await?;
        let raw = match body.get("result") {
            Some(Value::Object(_)) => body["result"].clone(),
            Some(Value::Null) | None => return Ok(None),
            other => bail!("Unexpected result for tx {}: {:?}", tx_hash, other),
        };

        let block_number = raw
            .get("blockNumber")
            .and_then(|v| v.as_str())
            .and_then(|s| hex::hex_to_u64(s).ok())
            .unwrap_or(0);

        return Ok(Some(parse(&raw, block_number)?));
    }
}

fn parse(raw: &Value, block_number: u64) -> Result<Transaction> {
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
        // Etherscan's eth_getTransactionByHash does not include a timestamp;
        // callers needing it should enrich via block lookup. Keep 0 for now.
        timestamp: 0,
        gas_used,
        gas_price,
        input,
        contract_address: String::new(),
    })
}
