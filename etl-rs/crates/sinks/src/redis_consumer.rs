use metrics::counter;
use observability::CONSUMER_PARSE_FAILURES;
use types::{Trace, Transaction, Transfer};
use eyre::Result;
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use tracing::{debug, info, warn};

pub const STREAM_TXS: &str = "ingested_txs";
pub const STREAM_TRACES: &str = "ingested_traces";
pub const STREAM_TRANSFERS: &str = "ingested_transfers";

/// One Redis stream message: (id, field-pairs).
pub type RawMessage = (String, Vec<(String, String)>);
/// `stream_name → messages`, used when quarantining a failed batch into a DLQ.
pub type RawByStream = HashMap<String, Vec<RawMessage>>;

#[derive(Default)]
pub struct CombinedBatch {
    pub txs: Vec<(String, Transaction)>,
    pub traces: Vec<(String, Trace)>,
    pub transfers: Vec<(String, Transfer)>,
    /// Raw (id, field-pairs) per stream, retained so a failing batch can be
    /// relocated to a DLQ stream byte-for-byte.
    pub raw_by_stream: RawByStream,
}

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

    /// Read all three streams in a single XREADGROUP call. Saves 2x BLOCK timeouts
    /// when streams are partially or fully empty.
    pub async fn read_all_batches(&mut self) -> Result<CombinedBatch> {
        let result: redis::Value = redis::cmd("XREADGROUP")
            .arg("GROUP")
            .arg(&self.group)
            .arg(&self.consumer)
            .arg("COUNT")
            .arg(self.batch_size)
            .arg("BLOCK")
            .arg(self.block_ms)
            .arg("STREAMS")
            .arg(STREAM_TXS)
            .arg(STREAM_TRACES)
            .arg(STREAM_TRANSFERS)
            .arg(">")
            .arg(">")
            .arg(">")
            .query_async(&mut self.conn)
            .await?;

        let by_stream = parse_xreadgroup_multi(result);
        let mut batch = CombinedBatch::default();

        for (stream, msgs) in by_stream {
            let data_json: Vec<(String, String)> = msgs
                .iter()
                .filter_map(|(id, fields)| {
                    fields
                        .iter()
                        .find(|(k, _)| k == "data")
                        .map(|(_, v)| (id.clone(), v.clone()))
                })
                .collect();

            match stream.as_str() {
                STREAM_TXS => batch.txs = decode_messages(data_json, STREAM_TXS, &self.group),
                STREAM_TRACES => batch.traces = decode_messages(data_json, STREAM_TRACES, &self.group),
                STREAM_TRANSFERS => {
                    batch.transfers = decode_messages(data_json, STREAM_TRANSFERS, &self.group)
                }
                other => warn!(stream = other, "Unexpected stream in XREADGROUP response"),
            }
            batch.raw_by_stream.insert(stream, msgs);
        }

        Ok(batch)
    }

    pub fn conn_mut(&mut self) -> &mut redis::aio::MultiplexedConnection {
        &mut self.conn
    }

    pub fn group(&self) -> &str {
        &self.group
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

/// Parse XREADGROUP response into raw (stream_name → messages) pairs without
/// decoding the inner JSON.
fn parse_xreadgroup_multi(value: redis::Value) -> RawByStream {
    let mut by_stream: RawByStream = HashMap::new();

    let streams = match value {
        redis::Value::Array(s) => s,
        _ => return by_stream,
    };

    for stream in streams {
        let stream_arr = match stream {
            redis::Value::Array(a) => a,
            _ => continue,
        };
        let mut iter = stream_arr.into_iter();
        let stream_name = match iter.next() {
            Some(redis::Value::BulkString(b)) => String::from_utf8_lossy(&b).to_string(),
            _ => continue,
        };
        let messages = match iter.next() {
            Some(redis::Value::Array(msgs)) => msgs,
            _ => continue,
        };

        let mut decoded = Vec::with_capacity(messages.len());
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

            let mut field_pairs: Vec<(String, String)> = Vec::with_capacity(fields.len() / 2);
            let mut i = 0;
            while i + 1 < fields.len() {
                let k = match &fields[i] {
                    redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
                    _ => {
                        i += 2;
                        continue;
                    }
                };
                let v = match &fields[i + 1] {
                    redis::Value::BulkString(b) => String::from_utf8_lossy(b).to_string(),
                    _ => {
                        i += 2;
                        continue;
                    }
                };
                field_pairs.push((k, v));
                i += 2;
            }

            decoded.push((msg_id, field_pairs));
        }

        by_stream.insert(stream_name, decoded);
    }

    by_stream
}

fn decode_messages<T: DeserializeOwned>(
    items: Vec<(String, String)>,
    stream: &'static str,
    group: &str,
) -> Vec<(String, T)> {
    let group = group.to_string();
    items
        .into_iter()
        .filter_map(|(id, json)| match serde_json::from_str::<T>(&json) {
            Ok(item) => Some((id, item)),
            Err(e) => {
                counter!(
                    CONSUMER_PARSE_FAILURES,
                    "stream" => stream,
                    "group" => group.clone(),
                )
                .increment(1);
                warn!(msg_id = id, error = %e, "Failed to parse JSON from stream");
                None
            }
        })
        .collect()
}
