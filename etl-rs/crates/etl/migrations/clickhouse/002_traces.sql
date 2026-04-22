-- ethereum-etl / BigQuery canonical traces schema.
-- trace_id = {transaction_hash}_{dot-joined trace_address}, ensures idempotent upserts.

CREATE TABLE IF NOT EXISTS chain_analysis.traces
(
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
    block_hash                    Nullable(String),
    inserted_at                   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY intDiv(block_number, 100000)
ORDER BY (block_number, trace_id)
SETTINGS index_granularity = 8192;

CREATE INDEX IF NOT EXISTS idx_tx_hash     ON chain_analysis.traces (transaction_hash) TYPE bloom_filter GRANULARITY 4;
CREATE INDEX IF NOT EXISTS idx_from_addr   ON chain_analysis.traces (from_address)     TYPE bloom_filter GRANULARITY 4;
CREATE INDEX IF NOT EXISTS idx_to_addr     ON chain_analysis.traces (to_address)       TYPE bloom_filter GRANULARITY 4;
