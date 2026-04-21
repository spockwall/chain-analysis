use eyre::Result;
use redis::AsyncCommands;
use tracing::{info, warn};

#[derive(Clone, Debug)]
pub struct DlqPolicy {
    pub max_attempts: u32,
    pub dlq_suffix: String,
    pub attempt_ttl_secs: u64,
}

impl Default for DlqPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            dlq_suffix: "_dlq".to_string(),
            attempt_ttl_secs: 86_400,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BatchKey {
    pub stream: String,
    pub first_id: String,
    pub last_id: String,
}

impl BatchKey {
    pub fn redis_key(&self) -> String {
        format!(
            "process:retry:{}:{}:{}",
            self.stream, self.first_id, self.last_id
        )
    }
}

pub async fn incr_attempt(
    conn: &mut redis::aio::MultiplexedConnection,
    key: &BatchKey,
    ttl_secs: u64,
) -> Result<u32> {
    let redis_key = key.redis_key();
    let n: u32 = conn.incr(&redis_key, 1u32).await?;
    let _: () = conn.expire(&redis_key, ttl_secs as i64).await?;
    Ok(n)
}

pub async fn clear_attempt(
    conn: &mut redis::aio::MultiplexedConnection,
    key: &BatchKey,
) -> Result<()> {
    let _: () = conn.del(key.redis_key()).await?;
    Ok(())
}

/// Copy every message to `{stream}{suffix}` then XACK originals in the group
/// and clear the attempt counter. Accepts fields as raw key/value pairs so
/// we stay schema-agnostic.
pub async fn move_batch_to_dlq(
    conn: &mut redis::aio::MultiplexedConnection,
    stream: &str,
    group: &str,
    msgs: &[(String, Vec<(String, String)>)],
    policy: &DlqPolicy,
) -> Result<()> {
    if msgs.is_empty() {
        return Ok(());
    }

    let dlq_stream = format!("{}{}", stream, policy.dlq_suffix);
    let mut pipe = redis::pipe();

    for (orig_id, fields) in msgs {
        let mut cmd = redis::cmd("XADD");
        cmd.arg(&dlq_stream).arg("*");
        for (k, v) in fields {
            cmd.arg(k).arg(v);
        }
        // carry the original id for operator forensics
        cmd.arg("original_id").arg(orig_id);
        pipe.add_command(cmd);
    }

    let ids: Vec<&str> = msgs.iter().map(|(id, _)| id.as_str()).collect();
    pipe.cmd("XACK").arg(stream).arg(group).arg(&ids);

    let _: () = pipe.query_async(conn).await.map_err(|e| {
        warn!(stream, error = %e, "failed to move batch to DLQ");
        e
    })?;

    let first = msgs.first().map(|(id, _)| id.as_str()).unwrap_or("");
    let last = msgs.last().map(|(id, _)| id.as_str()).unwrap_or("");
    let key = BatchKey {
        stream: stream.to_string(),
        first_id: first.to_string(),
        last_id: last.to_string(),
    };
    let _ = clear_attempt(conn, &key).await;

    info!(
        stream,
        dlq = %dlq_stream,
        count = msgs.len(),
        "moved poisoned batch to DLQ"
    );

    Ok(())
}
