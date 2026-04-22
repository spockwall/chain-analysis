-- ethereum-etl / BigQuery canonical token_transfers schema.
-- Primary key (transaction_hash, log_index) makes ReplacingMergeTree idempotent per ERC-20 log.

CREATE TABLE IF NOT EXISTS chain_analysis.token_transfers
(
    token_address     String,
    from_address      String,
    to_address        String,
    value             UInt256,
    transaction_hash  String,
    log_index         UInt32,
    block_timestamp   DateTime64(0, 'UTC'),
    block_number      UInt64,
    block_hash        Nullable(String),
    inserted_at       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(block_timestamp)
ORDER BY (block_number, transaction_hash, log_index)
SETTINGS index_granularity = 8192;

CREATE INDEX IF NOT EXISTS idx_token_addr ON chain_analysis.token_transfers (token_address) TYPE bloom_filter GRANULARITY 4;
CREATE INDEX IF NOT EXISTS idx_from_addr  ON chain_analysis.token_transfers (from_address)  TYPE bloom_filter GRANULARITY 4;
CREATE INDEX IF NOT EXISTS idx_to_addr    ON chain_analysis.token_transfers (to_address)    TYPE bloom_filter GRANULARITY 4;
