//! Cross-cutting pipeline helpers: retry policy, graceful shutdown, DLQ
//! bookkeeping, and progress reporters for both ingest and stream-consumer
//! tiers. Kept in one module so call sites have a single `use` path and so
//! small helpers can share test infrastructure.

use std::future::Future;
use std::time::Duration;

use eyre::Result;
use redis::AsyncCommands;
use tokio::sync::watch;
use tracing::{debug, info, warn};

use crate::types::{IngestionMessage, ProcessingMessage};

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

pub struct RetryPolicy {
    pub max_retries: u32,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub multiplier: f64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 5,
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(60),
            multiplier: 2.0,
        }
    }
}

pub async fn with_retry<F, Fut, T>(
    policy: &RetryPolicy,
    operation: &str,
    mut f: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut attempt = 0u32;
    let mut backoff = policy.initial_backoff;

    loop {
        attempt += 1;
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) if attempt > policy.max_retries => {
                return Err(e.wrap_err(format!(
                    "{} failed after {} retries",
                    operation, policy.max_retries
                )));
            }
            Err(e) => {
                warn!(
                    operation,
                    attempt,
                    error = %e,
                    backoff_ms = backoff.as_millis() as u64,
                    "Retrying after error"
                );
                tokio::time::sleep(backoff).await;
                backoff =
                    Duration::from_secs_f64(backoff.as_secs_f64() * policy.multiplier)
                        .min(policy.max_backoff);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ShutdownHandle {
    rx: watch::Receiver<bool>,
}

impl ShutdownHandle {
    pub fn is_shutdown(&self) -> bool {
        *self.rx.borrow()
    }

    pub async fn wait(&mut self) {
        while !*self.rx.borrow_and_update() {
            if self.rx.changed().await.is_err() {
                return;
            }
        }
    }
}

pub fn install_shutdown() -> ShutdownHandle {
    let (tx, rx) = watch::channel(false);

    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigint = match signal(SignalKind::interrupt()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "failed to install SIGINT handler");
                    return;
                }
            };
            let mut sigterm = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "failed to install SIGTERM handler");
                    return;
                }
            };
            tokio::select! {
                _ = sigint.recv()  => info!("received SIGINT, initiating shutdown"),
                _ = sigterm.recv() => info!("received SIGTERM, initiating shutdown"),
            }
        }
        #[cfg(not(unix))]
        {
            if let Err(e) = tokio::signal::ctrl_c().await {
                tracing::error!(error = %e, "failed to await ctrl_c");
                return;
            }
            info!("received Ctrl+C, initiating shutdown");
        }
        let _ = tx.send(true);
    });

    ShutdownHandle { rx }
}

// ---------------------------------------------------------------------------
// DLQ
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Progress (ingest tier)
// ---------------------------------------------------------------------------

const TOPIC_INGESTION_PROGRESS: &str = "ingestion_progress";

pub enum ProgressReporter {
    Redis {
        conn: redis::aio::MultiplexedConnection,
        run_id: String,
    },
    DryRun {
        run_id: String,
    },
}

impl ProgressReporter {
    pub async fn new_redis(redis_url: &str, run_id: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self::Redis {
            conn,
            run_id: run_id.to_string(),
        })
    }

    pub fn new_dry_run(run_id: &str) -> Self {
        Self::DryRun {
            run_id: run_id.to_string(),
        }
    }

    fn run_id(&self) -> &str {
        match self {
            Self::Redis { run_id, .. } | Self::DryRun { run_id } => run_id,
        }
    }

    pub async fn report_progress(
        &mut self,
        current_block: u64,
        total_blocks: u64,
        transactions_processed: u64,
    ) -> Result<()> {
        let msg = IngestionMessage::Progress {
            run_id: self.run_id().to_string(),
            current_block,
            total_blocks,
            transactions_processed,
        };
        self.write_message(&msg).await
    }

    pub async fn report_complete(
        &mut self,
        blocks_processed: u64,
        transactions_processed: u64,
    ) -> Result<()> {
        let msg = IngestionMessage::Complete {
            run_id: self.run_id().to_string(),
            blocks_processed,
            transactions_processed,
        };
        self.write_message(&msg).await
    }

    pub async fn report_error(&mut self, message: &str) -> Result<()> {
        let msg = IngestionMessage::Error {
            run_id: self.run_id().to_string(),
            message: message.to_string(),
        };
        self.write_message(&msg).await
    }

    async fn write_message(&mut self, msg: &IngestionMessage) -> Result<()> {
        let json = serde_json::to_string(msg)?;
        match self {
            Self::Redis { conn, .. } => {
                let _: String = redis::cmd("XADD")
                    .arg(TOPIC_INGESTION_PROGRESS)
                    .arg("*")
                    .arg("data")
                    .arg(&json)
                    .query_async(conn)
                    .await?;
            }
            Self::DryRun { .. } => {
                info!(progress = %json);
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Progress (stream-consumer tier)
// ---------------------------------------------------------------------------

const TOPIC_PROCESSING_PROGRESS: &str = "processing_progress";

pub struct ProcessProgressReporter {
    conn: redis::aio::MultiplexedConnection,
    run_id: String,
}

impl ProcessProgressReporter {
    pub async fn new(redis_url: &str, run_id: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let conn = client.get_multiplexed_async_connection().await?;
        Ok(Self {
            conn,
            run_id: run_id.to_string(),
        })
    }

    pub async fn report_stage(&mut self, stage: &str, processed: u64, total: u64) -> Result<()> {
        let msg = ProcessingMessage::Progress {
            run_id: self.run_id.clone(),
            stage: stage.into(),
            processed,
            total,
        };
        self.write(&msg).await
    }

    pub async fn report_complete(&mut self, entities: u64, transactions: u64) -> Result<()> {
        let msg = ProcessingMessage::Complete {
            run_id: self.run_id.clone(),
            entities_processed: entities,
            transactions_processed: transactions,
        };
        self.write(&msg).await
    }

    pub async fn report_error(&mut self, message: &str) -> Result<()> {
        let msg = ProcessingMessage::Error {
            run_id: self.run_id.clone(),
            message: message.into(),
        };
        self.write(&msg).await
    }

    async fn write(&mut self, msg: &ProcessingMessage) -> Result<()> {
        let json = serde_json::to_string(msg)?;
        let _: String = redis::cmd("XADD")
            .arg(TOPIC_PROCESSING_PROGRESS)
            .arg("*")
            .arg("data")
            .arg(&json)
            .query_async(&mut self.conn)
            .await?;
        debug!(topic = TOPIC_PROCESSING_PROGRESS, "Reported processing progress");
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn handle_starts_not_shutdown() {
        let mut h = install_shutdown();
        assert!(!h.is_shutdown());
        let res = tokio::time::timeout(Duration::from_millis(10), h.wait()).await;
        assert!(res.is_err(), "wait() completed before signal was sent");
        assert!(!h.is_shutdown());
    }

    #[tokio::test]
    async fn handle_clone_sees_same_state() {
        let h = install_shutdown();
        let h2 = h.clone();
        assert_eq!(h.is_shutdown(), h2.is_shutdown());
    }

    #[test]
    fn batch_key_redis_key_format() {
        let k = BatchKey {
            stream: "ingested_txs".into(),
            first_id: "1-0".into(),
            last_id: "5-0".into(),
        };
        assert_eq!(k.redis_key(), "process:retry:ingested_txs:1-0:5-0");
    }

    #[test]
    fn dlq_policy_default_matches_process_config_defaults() {
        let p = DlqPolicy::default();
        assert_eq!(p.max_attempts, 5);
        assert_eq!(p.dlq_suffix, "_dlq");
        assert_eq!(p.attempt_ttl_secs, 86_400);
    }
}
