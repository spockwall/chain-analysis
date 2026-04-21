fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}

fn env_or_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

pub struct Config {
    pub etherscan_api_key: Option<String>,
    pub etherscan_base_url: String,
    pub etherscan_chain_id: u64,
    pub redis_url: String,
    pub batch_size: usize,
    /// Approximate cap for each ingest stream. `None` disables trimming.
    pub stream_maxlen: Option<u64>,
    /// Redis list key used by the backend's POST /api/labels/fetch to hand
    /// targeted-ingest work to the `ingest targeted from-label-tasks` runner.
    pub targeted_queue_key: String,
    /// Postgres URL for targeted-ingest modes that query `label_tasks`.
    pub postgres_url: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let maxlen: u64 = env_or_parse("INGEST_STREAM_MAXLEN", 1_000_000u64);
        Self {
            etherscan_api_key: std::env::var("ETHERSCAN_API_KEY")
                .ok()
                .filter(|s| !s.is_empty() && s != "your_etherscan_api_key_here"),
            etherscan_base_url: env_or("ETHERSCAN_BASE_URL", "https://api.etherscan.io/v2/api"),
            etherscan_chain_id: env_or_parse("ETHERSCAN_CHAIN_ID", 1),
            redis_url: env_or("REDIS_URL", "redis://localhost:6379"),
            batch_size: env_or_parse("INGEST_BATCH_SIZE", 1000),
            stream_maxlen: if maxlen == 0 { None } else { Some(maxlen) },
            targeted_queue_key: env_or("INGEST_TARGETED_QUEUE", "ingest:targeted_queue"),
            postgres_url: std::env::var("DATABASE_URL").ok().filter(|s| !s.is_empty()),
        }
    }
}

pub struct ProcessConfig {
    pub redis_url: String,
    pub neo4j_uri: String,
    pub neo4j_user: String,
    pub neo4j_password: String,
    pub neo4j_database: String,
    pub postgres_url: String,
    pub batch_size: usize,
    pub consumer_group: String,
    pub consumer_name: String,
    pub dlq_max_attempts: u32,
    pub dlq_suffix: String,
    pub dlq_attempt_ttl_secs: u64,
}

pub struct ClickhouseConfig {
    pub redis_url: String,
    pub clickhouse_url: String,
    pub clickhouse_database: String,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
    pub batch_size: usize,
    pub consumer_group: String,
    pub consumer_name: String,
    pub dlq_max_attempts: u32,
    pub dlq_suffix: String,
    pub dlq_attempt_ttl_secs: u64,
}

impl ClickhouseConfig {
    pub fn from_env() -> Self {
        Self {
            redis_url: env_or("REDIS_URL", "redis://localhost:6379"),
            clickhouse_url: env_or("CLICKHOUSE_URL", "http://localhost:8123"),
            clickhouse_database: env_or("CLICKHOUSE_DATABASE", "chain_analysis"),
            clickhouse_user: env_or("CLICKHOUSE_USER", "default"),
            clickhouse_password: env_or("CLICKHOUSE_PASSWORD", ""),
            batch_size: env_or_parse("CLICKHOUSE_BATCH_SIZE", 1000usize),
            consumer_group: env_or("CLICKHOUSE_CONSUMER_GROUP", "chain-analysis-clickhouse"),
            consumer_name: env_or(
                "CLICKHOUSE_CONSUMER_NAME",
                &format!("ch-consumer-{}", std::process::id()),
            ),
            dlq_max_attempts: env_or_parse("CLICKHOUSE_DLQ_MAX_ATTEMPTS", 5u32),
            dlq_suffix: env_or("CLICKHOUSE_DLQ_SUFFIX", "_dlq"),
            dlq_attempt_ttl_secs: env_or_parse("CLICKHOUSE_DLQ_ATTEMPT_TTL_SECS", 86_400u64),
        }
    }
}

impl ProcessConfig {
    pub fn from_env() -> Self {
        Self {
            redis_url: env_or("REDIS_URL", "redis://localhost:6379"),
            neo4j_uri: env_or("NEO4J_URI", "bolt://localhost:7687"),
            neo4j_user: env_or("NEO4J_USER", "neo4j"),
            neo4j_password: env_or("NEO4J_PASSWORD", "password123"),
            neo4j_database: env_or("NEO4J_DATABASE", "neo4j"),
            postgres_url: env_or(
                "DATABASE_URL",
                "postgresql://postgres:postgres123@localhost:5432/chain_analysis",
            ),
            batch_size: env_or_parse("PROCESS_BATCH_SIZE", 500),
            consumer_group: env_or("PROCESS_CONSUMER_GROUP", "chain-analysis-process"),
            consumer_name: env_or(
                "PROCESS_CONSUMER_NAME",
                &format!("consumer-{}", std::process::id()),
            ),
            dlq_max_attempts: env_or_parse("PROCESS_DLQ_MAX_ATTEMPTS", 5u32),
            dlq_suffix: env_or("PROCESS_DLQ_SUFFIX", "_dlq"),
            dlq_attempt_ttl_secs: env_or_parse("PROCESS_DLQ_ATTEMPT_TTL_SECS", 86_400u64),
        }
    }
}
