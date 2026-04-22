//! Thin JSON-RPC envelope over reqwest. Handles 429 retries with exponential
//! backoff (same policy as Etherscan), extracts the `result` or `error` field.

use eyre::{bail, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tracing::warn;

const MAX_RETRIES: u32 = 5;
const INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(5);

/// Single JSON-RPC call. Returns the raw `result` Value.
///
/// Errors if the response contains an `error` object or HTTP status is
/// non-success after retries.
pub async fn call(client: &Client, url: &str, method: &str, params: Value) -> Result<Value> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });

    let mut attempt = 0u32;
    let mut backoff = INITIAL_BACKOFF;

    loop {
        attempt += 1;
        let resp = client.post(url).json(&body).send().await?;

        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt > MAX_RETRIES {
                bail!("rate limit exceeded for JSON-RPC method {}", method);
            }
            warn!(method, attempt, "HTTP 429, backing off");
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            continue;
        }

        if !resp.status().is_success() {
            bail!(
                "HTTP {} calling JSON-RPC method {}",
                resp.status(),
                method
            );
        }

        let envelope: Value = resp.json().await?;
        return parse_envelope(envelope, method);
    }
}

pub(crate) fn parse_envelope(envelope: Value, method: &str) -> Result<Value> {
    if let Some(err) = envelope.get("error") {
        let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("<no message>");
        bail!("JSON-RPC error for {}: code={} message={}", method, code, msg);
    }
    envelope
        .get("result")
        .cloned()
        .ok_or_else(|| eyre::eyre!("missing result field for {}", method))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_parses_success() {
        let env = json!({"jsonrpc":"2.0","id":1,"result":"0x112a880"});
        let r = parse_envelope(env, "eth_blockNumber").unwrap();
        assert_eq!(r.as_str(), Some("0x112a880"));
    }

    #[test]
    fn envelope_surfaces_error() {
        let env = json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}});
        let e = parse_envelope(env, "eth_blockNumber").unwrap_err();
        let msg = format!("{}", e);
        assert!(msg.contains("-32000"), "got: {}", msg);
        assert!(msg.contains("boom"), "got: {}", msg);
    }

    #[test]
    fn envelope_missing_result_errors() {
        let env = json!({"jsonrpc":"2.0","id":1});
        assert!(parse_envelope(env, "eth_blockNumber").is_err());
    }
}
