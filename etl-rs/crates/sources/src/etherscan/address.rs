use types::{Trace, Transaction, Transfer};
use eyre::{bail, Result};
use reqwest::Client;
use serde_json::Value;
use std::future::Future;
use std::time::Duration;
use tracing::{debug, info, warn};

use super::hex;

const MAX_RETRIES: u32 = 5;
const INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const PAGE_SIZE: u32 = 2000;

/// Generic paginator: calls fetcher(page, page_size) starting at page 1,
/// accumulates results until a page returns fewer than page_size items.
pub async fn fetch_all_pages<T, F, Fut>(fetcher: F) -> Result<Vec<T>>
where
    F: Fn(u32, u32) -> Fut,
    Fut: Future<Output = Result<Vec<T>>>,
{
    let mut all = Vec::new();
    let mut page = 1u32;

    loop {
        let batch = fetcher(page, PAGE_SIZE).await?;
        let count = batch.len() as u32;
        all.extend(batch);

        if count < PAGE_SIZE {
            break;
        }

        page += 1;
        info!(page, accumulated = all.len(), "Fetching next page");
    }

    Ok(all)
}

/// Fetch normal transactions for a specific address via Etherscan V2 `txlist`.
#[allow(clippy::too_many_arguments)]
pub async fn fetch_address_transactions(
    base_url: &str,
    api_key: &str,
    chain_id: u64,
    address: &str,
    start_block: u64,
    end_block: u64,
    page: u32,
    offset: u32,
) -> Result<Vec<Transaction>> {
    let client = Client::builder().timeout(REQUEST_TIMEOUT).build()?;

    let mut attempt = 0u32;
    let mut backoff = INITIAL_BACKOFF;

    loop {
        attempt += 1;

        let response = client
            .get(base_url)
            .query(&[
                ("chainid", chain_id.to_string()),
                ("module", "account".into()),
                ("action", "txlist".into()),
                ("address", address.into()),
                ("startblock", start_block.to_string()),
                ("endblock", end_block.to_string()),
                ("page", page.to_string()),
                ("offset", offset.to_string()),
                ("sort", "asc".into()),
                ("apikey", api_key.into()),
            ])
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!("Rate limit exceeded fetching txlist for {}", address);
            }
            warn!(address, attempt, "HTTP 429 fetching txlist, backing off");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !response.status().is_success() {
            bail!("HTTP {} fetching txlist for {}", response.status(), address);
        }

        let body: Value = response.json().await?;

        if body.get("status").and_then(|s| s.as_str()) == Some("0") {
            let msg = body
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("");
            if msg.to_lowercase().contains("rate limit") {
                if attempt > MAX_RETRIES {
                    bail!("Rate limit in txlist response for {}", address);
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
            // "No transactions found" returns status "0"
            return Ok(Vec::new());
        }

        let results = body
            .get("result")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default();

        debug!(
            address,
            page,
            count = results.len(),
            "Fetched address transactions"
        );

        let mut txs = Vec::with_capacity(results.len());
        for raw in &results {
            match parse_account_tx(raw) {
                Ok(tx) => txs.push(tx),
                Err(e) => warn!(address, error = %e, "Skipping unparseable transaction"),
            }
        }

        return Ok(txs);
    }
}

/// Fetch internal transactions for a specific address via Etherscan V2 `txlistinternal`.
#[allow(clippy::too_many_arguments)]
pub async fn fetch_address_internal_txs(
    base_url: &str,
    api_key: &str,
    chain_id: u64,
    address: &str,
    start_block: u64,
    end_block: u64,
    page: u32,
    offset: u32,
) -> Result<Vec<Trace>> {
    let client = Client::builder().timeout(REQUEST_TIMEOUT).build()?;

    let mut attempt = 0u32;
    let mut backoff = INITIAL_BACKOFF;

    loop {
        attempt += 1;

        let response = client
            .get(base_url)
            .query(&[
                ("chainid", chain_id.to_string()),
                ("module", "account".into()),
                ("action", "txlistinternal".into()),
                ("address", address.into()),
                ("startblock", start_block.to_string()),
                ("endblock", end_block.to_string()),
                ("page", page.to_string()),
                ("offset", offset.to_string()),
                ("sort", "asc".into()),
                ("apikey", api_key.into()),
            ])
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!(
                    "Rate limit exceeded fetching internal txs for {}",
                    address
                );
            }
            warn!(address, attempt, "HTTP 429, backing off");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !response.status().is_success() {
            bail!(
                "HTTP {} fetching internal txs for {}",
                response.status(),
                address
            );
        }

        let body: Value = response.json().await?;

        if body.get("status").and_then(|s| s.as_str()) == Some("0") {
            let msg = body
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("");
            if msg.to_lowercase().contains("rate limit") {
                if attempt > MAX_RETRIES {
                    bail!("Rate limit in internal txs response for {}", address);
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

        debug!(
            address,
            page,
            count = results.len(),
            "Fetched address internal transactions"
        );

        let mut traces = Vec::with_capacity(results.len());
        for raw in &results {
            match parse_account_trace(raw) {
                Ok(t) => traces.push(t),
                Err(e) => warn!(address, error = %e, "Skipping unparseable trace"),
            }
        }

        return Ok(traces);
    }
}

/// Fetch ERC-20 token transfers for a specific address via Etherscan V2 `tokentx`.
#[allow(clippy::too_many_arguments)]
pub async fn fetch_address_token_transfers(
    base_url: &str,
    api_key: &str,
    chain_id: u64,
    address: &str,
    start_block: u64,
    end_block: u64,
    page: u32,
    offset: u32,
) -> Result<Vec<Transfer>> {
    let client = Client::builder().timeout(REQUEST_TIMEOUT).build()?;

    let mut attempt = 0u32;
    let mut backoff = INITIAL_BACKOFF;

    loop {
        attempt += 1;

        let response = client
            .get(base_url)
            .query(&[
                ("chainid", chain_id.to_string()),
                ("module", "account".into()),
                ("action", "tokentx".into()),
                ("address", address.into()),
                ("startblock", start_block.to_string()),
                ("endblock", end_block.to_string()),
                ("page", page.to_string()),
                ("offset", offset.to_string()),
                ("sort", "asc".into()),
                ("apikey", api_key.into()),
            ])
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!("Rate limit exceeded fetching token txs for {}", address);
            }
            warn!(address, attempt, "HTTP 429, backing off");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !response.status().is_success() {
            bail!(
                "HTTP {} fetching token txs for {}",
                response.status(),
                address
            );
        }

        let body: Value = response.json().await?;

        if body.get("status").and_then(|s| s.as_str()) == Some("0") {
            let msg = body
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("");
            if msg.to_lowercase().contains("rate limit") {
                if attempt > MAX_RETRIES {
                    bail!("Rate limit in token txs response for {}", address);
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

        debug!(
            address,
            page,
            count = results.len(),
            "Fetched address token transfers"
        );

        let mut transfers = Vec::with_capacity(results.len());
        for raw in &results {
            match parse_account_transfer(raw) {
                Ok(t) => transfers.push(t),
                Err(e) => warn!(address, error = %e, "Skipping unparseable transfer"),
            }
        }

        return Ok(transfers);
    }
}

// ---------------------------------------------------------------------------
// Parsers — Etherscan account API returns DECIMAL strings (not hex)
// ---------------------------------------------------------------------------

fn parse_account_tx(raw: &Value) -> Result<Transaction> {
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

    // txlist returns value as decimal string (wei)
    let value = raw
        .get("value")
        .and_then(|v| v.as_str())
        .unwrap_or("0")
        .to_string();

    let block_number: u64 = raw
        .get("blockNumber")
        .and_then(|b| b.as_str())
        .and_then(|b| b.parse().ok())
        .unwrap_or(0);

    let timestamp: u64 = raw
        .get("timeStamp")
        .and_then(|t| t.as_str())
        .and_then(|t| t.parse().ok())
        .unwrap_or(0);

    let gas_used: u64 = raw
        .get("gasUsed")
        .and_then(|g| g.as_str())
        .and_then(|g| g.parse().ok())
        .unwrap_or(0);

    let gas_price = raw
        .get("gasPrice")
        .and_then(|g| g.as_str())
        .unwrap_or("0")
        .to_string();

    let input = raw
        .get("input")
        .and_then(|i| i.as_str())
        .unwrap_or("0x")
        .to_string();

    let contract_address = raw
        .get("contractAddress")
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty())
        .map(hex::normalize_address)
        .unwrap_or_default();

    Ok(Transaction {
        hash,
        from_address,
        to_address,
        value,
        block_number,
        timestamp,
        gas_used,
        gas_price,
        input,
        contract_address,
    })
}

fn parse_account_trace(raw: &Value) -> Result<Trace> {
    Ok(Trace {
        transaction_hash: raw
            .get("hash")
            .and_then(|h| h.as_str())
            .unwrap_or_default()
            .to_string(),
        from_address: raw
            .get("from")
            .and_then(|f| f.as_str())
            .map(hex::normalize_address)
            .unwrap_or_default(),
        to_address: raw
            .get("to")
            .and_then(|t| t.as_str())
            .map(hex::normalize_address)
            .unwrap_or_default(),
        value: raw
            .get("value")
            .and_then(|v| v.as_str())
            .unwrap_or("0")
            .to_string(),
        trace_type: raw
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("call")
            .to_string(),
        call_type: raw.get("type").and_then(|t| t.as_str()).map(String::from),
        gas: raw
            .get("gas")
            .and_then(|g| g.as_str())
            .and_then(|g| g.parse().ok())
            .unwrap_or(0),
        gas_used: raw
            .get("gasUsed")
            .and_then(|g| g.as_str())
            .and_then(|g| g.parse().ok())
            .unwrap_or(0),
        input: raw
            .get("input")
            .and_then(|i| i.as_str())
            .unwrap_or("0x")
            .to_string(),
        output: String::new(),
        error: raw
            .get("isError")
            .and_then(|e| e.as_str())
            .filter(|e| *e == "1")
            .map(|_| {
                raw.get("errCode")
                    .and_then(|c| c.as_str())
                    .unwrap_or("unknown error")
                    .to_string()
            }),
        block_number: raw
            .get("blockNumber")
            .and_then(|b| b.as_str())
            .and_then(|b| b.parse().ok())
            .unwrap_or(0),
        trace_address: raw
            .get("traceId")
            .and_then(|t| t.as_str())
            .map(|t| {
                t.split('_')
                    .filter_map(|s| s.parse().ok())
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn parse_account_transfer(raw: &Value) -> Result<Transfer> {
    Ok(Transfer {
        transaction_hash: raw
            .get("hash")
            .and_then(|h| h.as_str())
            .unwrap_or_default()
            .to_string(),
        log_index: raw
            .get("logIndex")
            .and_then(|l| l.as_str())
            .and_then(|l| l.parse().ok())
            .or_else(|| {
                raw.get("logIndex")
                    .and_then(|l| l.as_u64())
            })
            .unwrap_or(0),
        token_address: raw
            .get("contractAddress")
            .and_then(|a| a.as_str())
            .map(hex::normalize_address)
            .unwrap_or_default(),
        from_address: raw
            .get("from")
            .and_then(|f| f.as_str())
            .map(hex::normalize_address)
            .unwrap_or_default(),
        to_address: raw
            .get("to")
            .and_then(|t| t.as_str())
            .map(hex::normalize_address)
            .unwrap_or_default(),
        value: raw
            .get("value")
            .and_then(|v| v.as_str())
            .unwrap_or("0")
            .to_string(),
        block_number: raw
            .get("blockNumber")
            .and_then(|b| b.as_str())
            .and_then(|b| b.parse().ok())
            .unwrap_or(0),
        timestamp: raw
            .get("timeStamp")
            .and_then(|t| t.as_str())
            .and_then(|t| t.parse().ok())
            .unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_account_tx_decimal_fields() {
        let raw = serde_json::json!({
            "hash": "0xabc123",
            "from": "0xAAA",
            "to": "0xBBB",
            "value": "1000000000000000000",
            "blockNumber": "18000000",
            "timeStamp": "1700000000",
            "gasUsed": "21000",
            "gasPrice": "30000000000",
            "input": "0x",
            "contractAddress": ""
        });

        let tx = parse_account_tx(&raw).unwrap();
        assert_eq!(tx.hash, "0xabc123");
        assert_eq!(tx.from_address, "0xaaa");
        assert_eq!(tx.to_address, "0xbbb");
        assert_eq!(tx.value, "1000000000000000000");
        assert_eq!(tx.block_number, 18_000_000);
        assert_eq!(tx.timestamp, 1_700_000_000);
        assert_eq!(tx.gas_used, 21000);
        assert_eq!(tx.gas_price, "30000000000");
    }

    #[test]
    fn parse_account_transfer_decimal_fields() {
        let raw = serde_json::json!({
            "hash": "0xdef456",
            "from": "0xAAA",
            "to": "0xBBB",
            "value": "500000000",
            "contractAddress": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            "blockNumber": "18000000",
            "timeStamp": "1700000000",
            "logIndex": "42"
        });

        let transfer = parse_account_transfer(&raw).unwrap();
        assert_eq!(transfer.transaction_hash, "0xdef456");
        assert_eq!(transfer.from_address, "0xaaa");
        assert_eq!(transfer.to_address, "0xbbb");
        assert_eq!(transfer.value, "500000000");
        assert_eq!(
            transfer.token_address,
            "0xdac17f958d2ee523a2206206994597c13d831ec7"
        );
        assert_eq!(transfer.log_index, 42);
    }
}
