//! ClickHouse analytical sink. Strict ethereum-etl / BigQuery column names.
//!
//! Writes into `chain_analysis.transactions`, `chain_analysis.traces`, and
//! `chain_analysis.token_transfers` using the `clickhouse` crate's native-
//! protocol `insert()` API with `Row`-derived row structs.
//!
//! Notes:
//! - `value` and `gas_price` columns are declared `UInt256` in the schema,
//!   but this writer sends them as `u128`. Every real ETH tx fits in 2^128-1
//!   (max whale tx ~ 10^24 wei; u128 caps at ~3.4·10^38). Values that exceed
//!   u128 are logged and zeroed. If we ever need full 256-bit fidelity,
//!   switch to `[u8; 32]` with `#[serde(with = "clickhouse::serde::uint256")]`.
//! - `block_timestamp` is a `DateTime64(0,'UTC')` — serialized as seconds-since-
//!   epoch via `time::OffsetDateTime` and the `clickhouse::serde::time::datetime64::secs` helper.

use clickhouse::{Client, Row};
use eyre::{Context, Result};
use serde::Serialize;
use tracing::{debug, warn};
use crate::types::{Trace, Transaction, Transfer};

pub struct ClickhouseWriter {
    client: Client,
}

impl ClickhouseWriter {
    pub fn connect(
        url: &str,
        database: &str,
        user: &str,
        password: &str,
    ) -> Result<Self> {
        let client = Client::default()
            .with_url(url)
            .with_database(database)
            .with_user(user)
            .with_password(password);
        Ok(Self { client })
    }

    pub async fn insert_transactions(&self, txs: &[Transaction]) -> Result<u64> {
        if txs.is_empty() {
            return Ok(0);
        }
        let mut inserter = self
            .client
            .insert::<TransactionRow>("transactions")
            .context("open transactions insert")?;
        for tx in txs {
            inserter.write(&TransactionRow::from(tx)).await?;
        }
        inserter.end().await.context("flush transactions insert")?;
        debug!(count = txs.len(), "clickhouse: transactions inserted");
        Ok(txs.len() as u64)
    }

    pub async fn insert_traces(&self, traces: &[Trace]) -> Result<u64> {
        if traces.is_empty() {
            return Ok(0);
        }
        let mut inserter = self
            .client
            .insert::<TraceRow>("traces")
            .context("open traces insert")?;
        for t in traces {
            inserter.write(&TraceRow::from(t)).await?;
        }
        inserter.end().await.context("flush traces insert")?;
        debug!(count = traces.len(), "clickhouse: traces inserted");
        Ok(traces.len() as u64)
    }

    pub async fn insert_transfers(&self, transfers: &[Transfer]) -> Result<u64> {
        if transfers.is_empty() {
            return Ok(0);
        }
        let mut inserter = self
            .client
            .insert::<TokenTransferRow>("token_transfers")
            .context("open token_transfers insert")?;
        for t in transfers {
            inserter.write(&TokenTransferRow::from(t)).await?;
        }
        inserter.end().await.context("flush token_transfers insert")?;
        debug!(count = transfers.len(), "clickhouse: transfers inserted");
        Ok(transfers.len() as u64)
    }
}

// ---------------------------------------------------------------------------
// Row structs mirror the ClickHouse table columns exactly, in declaration order.
// ---------------------------------------------------------------------------

#[derive(Row, Serialize, Debug)]
struct TransactionRow {
    hash: String,
    nonce: Option<u64>,
    transaction_index: Option<u32>,
    from_address: String,
    to_address: String,
    value: u128,
    gas: Option<u64>,
    gas_price: u128,
    input: String,
    receipt_cumulative_gas_used: Option<u64>,
    receipt_gas_used: u64,
    receipt_contract_address: Option<String>,
    receipt_status: Option<u8>,
    #[serde(with = "clickhouse::serde::time::datetime64::secs")]
    block_timestamp: time::OffsetDateTime,
    block_number: u64,
    block_hash: Option<String>,
    max_fee_per_gas: Option<u128>,
    max_priority_fee_per_gas: Option<u128>,
    transaction_type: Option<u16>,
    receipt_effective_gas_price: Option<u128>,
}

impl From<&Transaction> for TransactionRow {
    fn from(tx: &Transaction) -> Self {
        Self {
            hash: tx.hash.clone(),
            nonce: None,
            transaction_index: None,
            from_address: tx.from_address.clone(),
            to_address: tx.to_address.clone(),
            value: parse_u256_as_u128(&tx.value, "transactions.value"),
            gas: None,
            gas_price: parse_u256_as_u128(&tx.gas_price, "transactions.gas_price"),
            input: tx.input.clone(),
            receipt_cumulative_gas_used: None,
            receipt_gas_used: tx.gas_used,
            receipt_contract_address: if tx.contract_address.is_empty() {
                None
            } else {
                Some(tx.contract_address.clone())
            },
            receipt_status: None,
            block_timestamp: time::OffsetDateTime::from_unix_timestamp(tx.timestamp as i64)
                .unwrap_or(time::OffsetDateTime::UNIX_EPOCH),
            block_number: tx.block_number,
            block_hash: None,
            max_fee_per_gas: None,
            max_priority_fee_per_gas: None,
            transaction_type: None,
            receipt_effective_gas_price: None,
        }
    }
}

#[derive(Row, Serialize, Debug)]
struct TraceRow {
    trace_id: String,
    transaction_hash: String,
    transaction_index: Option<u32>,
    from_address: String,
    to_address: String,
    value: u128,
    input: String,
    output: String,
    trace_type: String,
    call_type: Option<String>,
    reward_type: Option<String>,
    gas: u64,
    gas_used: u64,
    subtraces: Option<u32>,
    trace_address: Vec<u32>,
    error: Option<String>,
    status: Option<u8>,
    #[serde(with = "clickhouse::serde::time::datetime64::secs::option")]
    block_timestamp: Option<time::OffsetDateTime>,
    block_number: u64,
    block_hash: Option<String>,
}

impl From<&Trace> for TraceRow {
    fn from(t: &Trace) -> Self {
        let trace_addr_str = t
            .trace_address
            .iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(".");
        let trace_id = if trace_addr_str.is_empty() {
            t.transaction_hash.clone()
        } else {
            format!("{}_{}", t.transaction_hash, trace_addr_str)
        };
        Self {
            trace_id,
            transaction_hash: t.transaction_hash.clone(),
            transaction_index: None,
            from_address: t.from_address.clone(),
            to_address: t.to_address.clone(),
            value: parse_u256_as_u128(&t.value, "traces.value"),
            input: t.input.clone(),
            output: t.output.clone(),
            trace_type: t.trace_type.clone(),
            call_type: t.call_type.clone(),
            reward_type: None,
            gas: t.gas,
            gas_used: t.gas_used,
            subtraces: None,
            trace_address: t.trace_address.clone(),
            error: t.error.clone(),
            status: None,
            block_timestamp: None,
            block_number: t.block_number,
            block_hash: None,
        }
    }
}

#[derive(Row, Serialize, Debug)]
struct TokenTransferRow {
    token_address: String,
    from_address: String,
    to_address: String,
    value: u128,
    transaction_hash: String,
    log_index: u32,
    #[serde(with = "clickhouse::serde::time::datetime64::secs")]
    block_timestamp: time::OffsetDateTime,
    block_number: u64,
    block_hash: Option<String>,
}

impl From<&Transfer> for TokenTransferRow {
    fn from(t: &Transfer) -> Self {
        Self {
            token_address: t.token_address.clone(),
            from_address: t.from_address.clone(),
            to_address: t.to_address.clone(),
            value: parse_u256_as_u128(&t.value, "token_transfers.value"),
            transaction_hash: t.transaction_hash.clone(),
            log_index: t.log_index as u32,
            block_timestamp: time::OffsetDateTime::from_unix_timestamp(t.timestamp as i64)
                .unwrap_or(time::OffsetDateTime::UNIX_EPOCH),
            block_number: t.block_number,
            block_hash: None,
        }
    }
}

fn parse_u256_as_u128(raw: &str, field: &'static str) -> u128 {
    if raw.is_empty() {
        return 0;
    }
    let s = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X"));
    let parsed = match s {
        Some(hex) => u128::from_str_radix(hex, 16),
        None => raw.parse::<u128>(),
    };
    match parsed {
        Ok(v) => v,
        Err(_) => {
            warn!(field, raw, "clickhouse: value exceeds u128 or unparseable; zeroed");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_u256_handles_decimal_and_hex() {
        assert_eq!(parse_u256_as_u128("1000000000000000000", "t.v"), 1_000_000_000_000_000_000u128);
        assert_eq!(parse_u256_as_u128("0x0de0b6b3a7640000", "t.v"), 1_000_000_000_000_000_000u128);
        assert_eq!(parse_u256_as_u128("", "t.v"), 0);
        assert_eq!(parse_u256_as_u128("not-a-number", "t.v"), 0);
    }

    #[test]
    fn trace_row_computes_trace_id() {
        let trace = Trace {
            transaction_hash: "0xabc".into(),
            from_address: "0x1".into(),
            to_address: "0x2".into(),
            value: "0".into(),
            trace_type: "call".into(),
            call_type: None,
            gas: 0,
            gas_used: 0,
            input: "0x".into(),
            output: "0x".into(),
            error: None,
            block_number: 1,
            trace_address: vec![0, 1, 2],
        };
        let row = TraceRow::from(&trace);
        assert_eq!(row.trace_id, "0xabc_0.1.2");

        let root = Trace {
            trace_address: vec![],
            ..trace
        };
        let row = TraceRow::from(&root);
        assert_eq!(row.trace_id, "0xabc");
    }
}
