use crate::types::Trace;
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

pub async fn fetch_block_traces(
    base_url: &str,
    api_key: &str,
    chain_id: u64,
    block_number: u64,
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
                ("startblock", block_number.to_string()),
                ("endblock", block_number.to_string()),
                ("sort", "asc".into()),
                ("apikey", api_key.into()),
            ])
            .send()
            .await?;

        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!(
                    "Rate limit exceeded fetching traces for block {}",
                    block_number
                );
            }
            warn!(
                block = block_number,
                attempt, "HTTP 429 fetching traces, backing off"
            );
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !response.status().is_success() {
            bail!(
                "HTTP {} fetching traces for block {}",
                response.status(),
                block_number
            );
        }

        let body: Value = response.json().await?;

        if body.get("status").and_then(|s| s.as_str()) == Some("0") {
            let msg = body.get("message").and_then(|m| m.as_str()).unwrap_or("");
            if msg.to_lowercase().contains("rate limit") {
                if attempt > MAX_RETRIES {
                    bail!("Rate limit in traces response for block {}", block_number);
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
            // "No internal transactions found" returns status "0" too
            return Ok(Vec::new());
        }

        let results = body
            .get("result")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default();

        debug!(
            block = block_number,
            count = results.len(),
            "Fetched internal transactions"
        );

        let mut traces = Vec::with_capacity(results.len());
        for raw in &results {
            match parse_trace(raw, block_number) {
                Ok(t) => traces.push(t),
                Err(e) => warn!(block = block_number, error = %e, "Skipping unparsable trace"),
            }
        }

        return Ok(traces);
    }
}

fn parse_trace(raw: &Value, block_number: u64) -> Result<Trace> {
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
        block_number,
        trace_address: raw
            .get("traceId")
            .and_then(|t| t.as_str())
            .map(|t| t.split('_').filter_map(|s| s.parse().ok()).collect())
            .unwrap_or_default(),
    })
}
