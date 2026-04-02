use async_trait::async_trait;
use chain_analysis_common::{Trace, Transaction, Transfer};
use eyre::Result;
use redis::AsyncCommands;
use tracing::debug;

pub const TOPIC_INGESTED_TXS: &str = "ingested_txs";
pub const TOPIC_INGESTED_TRACES: &str = "ingested_traces";
pub const TOPIC_INGESTED_TRANSFERS: &str = "ingested_transfers";

fn cursor_key(source: &str) -> String {
    format!("ingest:last_block:{}", source)
}

fn failed_blocks_key(source: &str) -> String {
    format!("ingest:failed_blocks:{}", source)
}

#[async_trait]
pub trait TransactionWriter: Send {
    async fn write_transaction(&mut self, tx: &Transaction) -> Result<()>;
    async fn write_trace(&mut self, trace: &Trace) -> Result<()>;
    async fn write_transfer(&mut self, transfer: &Transfer) -> Result<()>;
    async fn save_cursor(&mut self, block_number: u64) -> Result<()>;
    async fn get_cursor(&mut self) -> Result<Option<u64>>;
    async fn record_failed_block(&mut self, block_number: u64) -> Result<()>;
}

pub struct RedisStreamWriter {
    conn: redis::aio::MultiplexedConnection,
    cursor_key: String,
    failed_key: String,
}

impl RedisStreamWriter {
    pub async fn connect(redis_url: &str, source: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self {
            conn,
            cursor_key: cursor_key(source),
            failed_key: failed_blocks_key(source),
        })
    }
}

#[async_trait]
impl TransactionWriter for RedisStreamWriter {
    async fn write_transaction(&mut self, tx: &Transaction) -> Result<()> {
        let json = serde_json::to_string(tx)?;
        let _: String = redis::cmd("XADD")
            .arg(TOPIC_INGESTED_TXS)
            .arg("*")
            .arg("data")
            .arg(&json)
            .query_async(&mut self.conn)
            .await?;
        debug!(hash = %tx.hash, "Wrote transaction to Redis");
        Ok(())
    }

    async fn write_trace(&mut self, trace: &Trace) -> Result<()> {
        let json = serde_json::to_string(trace)?;
        let _: String = redis::cmd("XADD")
            .arg(TOPIC_INGESTED_TRACES)
            .arg("*")
            .arg("data")
            .arg(&json)
            .query_async(&mut self.conn)
            .await?;
        debug!(tx_hash = %trace.transaction_hash, "Wrote trace to Redis");
        Ok(())
    }

    async fn write_transfer(&mut self, transfer: &Transfer) -> Result<()> {
        let json = serde_json::to_string(transfer)?;
        let _: String = redis::cmd("XADD")
            .arg(TOPIC_INGESTED_TRANSFERS)
            .arg("*")
            .arg("data")
            .arg(&json)
            .query_async(&mut self.conn)
            .await?;
        debug!(tx_hash = %transfer.transaction_hash, "Wrote transfer to Redis");
        Ok(())
    }

    async fn save_cursor(&mut self, block_number: u64) -> Result<()> {
        self.conn
            .set::<_, _, ()>(&self.cursor_key, block_number)
            .await?;
        Ok(())
    }

    async fn get_cursor(&mut self) -> Result<Option<u64>> {
        let val: Option<u64> = self.conn.get(&self.cursor_key).await?;
        Ok(val)
    }

    async fn record_failed_block(&mut self, block_number: u64) -> Result<()> {
        self.conn
            .sadd::<_, _, ()>(&self.failed_key, block_number)
            .await?;
        debug!(block = block_number, "Recorded failed block");
        Ok(())
    }
}

pub struct StdoutWriter;

#[async_trait]
impl TransactionWriter for StdoutWriter {
    async fn write_transaction(&mut self, tx: &Transaction) -> Result<()> {
        println!("{}", serde_json::to_string(tx)?);
        Ok(())
    }

    async fn write_trace(&mut self, trace: &Trace) -> Result<()> {
        println!("{}", serde_json::to_string(trace)?);
        Ok(())
    }

    async fn write_transfer(&mut self, transfer: &Transfer) -> Result<()> {
        println!("{}", serde_json::to_string(transfer)?);
        Ok(())
    }

    async fn save_cursor(&mut self, _block_number: u64) -> Result<()> {
        Ok(())
    }

    async fn get_cursor(&mut self) -> Result<Option<u64>> {
        Ok(None)
    }

    async fn record_failed_block(&mut self, _block_number: u64) -> Result<()> {
        Ok(())
    }
}
