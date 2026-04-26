//! DLQ inspection helpers used by the `ingest dlq` CLI.
//!
//! A DLQ is just a Redis stream named `{orig}{suffix}` (default suffix `_dlq`)
//! that `pipeline::move_batch_to_dlq` writes to when a batch exceeds
//! `DlqPolicy::max_attempts`. Each DLQ entry carries an `original_id` field
//! pointing at the source-stream id it came from.

use eyre::{eyre, Result};
use redis::AsyncCommands;
use tracing::info;

pub const ORIGINAL_ID_FIELD: &str = "original_id";

#[derive(Debug, Clone)]
pub struct DlqEntry {
    pub id: String,
    pub fields: Vec<(String, String)>,
}

impl DlqEntry {
    pub fn original_id(&self) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k == ORIGINAL_ID_FIELD)
            .map(|(_, v)| v.as_str())
    }

    /// Fields with `original_id` removed — what to re-`XADD` on replay.
    pub fn payload_fields(&self) -> Vec<(String, String)> {
        self.fields
            .iter()
            .filter(|(k, _)| k != ORIGINAL_ID_FIELD)
            .cloned()
            .collect()
    }
}

pub fn dlq_stream_name(stream: &str, suffix: &str) -> String {
    format!("{}{}", stream, suffix)
}

/// Read up to `limit` entries from a DLQ stream.
///
/// `limit = None` reads everything (use with care on large DLQs).
pub async fn list_dlq(
    conn: &mut redis::aio::MultiplexedConnection,
    dlq_stream: &str,
    limit: Option<usize>,
) -> Result<Vec<DlqEntry>> {
    let mut cmd = redis::cmd("XRANGE");
    cmd.arg(dlq_stream).arg("-").arg("+");
    if let Some(n) = limit {
        cmd.arg("COUNT").arg(n);
    }
    // Reply shape: [[id, [k, v, k, v, ...]], ...]
    let raw: Vec<(String, Vec<(String, String)>)> = cmd.query_async(conn).await?;
    Ok(raw
        .into_iter()
        .map(|(id, fields)| DlqEntry { id, fields })
        .collect())
}

/// `XLEN` on the DLQ stream. Returns 0 if the stream doesn't exist.
pub async fn dlq_len(
    conn: &mut redis::aio::MultiplexedConnection,
    dlq_stream: &str,
) -> Result<u64> {
    let n: u64 = conn.xlen(dlq_stream).await.unwrap_or(0);
    Ok(n)
}

/// Replay a single DLQ entry back onto its original stream.
///
/// Sequencing matters: we `XADD` to the original first and only `XDEL` from
/// the DLQ on success. A crash between those two leaves a duplicate (consumer
/// idempotency via `MERGE` handles that), never a loss.
pub async fn replay_entry(
    conn: &mut redis::aio::MultiplexedConnection,
    dlq_stream: &str,
    original_stream: &str,
    entry: &DlqEntry,
) -> Result<String> {
    let payload = entry.payload_fields();
    if payload.is_empty() {
        return Err(eyre!(
            "DLQ entry {} has no payload fields after stripping original_id",
            entry.id
        ));
    }

    let mut xadd = redis::cmd("XADD");
    xadd.arg(original_stream).arg("*");
    for (k, v) in &payload {
        xadd.arg(k).arg(v);
    }
    let new_id: String = xadd.query_async(conn).await?;

    let _: i64 = conn.xdel(dlq_stream, &[&entry.id]).await?;
    Ok(new_id)
}

/// Replay up to `max` entries (or all if `None`). Returns count replayed.
pub async fn replay_all(
    conn: &mut redis::aio::MultiplexedConnection,
    dlq_stream: &str,
    original_stream: &str,
    max: Option<usize>,
) -> Result<usize> {
    let entries = list_dlq(conn, dlq_stream, max).await?;
    let total = entries.len();
    for entry in &entries {
        replay_entry(conn, dlq_stream, original_stream, entry).await?;
    }
    info!(dlq = dlq_stream, original = original_stream, replayed = total, "DLQ replay done");
    Ok(total)
}

/// Delete a single DLQ entry. Returns true if the entry existed.
pub async fn drop_entry(
    conn: &mut redis::aio::MultiplexedConnection,
    dlq_stream: &str,
    id: &str,
) -> Result<bool> {
    let n: i64 = conn.xdel(dlq_stream, &[id]).await?;
    Ok(n > 0)
}

/// Delete the entire DLQ stream. Returns count deleted (0 if stream was absent).
pub async fn drop_all(
    conn: &mut redis::aio::MultiplexedConnection,
    dlq_stream: &str,
) -> Result<u64> {
    let len = dlq_len(conn, dlq_stream).await?;
    if len == 0 {
        return Ok(0);
    }
    let _: i64 = conn.del(dlq_stream).await?;
    info!(dlq = dlq_stream, dropped = len, "DLQ drained");
    Ok(len)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dlq_stream_name_appends_suffix() {
        assert_eq!(dlq_stream_name("ingested_txs", "_dlq"), "ingested_txs_dlq");
        assert_eq!(dlq_stream_name("foo", "-failed"), "foo-failed");
    }

    #[test]
    fn payload_fields_strip_original_id() {
        let entry = DlqEntry {
            id: "1-0".into(),
            fields: vec![
                ("payload".into(), "{}".into()),
                ("original_id".into(), "0-1".into()),
                ("kind".into(), "tx".into()),
            ],
        };
        assert_eq!(entry.original_id(), Some("0-1"));
        let payload = entry.payload_fields();
        assert_eq!(payload.len(), 2);
        assert!(payload.iter().all(|(k, _)| k != "original_id"));
    }

    #[test]
    fn original_id_missing_when_absent() {
        let entry = DlqEntry {
            id: "1-0".into(),
            fields: vec![("payload".into(), "{}".into())],
        };
        assert_eq!(entry.original_id(), None);
    }
}
