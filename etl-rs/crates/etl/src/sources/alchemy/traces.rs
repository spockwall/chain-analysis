//! Parity-style `trace_block`. Shape: array of trace entries with `action`
//! (from/to/value/gas/input/callType), `result` (gasUsed/output),
//! `traceAddress`, `transactionHash`, `type`, `blockNumber`, optional `error`.

use eyre::Result;
use reqwest::Client;
use serde_json::{json, Value};
use tracing::warn;
use crate::types::Trace;

use super::rpc;
use super::super::etherscan::hex;

pub async fn trace_block(client: &Client, url: &str, block_num: u64) -> Result<Vec<Trace>> {
    let tag = format!("0x{:x}", block_num);
    let result = rpc::call(client, url, "trace_block", json!([tag])).await?;
    let entries = result.as_array().cloned().unwrap_or_default();

    let mut out = Vec::with_capacity(entries.len());
    for raw in &entries {
        match parse_trace(raw, block_num) {
            Ok(t) => out.push(t),
            Err(e) => warn!(block = block_num, error = %e, "skipping unparseable trace"),
        }
    }
    Ok(out)
}

fn parse_trace(raw: &Value, block_number: u64) -> Result<Trace> {
    let transaction_hash = raw
        .get("transactionHash")
        .and_then(|h| h.as_str())
        .unwrap_or("")
        .to_string();

    let trace_type = raw
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("call")
        .to_string();

    let action = raw.get("action").cloned().unwrap_or(Value::Null);
    let result_obj = raw.get("result").cloned().unwrap_or(Value::Null);

    let from_address = action
        .get("from")
        .and_then(|v| v.as_str())
        .map(hex::normalize_address)
        .unwrap_or_default();

    let to_address = action
        .get("to")
        .and_then(|v| v.as_str())
        .map(hex::normalize_address)
        .unwrap_or_default();

    let value = action
        .get("value")
        .and_then(|v| v.as_str())
        .map(|v| hex::hex_to_u128(v).unwrap_or(0).to_string())
        .unwrap_or_else(|| "0".into());

    let call_type = action
        .get("callType")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let gas = action
        .get("gas")
        .and_then(|v| v.as_str())
        .and_then(|s| hex::hex_to_u64(s).ok())
        .unwrap_or(0);

    let gas_used = result_obj
        .get("gasUsed")
        .and_then(|v| v.as_str())
        .and_then(|s| hex::hex_to_u64(s).ok())
        .unwrap_or(0);

    let input = action
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or("0x")
        .to_string();

    let output = result_obj
        .get("output")
        .and_then(|v| v.as_str())
        .unwrap_or("0x")
        .to_string();

    let error = raw
        .get("error")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let trace_address = raw
        .get("traceAddress")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_u64().map(|n| n as u32))
                .collect::<Vec<u32>>()
        })
        .unwrap_or_default();

    Ok(Trace {
        transaction_hash,
        from_address,
        to_address,
        value,
        trace_type,
        call_type,
        gas,
        gas_used,
        input,
        output,
        error,
        block_number,
        trace_address,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_call_trace() {
        let raw = json!({
            "action": {
                "from": "0xAAA",
                "to": "0xBBB",
                "value": "0x3e8",
                "gas": "0x5208",
                "input": "0x",
                "callType": "call"
            },
            "result": {"gasUsed": "0x5208", "output": "0x"},
            "traceAddress": [0, 1],
            "transactionHash": "0xdeadbeef",
            "type": "call",
            "blockNumber": 123
        });
        let t = parse_trace(&raw, 123).unwrap();
        assert_eq!(t.transaction_hash, "0xdeadbeef");
        assert_eq!(t.from_address, "0xaaa");
        assert_eq!(t.to_address, "0xbbb");
        assert_eq!(t.value, "1000");
        assert_eq!(t.gas, 21_000);
        assert_eq!(t.gas_used, 21_000);
        assert_eq!(t.trace_type, "call");
        assert_eq!(t.call_type.as_deref(), Some("call"));
        assert_eq!(t.trace_address, vec![0, 1]);
    }

    #[test]
    fn parses_error_trace() {
        let raw = json!({
            "action": {"from": "0xa", "to": "0xb", "value": "0x0", "gas": "0x0"},
            "error": "Reverted",
            "traceAddress": [],
            "transactionHash": "0xabc",
            "type": "call"
        });
        let t = parse_trace(&raw, 1).unwrap();
        assert_eq!(t.error.as_deref(), Some("Reverted"));
        assert!(t.trace_address.is_empty());
    }
}
