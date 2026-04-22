//! Integration test for the ClickHouse writer. Gated on `E2E_CLICKHOUSE_URL`.
//!
//! ```sh
//! E2E_CLICKHOUSE_URL=http://localhost:8123 \
//! CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=clickhouse123 \
//!   cargo test -p sinks --test clickhouse
//! ```
//!
//! The test creates a per-run throwaway database and DROPs it on completion,
//! so multiple runs don't pollute each other.

use clickhouse::Client;
use etl::sinks::clickhouse::ClickhouseWriter;
use etl::types::{Trace, Transaction, Transfer};

fn e2e_url() -> Option<String> {
    std::env::var("E2E_CLICKHOUSE_URL").ok()
}

fn user() -> String {
    std::env::var("CLICKHOUSE_USER").unwrap_or_else(|_| "default".into())
}

fn password() -> String {
    std::env::var("CLICKHOUSE_PASSWORD").unwrap_or_default()
}

fn mk_tx(i: u64) -> Transaction {
    Transaction {
        hash: format!("0x{:064x}", i),
        from_address: "0x0000000000000000000000000000000000000001".into(),
        to_address: "0x0000000000000000000000000000000000000002".into(),
        value: "1000000000000000000".into(),
        block_number: 18_000_000 + i,
        timestamp: 1_700_000_000 + i,
        gas_used: 21_000,
        gas_price: "20000000000".into(),
        input: "0x".into(),
        contract_address: String::new(),
    }
}

fn mk_trace(i: u64) -> Trace {
    Trace {
        transaction_hash: format!("0x{:064x}", i),
        from_address: "0xaaa".into(),
        to_address: "0xbbb".into(),
        value: "500".into(),
        trace_type: "call".into(),
        call_type: Some("call".into()),
        gas: 21_000,
        gas_used: 21_000,
        input: "0x".into(),
        output: "0x".into(),
        error: None,
        block_number: 18_000_000 + i,
        trace_address: vec![0, 1],
    }
}

fn mk_transfer(i: u64) -> Transfer {
    Transfer {
        transaction_hash: format!("0x{:064x}", i),
        log_index: 3,
        token_address: "0xdac17f958d2ee523a2206206994597c13d831ec7".into(),
        from_address: "0xaaa".into(),
        to_address: "0xbbb".into(),
        value: "1000000".into(),
        block_number: 18_000_000 + i,
        timestamp: 1_700_000_000 + i,
    }
}

const CREATE_TXS: &str = r#"
CREATE TABLE IF NOT EXISTS transactions (
    hash                          String,
    nonce                         Nullable(UInt64),
    transaction_index             Nullable(UInt32),
    from_address                  String,
    to_address                    String,
    value                         UInt256,
    gas                           Nullable(UInt64),
    gas_price                     UInt256,
    input                         String,
    receipt_cumulative_gas_used   Nullable(UInt64),
    receipt_gas_used              UInt64,
    receipt_contract_address      Nullable(String),
    receipt_status                Nullable(UInt8),
    block_timestamp               DateTime64(0, 'UTC'),
    block_number                  UInt64,
    block_hash                    Nullable(String),
    max_fee_per_gas               Nullable(UInt256),
    max_priority_fee_per_gas      Nullable(UInt256),
    transaction_type              Nullable(UInt16),
    receipt_effective_gas_price   Nullable(UInt256)
) ENGINE = MergeTree ORDER BY (block_number, hash)
"#;

const CREATE_TRACES: &str = r#"
CREATE TABLE IF NOT EXISTS traces (
    trace_id                      String,
    transaction_hash              String,
    transaction_index             Nullable(UInt32),
    from_address                  String,
    to_address                    String,
    value                         UInt256,
    input                         String,
    output                        String,
    trace_type                    String,
    call_type                     Nullable(String),
    reward_type                   Nullable(String),
    gas                           UInt64,
    gas_used                      UInt64,
    subtraces                     Nullable(UInt32),
    trace_address                 Array(UInt32),
    error                         Nullable(String),
    status                        Nullable(UInt8),
    block_timestamp               Nullable(DateTime64(0, 'UTC')),
    block_number                  UInt64,
    block_hash                    Nullable(String)
) ENGINE = MergeTree ORDER BY (block_number, trace_id)
"#;

const CREATE_TRANSFERS: &str = r#"
CREATE TABLE IF NOT EXISTS token_transfers (
    token_address     String,
    from_address      String,
    to_address        String,
    value             UInt256,
    transaction_hash  String,
    log_index         UInt32,
    block_timestamp   DateTime64(0, 'UTC'),
    block_number      UInt64,
    block_hash        Nullable(String)
) ENGINE = MergeTree ORDER BY (block_number, transaction_hash, log_index)
"#;

#[tokio::test]
async fn clickhouse_writer_inserts_and_reads_back() {
    let Some(url) = e2e_url() else {
        eprintln!("E2E_CLICKHOUSE_URL unset — skipping");
        return;
    };

    let db = format!("test_ch_{}", uuid::Uuid::new_v4().simple());
    let admin = Client::default()
        .with_url(&url)
        .with_user(user())
        .with_password(password());

    // Per-run database for isolation.
    admin
        .query(&format!("CREATE DATABASE {}", db))
        .execute()
        .await
        .expect("create database");

    let db_client = admin.clone().with_database(&db);
    db_client.query(CREATE_TXS).execute().await.expect("create transactions");
    db_client.query(CREATE_TRACES).execute().await.expect("create traces");
    db_client.query(CREATE_TRANSFERS).execute().await.expect("create token_transfers");

    let writer = ClickhouseWriter::connect(&url, &db, &user(), &password())
        .expect("connect writer");

    let txs: Vec<Transaction> = (0..10).map(mk_tx).collect();
    let traces: Vec<Trace> = (0..5).map(mk_trace).collect();
    let transfers: Vec<Transfer> = (0..7).map(mk_transfer).collect();

    let n_tx = writer.insert_transactions(&txs).await.expect("insert txs");
    let n_tr = writer.insert_traces(&traces).await.expect("insert traces");
    let n_tf = writer.insert_transfers(&transfers).await.expect("insert transfers");
    assert_eq!(n_tx, 10);
    assert_eq!(n_tr, 5);
    assert_eq!(n_tf, 7);

    let got_txs: u64 = db_client
        .query("SELECT count() FROM transactions")
        .fetch_one()
        .await
        .expect("count txs");
    let got_traces: u64 = db_client
        .query("SELECT count() FROM traces")
        .fetch_one()
        .await
        .expect("count traces");
    let got_transfers: u64 = db_client
        .query("SELECT count() FROM token_transfers")
        .fetch_one()
        .await
        .expect("count transfers");

    assert_eq!(got_txs, 10);
    assert_eq!(got_traces, 5);
    assert_eq!(got_transfers, 7);

    // Spot-check ethereum-etl column naming + value fidelity.
    let (hash, value, block_number): (String, u128, u64) = db_client
        .query("SELECT hash, toUInt128(value), block_number FROM transactions ORDER BY block_number LIMIT 1")
        .fetch_one()
        .await
        .expect("select tx row");
    assert_eq!(hash, format!("0x{:064x}", 0u64));
    assert_eq!(value, 1_000_000_000_000_000_000u128);
    assert_eq!(block_number, 18_000_000);

    // Trace id composition.
    let trace_id: String = db_client
        .query("SELECT trace_id FROM traces ORDER BY block_number LIMIT 1")
        .fetch_one()
        .await
        .expect("select trace row");
    assert_eq!(trace_id, format!("0x{:064x}_0.1", 0u64));

    // Cleanup.
    admin
        .query(&format!("DROP DATABASE {}", db))
        .execute()
        .await
        .expect("drop database");
}
