use crate::types::entity::{EntityType, RiskLevel};
use eyre::Result;
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use tracing::debug;

#[derive(Debug, Clone)]
pub struct KnownLabel {
    pub name: String,
    pub entity_type: Option<String>,
    pub risk_level: Option<String>,
    pub source: String,
}

pub struct PostgresReader {
    pool: PgPool,
}

impl PostgresReader {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn get_known_labels(
        &self,
        addresses: &[String],
    ) -> Result<HashMap<String, KnownLabel>> {
        if addresses.is_empty() {
            return Ok(HashMap::new());
        }

        let mut labels = HashMap::new();

        for chunk in addresses.chunks(500) {
            let addrs: Vec<String> = chunk.iter().map(|a| a.to_lowercase()).collect();

            let rows = sqlx::query(
                "SELECT address, name, entity_type::text, risk_level::text, source \
                 FROM known_labels \
                 WHERE LOWER(address) = ANY($1::text[])",
            )
            .bind(&addrs)
            .fetch_all(&self.pool)
            .await?;

            for row in rows {
                let address: String = row.get("address");
                let addr = address.to_lowercase();
                labels.insert(
                    addr.clone(),
                    KnownLabel {
                        name: row.get("name"),
                        entity_type: row.get("entity_type"),
                        risk_level: row.get("risk_level"),
                        source: row.get("source"),
                    },
                );
            }
        }

        debug!(count = labels.len(), "Loaded known labels from PostgreSQL");
        Ok(labels)
    }
}

pub fn parse_entity_type(s: &str) -> EntityType {
    match s {
        "EOA" => EntityType::EOA,
        "Contract" => EntityType::Contract,
        "Mixer" => EntityType::Mixer,
        "LendingPool" => EntityType::LendingPool,
        "Bridge" => EntityType::Bridge,
        "DEX" => EntityType::DEX,
        "CEXHotWallet" => EntityType::CEXHotWallet,
        "Application" => EntityType::Application,
        _ => EntityType::Unknown,
    }
}

pub fn parse_risk_level(s: &str) -> RiskLevel {
    match s.to_lowercase().as_str() {
        "low" => RiskLevel::Low,
        "medium" => RiskLevel::Medium,
        "high" => RiskLevel::High,
        "critical" => RiskLevel::Critical,
        _ => RiskLevel::Unknown,
    }
}
