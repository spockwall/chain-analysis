//! Task B: on a timer, enumerate known_labels + high-risk entities and LPUSH
//! refresh jobs onto the targeted queue. An in-memory per-address cooldown
//! prevents re-queuing the same address back-to-back.
//!
//! ## Multi-replica safety
//!
//! When `worker` runs with `deploy.replicas > 1`, every replica spins up its
//! own Task B loop on the same schedule. Without coordination they'd LPUSH
//! the same known-label set N times every interval, multiplying load on
//! Etherscan and the downstream pipeline. We avoid this with a Redis
//! **distributed lease** — at the start of each tick, every replica tries
//! `SET refresh_lease <replica_id> NX EX <ttl>`. Only one wins; the rest
//! log and skip. The lease auto-expires before the next tick so a crashed
//! leader doesn't block the world forever; we deliberately do not release
//! the lease on completion to avoid the clock-skew race where a slow
//! replica releases a lease another replica has already re-acquired.
//!
//! The lease TTL is `interval - 30`, so there is a ~30s window each tick
//! where no lease is held. If a second replica's tick happens to land in
//! that window (clock skew / tick drift) it could win the lease and run a
//! *second* refresh within the same interval. A shared last-refresh
//! timestamp (`refresh_last_ts`, written from Redis server `TIME` so it's
//! consistent across machines) guards that: after winning the lease a
//! replica still skips if the previous refresh was less than one interval
//! ago.
//!
//! The per-instance `cooldown` HashMap stays as-is: in the rare case lease
//! ownership flips to a fresh replica, that replica might re-enqueue an
//! address it has no record of. Downstream `effective_from_block` makes
//! this cheap (0 new txs fetched, ~1.5s), so we accept the minor waste in
//! exchange for not needing a shared cooldown store.

use eyre::Result;
use etl::pipeline::ShutdownHandle;
use redis::{aio::ConnectionManager, AsyncCommands};
use serde_json::json;
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// Default cap on transactions fetched per address per refresh tick.
/// Whales (Binance hot wallet, 1inch router, etc.) have millions of txs;
/// without a cap Etherscan times out trying to return everything. The
/// per-address `effective_from_block` ensures the next refresh resumes
/// where this one left off.
const DEFAULT_REFRESH_TX_LIMIT: usize = 500;

/// Redis key holding the current lease holder. Single key — there's only
/// one Task B refresh schedule, so one lease is enough.
const LEASE_KEY: &str = "refresh_lease";

/// Redis key holding the Unix-seconds timestamp of the last refresh tick
/// that actually ran. Used to suppress a second refresh inside one
/// interval when the lease gap lets another replica slip through.
const LAST_REFRESH_KEY: &str = "refresh_last_ts";

/// Floor on the lease TTL. If `REFRESH_INTERVAL_SECS` is configured very
/// short the natural `interval - 30` formula would give a negative or zero
/// TTL; clamp it so the lease can't be set with a non-positive expiry.
const MIN_LEASE_TTL_SECS: u64 = 30;

/// Resolve a per-replica identifier for lease attribution. Docker sets
/// `HOSTNAME` to the container hostname, which is unique per replica when
/// using `deploy.replicas`. Falls back to a PID-based string for local /
/// non-containerised runs.
fn replica_id() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("worker-pid-{}", std::process::id()))
}

/// Redis server clock in Unix seconds. Using the server's `TIME` rather
/// than each replica's local clock keeps the last-refresh guard correct
/// even when worker replicas run on different machines.
async fn redis_now_secs(redis: &mut ConnectionManager) -> Option<i64> {
    let res: redis::RedisResult<(i64, i64)> = redis::cmd("TIME").query_async(redis).await;
    res.ok().map(|(secs, _micros)| secs)
}

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
    let refresh_tx_limit: usize = std::env::var("REFRESH_TX_LIMIT_PER_ADDR")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n: &usize| *n > 0)
        .unwrap_or(DEFAULT_REFRESH_TX_LIMIT);
    let replica = replica_id();
    // The lease auto-expires before the next tick so a crashed leader
    // doesn't block forever. 30s of headroom lets a slow refresh finish
    // before another replica races on it.
    let lease_ttl_secs = refresh_interval_secs
        .saturating_sub(30)
        .max(MIN_LEASE_TTL_SECS);

    info!(
        replica = %replica,
        refresh_interval_secs,
        refresh_cooldown_secs,
        refresh_tx_limit,
        lease_ttl_secs,
        "Task B: refresh loop starting"
    );

    let mut iter = 0u64;
    loop {
        iter += 1;
        tokio::select! {
            _ = tokio::time::sleep(tick) => {},
            _ = shutdown.wait() => break,
        }

        // SET refresh_lease <replica> NX EX <ttl> — atomic acquire.
        // - Ok(Some(_)) → we won this tick.
        // - Ok(None) → another replica holds the lease; sit out this tick.
        // - Err(_) → Redis unhappy; log + skip rather than racing without
        //   the lease (better to drop a tick than double-enqueue).
        let lease_acquired: redis::RedisResult<Option<String>> = redis::cmd("SET")
            .arg(LEASE_KEY)
            .arg(&replica)
            .arg("NX")
            .arg("EX")
            .arg(lease_ttl_secs)
            .query_async(&mut redis)
            .await;

        match lease_acquired {
            Ok(Some(_)) => {
                debug!(iter, replica = %replica, "Task B: lease acquired");
            }
            Ok(None) => {
                debug!(iter, replica = %replica, "Task B: lease held by another replica, skipping tick");
                continue;
            }
            Err(e) => {
                warn!(iter, replica = %replica, error = %e, "Task B: lease acquisition failed, skipping tick");
                continue;
            }
        }

        // Second guard behind the lease: even holding the lease, bail if a
        // refresh ran less than one interval ago. This closes the lease-gap
        // window where a drifted replica could double-refresh. Best-effort —
        // if the Redis clock or read is unavailable we proceed rather than
        // stall refreshes entirely.
        let now_secs = redis_now_secs(&mut redis).await;
        if let Some(now) = now_secs {
            let last: Option<i64> = redis.get(LAST_REFRESH_KEY).await.ok().flatten();
            if let Some(last) = last {
                if now.saturating_sub(last) < refresh_interval_secs as i64 {
                    debug!(
                        iter,
                        replica = %replica,
                        since_last_secs = now - last,
                        "Task B: refresh ran <1 interval ago, skipping tick"
                    );
                    continue;
                }
            }
            let _: redis::RedisResult<()> = redis.set(LAST_REFRESH_KEY, now).await;
        }

        let tick_started = Instant::now();
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
                warn!(iter, error = %e, "refresh: failed to enumerate addresses, skipping tick");
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
                    "tx_limit": refresh_tx_limit,
                }
            })
            .to_string();

            match redis.lpush::<_, _, i64>(&targeted_queue_key, payload).await {
                Ok(_) => {
                    cooldown.insert(addr, now);
                    pushed += 1;
                }
                Err(e) => {
                    warn!(iter, address = %addr, error = %e, "refresh: LPUSH failed");
                }
            }
        }

        info!(
            iter,
            replica = %replica,
            pushed,
            skipped,
            tick_ms = tick_started.elapsed().as_millis() as u64,
            "Task B: refresh tick complete"
        );
    }

    info!("Task B: refresh loop shutting down");
    Ok(())
}
