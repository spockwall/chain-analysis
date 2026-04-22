//! Task B: on a timer, enumerate known_labels + high-risk entities and LPUSH
//! refresh jobs onto the targeted queue. An in-memory per-address cooldown
//! prevents re-queuing the same address back-to-back.

use eyre::Result;
use pipeline::ShutdownHandle;
use redis::{aio::ConnectionManager, AsyncCommands};
use serde_json::json;
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::{info, warn};

pub async fn run(
    targeted_queue_key: String,
    refresh_interval_secs: u64,
    refresh_cooldown_secs: u64,
    pg: PgPool,
    mut redis: ConnectionManager,
    mut shutdown: ShutdownHandle,
) -> Result<()> {
    let mut cooldown: HashMap<String, Instant> = HashMap::new();
    let cooldown_dur = Duration::from_secs(refresh_cooldown_secs);
    let tick = Duration::from_secs(refresh_interval_secs);

    info!(
        refresh_interval_secs,
        refresh_cooldown_secs, "Task B: refresh loop starting"
    );

    loop {
        tokio::select! {
            _ = tokio::time::sleep(tick) => {},
            _ = shutdown.wait() => break,
        }

        // risk_level lives on known_labels (Postgres) — entity_features
        // doesn't have that column. Select the union of (a) all known_labels
        // and (b) their current last_synced_block (0 if never synced).
        let rows: Vec<(String, i64)> = match sqlx::query_as(
            r#"
            SELECT kl.address,
                   COALESCE(ef.last_synced_block, 0) AS lsb
              FROM known_labels kl
              LEFT JOIN entity_features ef
                     ON ef.address = kl.address
                    AND ef.chain_id = 1
             WHERE kl.risk_level IN ('high', 'critical')
                OR ef.address IS NOT NULL
            "#,
        )
        .fetch_all(&pg)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(error = %e, "refresh: failed to enumerate addresses, skipping tick");
                continue;
            }
        };

        let now = Instant::now();
        let mut pushed = 0u64;
        let mut skipped = 0u64;

        for (addr, lsb) in rows {
            if let Some(last) = cooldown.get(&addr) {
                if now.duration_since(*last) < cooldown_dur {
                    skipped += 1;
                    continue;
                }
            }

            let from_block = if lsb > 0 { lsb as u64 + 1 } else { 0 };
            let payload = json!({
                "spec": {
                    "mode": "addresses",
                    "addrs": [addr.clone()],
                    "from_block": from_block,
                }
            })
            .to_string();

            match redis.lpush::<_, _, i64>(&targeted_queue_key, payload).await {
                Ok(_) => {
                    cooldown.insert(addr, now);
                    pushed += 1;
                }
                Err(e) => {
                    warn!(address = %addr, error = %e, "refresh: LPUSH failed");
                }
            }
        }

        info!(pushed, skipped, "Task B: refresh tick complete");
    }

    info!("Task B: refresh loop shutting down");
    Ok(())
}
