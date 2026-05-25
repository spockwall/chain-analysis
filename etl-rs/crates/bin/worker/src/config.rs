//! Worker configuration. Composes the existing ingest/process configs and
//! adds worker-only tuning knobs.

fn env_or_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

pub struct WorkerConfig {
    pub ingest: etl::config::Config,
    pub process: etl::config::ProcessConfig,
    /// Interval (seconds) between refresh-loop ticks.
    pub refresh_interval_secs: u64,
    /// Per-address cooldown (seconds) preventing the same address from being
    /// re-queued by the refresh loop.
    pub refresh_cooldown_secs: u64,
    /// BRPOP timeout (seconds) for the targeted queue consumer.
    pub brpop_timeout_secs: u64,
    /// Max messages to read per XREADGROUP call (per stream) in task C.
    pub stream_batch_size: usize,
    /// XREADGROUP BLOCK timeout (milliseconds) in task C.
    pub stream_block_ms: usize,
}

impl WorkerConfig {
    pub fn from_env() -> Self {
        Self {
            ingest: etl::config::Config::from_env(),
            process: etl::config::ProcessConfig::from_env(),
            refresh_interval_secs: env_or_parse("REFRESH_INTERVAL_SECS", 300u64),
            refresh_cooldown_secs: env_or_parse("REFRESH_COOLDOWN_SECS", 1800u64),
            brpop_timeout_secs: env_or_parse("TARGETED_BRPOP_TIMEOUT_SECS", 5u64),
            stream_batch_size: env_or_parse("WORKER_STREAM_BATCH_SIZE", 500usize),
            stream_block_ms: env_or_parse("WORKER_STREAM_BLOCK_MS", 5000usize),
        }
    }
}
