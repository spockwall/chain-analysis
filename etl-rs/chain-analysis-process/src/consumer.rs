use chain_analysis_common::{Trace, Transaction, Transfer};
use eyre::Result;
use serde::de::DeserializeOwned;
use tracing::{debug, info, warn};

const STREAM_TXS: &str = "ingested_txs";
const STREAM_TRACES: &str = "ingested_traces";
const STREAM_TRANSFERS: &str = "ingested_transfers";

pub struct StreamConsumer {
    conn: redis::aio::MultiplexedConnection,
    group: String,
    consumer: String,
    batch_size: usize,
    block_ms: usize,
}

impl StreamConsumer {
    pub async fn connect(
        redis_url: &str,
        group: &str,
        consumer: &str,
        batch_size: usize,
        block_ms: usize,
    ) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self {
            conn,
            group: group.to_string(),
            consumer: consumer.to_string(),
            batch_size,
            block_ms,
        })
    }

    /// Create consumer groups on all three streams (idempotent).
    pub async fn ensure_groups(&mut self) -> Result<()> {
        for stream in &[STREAM_TXS, STREAM_TRACES, STREAM_TRANSFERS] {
            let result: Result<String, redis::RedisError> = redis::cmd("XGROUP")
                .arg("CREATE")
                .arg(stream)
                .arg(&self.group)
                .arg("0")
                .arg("MKSTREAM")
                .query_async(&mut self.conn)
                .await;

            match result {
                Ok(_) => info!(group = %self.group, stream, "Created consumer group"),
                Err(e) if e.to_string().contains("BUSYGROUP") => {
                    debug!(group = %self.group, stream, "Consumer group already exists");
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    pub async fn read_batch(&mut self) -> Result<Vec<(String, Transaction)>> {
        self.read_stream_batch(STREAM_TXS).await
    }

    pub async fn read_trace_batch(&mut self) -> Result<Vec<(String, Trace)>> {
        self.read_stream_batch(STREAM_TRACES).await
    }

    pub async fn read_transfer_batch(&mut self) -> Result<Vec<(String, Transfer)>> {
        self.read_stream_batch(STREAM_TRANSFERS).await
    }

    async fn read_stream_batch<T: DeserializeOwned>(
        &mut self,
        stream: &str,
    ) -> Result<Vec<(String, T)>> {
        let result: redis::Value = redis::cmd("XREADGROUP")
            .arg("GROUP")
            .arg(&self.group)
            .arg(&self.consumer)
            .arg("COUNT")
            .arg(self.batch_size)
            .arg("BLOCK")
            .arg(self.block_ms)
            .arg("STREAMS")
            .arg(stream)
            .arg(">")
            .query_async(&mut self.conn)
            .await?;

        parse_xreadgroup_result(result)
    }

    pub async fn ack(&mut self, stream: &str, message_ids: &[String]) -> Result<u64> {
        if message_ids.is_empty() {
            return Ok(0);
        }
        let mut cmd = redis::cmd("XACK");
        cmd.arg(stream).arg(&self.group);
        for id in message_ids {
            cmd.arg(id);
        }
        let count: u64 = cmd.query_async(&mut self.conn).await?;
        debug!(count, stream, "Acknowledged messages");
        Ok(count)
    }

    pub async fn ack_txs(&mut self, ids: &[String]) -> Result<u64> {
        self.ack(STREAM_TXS, ids).await
    }

    pub async fn ack_traces(&mut self, ids: &[String]) -> Result<u64> {
        self.ack(STREAM_TRACES, ids).await
    }

    pub async fn ack_transfers(&mut self, ids: &[String]) -> Result<u64> {
        self.ack(STREAM_TRANSFERS, ids).await
    }
}

fn parse_xreadgroup_result<T: DeserializeOwned>(
    value: redis::Value,
) -> Result<Vec<(String, T)>> {
    let mut results = Vec::new();

    // XREADGROUP returns: [[stream_name, [[msg_id, [field, value, ...]], ...]]]
    let streams = match value {
        redis::Value::Array(s) => s,
        redis::Value::Nil => return Ok(results),
        other => {
            warn!(?other, "Unexpected XREADGROUP response type");
            return Ok(results);
        }
    };

    for stream in streams {
        let stream_arr = match stream {
            redis::Value::Array(a) => a,
            _ => continue,
        };
        // stream_arr[0] = stream name, stream_arr[1] = messages array
        let messages = match stream_arr.into_iter().nth(1) {
            Some(redis::Value::Array(msgs)) => msgs,
            _ => continue,
        };

        for msg in messages {
            let msg_arr = match msg {
                redis::Value::Array(a) => a,
                _ => continue,
            };
            if msg_arr.len() < 2 {
                continue;
            }

            let msg_id = match &msg_arr[0] {
                redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
                _ => continue,
            };

            let fields = match &msg_arr[1] {
                redis::Value::Array(f) => f,
                _ => continue,
            };

            // fields = [key, value, key, value, ...]
            // We want the "data" field
            let mut data_json: Option<String> = None;
            let mut i = 0;
            while i + 1 < fields.len() {
                if let redis::Value::BulkString(key) = &fields[i] {
                    if key == b"data" {
                        if let redis::Value::BulkString(val) = &fields[i + 1] {
                            data_json = Some(String::from_utf8_lossy(val).to_string());
                        }
                    }
                }
                i += 2;
            }

            if let Some(json) = data_json {
                match serde_json::from_str::<T>(&json) {
                    Ok(item) => results.push((msg_id, item)),
                    Err(e) => {
                        warn!(msg_id, error = %e, "Failed to parse JSON from stream");
                    }
                }
            }
        }
    }

    Ok(results)
}
