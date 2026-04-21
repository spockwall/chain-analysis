-- ethereum-etl / BigQuery canonical transactions schema.
-- Column names and types align with:
--   https://github.com/blockchain-etl/ethereum-etl
--   https://console.cloud.google.com/marketplace/product/ethereum/crypto-ethereum-blockchain
--
-- Missing upstream fields (nonce, transaction_index, receipt_*, block_hash, max_fee_per_gas,
-- max_priority_fee_per_gas, transaction_type) are declared Nullable so the schema stays
-- canonical even while our ingest pipeline emits a subset.

CREATE TABLE IF NOT EXISTS chain_analysis.transactions
(
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
    receipt_effective_gas_price   Nullable(UInt256),
    inserted_at                   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_number, hash)
SETTINGS index_granularity = 8192;

CREATE INDEX IF NOT EXISTS idx_from_address ON chain_analysis.transactions (from_address) TYPE bloom_filter GRANULARITY 4;
CREATE INDEX IF NOT EXISTS idx_to_address   ON chain_analysis.transactions (to_address)   TYPE bloom_filter GRANULARITY 4;
CREATE INDEX IF NOT EXISTS idx_hash         ON chain_analysis.transactions (hash)         TYPE bloom_filter GRANULARITY 4;
