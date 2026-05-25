//! Cross-replica rate limiter backed by Redis fixed-window counters.
//!
//! Issue #27 acceptance: the Etherscan free tier is ~5 req/s, and naively
//! scaling `worker` to N replicas would multiply our 429s instead of
//! throughput. This module gives each provider (Etherscan / Alchemy /
//! public RPC) a single Redis-backed counter — all replicas drain the
//! same per-second budget atomically via Redis `INCR`.
//!
//! ## Why fixed window, not strict token bucket?
//!
//! Pure Rust + no Lua / no module rules out an atomic check-and-decrement
//! on the Redis side. INCR is the only atomic primitive we get. Fixed
//! window — one counter per wall-clock second, TTL'd after two seconds —
//! is the simplest design that:
//!   1. coordinates correctly across replicas (single Redis ops, no race)
//!   2. survives Redis flakiness (if Redis is down we proceed without
//!      throttling rather than wedging)
//!   3. needs no server-side state machine
//!
//! Tradeoff: at window boundaries you can get up to 2x the configured
//! rate in burst (5 req at 99.999s plus 5 req at 100.001s). For
//! Etherscan-class budgets (5 req/s) this is well within the provider's
//! tolerance — the 1s windows are an order of magnitude finer than their
//! enforcement granularity.
//!
//! ## Wiring
//!
//! - `init_limiters(redis_url)` is called once at worker / ingest startup.
//!   It reads `<PROVIDER>_RATE_LIMIT_PER_SEC` env vars and installs one
//!   limiter per provider; unset → no limiter (HTTP unconstrained).
//! - Every HTTP call site in `sources::etherscan / alchemy / public_rpc`
//!   calls [`acquire`] with its provider name before sending. If a limiter
//!   exists, the call blocks until the current 1s window has budget;
//!   otherwise it's a no-op.

use eyre::{Result, WrapErr};
use redis::aio::ConnectionManager;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::OnceCell;
use tracing::{debug, info, warn};

/// Upper bound on how long [`RedisRateLimiter::acquire`] will sleep on a
/// single over-budget result. Caps tail latency on pathological config
/// (e.g. clock skew that puts `now` far behind Redis).
const MAX_BACKOFF_MS: u64 = 1_000;

/// TTL applied to per-second counter keys. Two seconds so an in-flight
/// INCR right at a window boundary still finds its key alive on read.
const COUNTER_TTL_SECS: u64 = 2;

/// One per-provider limiter. Holds its own clone of the connection
/// manager — cloning is cheap because `ConnectionManager` is internally
/// `Arc`-shared.
pub struct RedisRateLimiter {
    redis: ConnectionManager,
    key_prefix: String,
    capacity_per_sec: u32,
    provider: &'static str,
}

impl RedisRateLimiter {
    pub fn new(
        redis: ConnectionManager,
        provider: &'static str,
        capacity_per_sec: u32,
    ) -> Self {
        Self {
            redis,
            key_prefix: format!("ratelimit:{}", provider),
            capacity_per_sec,
            provider,
        }
    }

    /// Block until we have headroom in the current 1s window.
    ///
    /// Algorithm: bucket key = `ratelimit:<provider>:<unix_second>`.
    /// `INCR` the key — atomic. If the resulting count is the first one,
    /// also `EXPIRE` it so the key garbage-collects. If the count exceeds
    /// the per-second budget, sleep until the next second and retry.
    /// On Redis errors, log and proceed unthrottled — better to risk a
    /// single 429 than to wedge the worker.
    pub async fn acquire(&self) -> Result<()> {
        let mut conn = self.redis.clone();
        loop {
            let now_ms = now_unix_ms();
            let now_sec = now_ms / 1000;
            let key = format!("{}:{}", self.key_prefix, now_sec);

            let incr_res: redis::RedisResult<i64> = redis::cmd("INCR")
                .arg(&key)
                .query_async(&mut conn)
                .await;

            let count = match incr_res {
                Ok(c) => c,
                Err(e) => {
                    warn!(
                        provider = self.provider,
                        error = %e,
                        "rate limiter: Redis INCR failed, proceeding without throttle"
                    );
                    return Ok(());
                }
            };

            // First write in this window: bound the key's lifetime so it
            // doesn't leak forever. Best-effort — if EXPIRE fails the
                // worst case is one stale key that costs a few bytes.
            if count == 1 {
                let _: redis::RedisResult<()> = redis::cmd("EXPIRE")
                    .arg(&key)
                    .arg(COUNTER_TTL_SECS)
                    .query_async(&mut conn)
                    .await;
            }

            if count <= self.capacity_per_sec as i64 {
                return Ok(());
            }

            // Over budget — sleep just past the next second boundary so
            // we line up with the next window's fresh counter.
            let ms_to_next_sec = 1000 - (now_ms % 1000) + 1;
            let sleep_ms = ms_to_next_sec.min(MAX_BACKOFF_MS);
            debug!(
                provider = self.provider,
                count,
                cap = self.capacity_per_sec,
                sleep_ms,
                "rate limiter: window full, sleeping to next window"
            );
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Process-global limiter registry. Set once by [`init_limiters`] at
/// startup; subsequent `acquire` calls look up by provider name.
static LIMITERS: OnceCell<HashMap<&'static str, Arc<RedisRateLimiter>>> = OnceCell::const_new();

/// Install limiters for every provider that has `<PROVIDER>_RATE_LIMIT_PER_SEC`
/// set in env. Worker / ingest startup paths call this exactly once;
/// re-init is rejected.
///
/// Env vars consulted:
///   - `ETHERSCAN_RATE_LIMIT_PER_SEC`
///   - `ALCHEMY_RATE_LIMIT_PER_SEC`
///   - `PUBLIC_RPC_RATE_LIMIT_PER_SEC`
///
/// Each is the integer cap on requests per second for that provider
/// across the entire worker fleet.
pub async fn init_limiters(redis_url: &str) -> Result<()> {
    let client = redis::Client::open(redis_url)
        .wrap_err("rate limiter: opening Redis client")?;
    let conn = ConnectionManager::new(client)
        .await
        .wrap_err("rate limiter: connecting to Redis")?;

    let mut map: HashMap<&'static str, Arc<RedisRateLimiter>> = HashMap::new();
    let mut configured: Vec<(&'static str, u32)> = Vec::new();

    for &provider in &["etherscan", "alchemy", "public_rpc"] {
        if let Some(per_sec) = read_provider_rate(provider) {
            let limiter = RedisRateLimiter::new(conn.clone(), provider, per_sec);
            map.insert(provider, Arc::new(limiter));
            configured.push((provider, per_sec));
        }
    }

    LIMITERS
        .set(map)
        .map_err(|_| eyre::eyre!("rate limiters already initialised"))?;

    if configured.is_empty() {
        info!("rate limiter: no <PROVIDER>_RATE_LIMIT_PER_SEC set, all sources unthrottled");
    } else {
        for (provider, per_sec) in configured {
            info!(provider, per_sec, "rate limiter: configured");
        }
    }
    Ok(())
}

fn read_provider_rate(provider: &str) -> Option<u32> {
    let upper = provider.to_ascii_uppercase();
    std::env::var(format!("{}_RATE_LIMIT_PER_SEC", upper))
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|n| *n > 0)
}

/// Wait for budget in the current window for `provider`. If no limiter
/// is configured, returns immediately — call sites can blindly
/// `await rate_limiter::acquire("etherscan")` without checking whether
/// the env is set.
pub async fn acquire(provider: &'static str) {
    let Some(map) = LIMITERS.get() else { return };
    let Some(limiter) = map.get(provider) else {
        return;
    };
    let _ = limiter.acquire().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_provider_rate_returns_none_when_unset() {
        assert!(read_provider_rate("NEVERSET").is_none());
    }

    #[test]
    fn read_provider_rate_parses_positive() {
        std::env::set_var("UNITTEST_PROV_RATE_LIMIT_PER_SEC", "5");
        assert_eq!(read_provider_rate("UNITTEST_PROV"), Some(5));
        std::env::remove_var("UNITTEST_PROV_RATE_LIMIT_PER_SEC");
    }

    #[test]
    fn read_provider_rate_rejects_zero_or_garbage() {
        std::env::set_var("UNITTEST_PROV_ZERO_RATE_LIMIT_PER_SEC", "0");
        assert_eq!(read_provider_rate("UNITTEST_PROV_ZERO"), None);
        std::env::remove_var("UNITTEST_PROV_ZERO_RATE_LIMIT_PER_SEC");

        std::env::set_var("UNITTEST_PROV_GARBAGE_RATE_LIMIT_PER_SEC", "abc");
        assert_eq!(read_provider_rate("UNITTEST_PROV_GARBAGE"), None);
        std::env::remove_var("UNITTEST_PROV_GARBAGE_RATE_LIMIT_PER_SEC");
    }

    #[tokio::test]
    async fn acquire_is_noop_when_uninitialised() {
        // The OnceCell may be set in earlier tests, so we can't assert
        // unconditional no-op — but acquire must never panic or hang
        // for an unconfigured provider regardless.
        acquire("provider_that_does_not_exist_anywhere").await;
    }
}
