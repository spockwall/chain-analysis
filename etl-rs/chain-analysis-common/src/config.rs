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
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            etherscan_api_key: std::env::var("ETHERSCAN_API_KEY")
                .ok()
                .filter(|s| !s.is_empty() && s != "your_etherscan_api_key_here"),
            etherscan_base_url: env_or("ETHERSCAN_BASE_URL", "https://api.etherscan.io/v2/api"),
            etherscan_chain_id: env_or_parse("ETHERSCAN_CHAIN_ID", 1),
            redis_url: env_or("REDIS_URL", "redis://localhost:6379"),
            batch_size: env_or_parse("INGEST_BATCH_SIZE", 1000),
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
        }
    }
}
