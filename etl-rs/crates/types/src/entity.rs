use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum EntityType {
    EOA,
    Contract,
    Mixer,
    LendingPool,
    Bridge,
    DEX,
    CEXHotWallet,
    Application,
    Unknown,
}

impl fmt::Display for EntityType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EOA => write!(f, "EOA"),
            Self::Contract => write!(f, "Contract"),
            Self::Mixer => write!(f, "Mixer"),
            Self::LendingPool => write!(f, "LendingPool"),
            Self::Bridge => write!(f, "Bridge"),
            Self::DEX => write!(f, "DEX"),
            Self::CEXHotWallet => write!(f, "CEXHotWallet"),
            Self::Application => write!(f, "Application"),
            Self::Unknown => write!(f, "Unknown"),
        }
    }
}

impl Default for EntityType {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Unknown,
    Low,
    Medium,
    High,
    Critical,
}

impl fmt::Display for RiskLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown => write!(f, "unknown"),
            Self::Low => write!(f, "low"),
            Self::Medium => write!(f, "medium"),
            Self::High => write!(f, "high"),
            Self::Critical => write!(f, "critical"),
        }
    }
}

impl Default for RiskLevel {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entity {
    pub address: String,
    pub entity_type: EntityType,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub risk_level: RiskLevel,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub is_known: bool,
    #[serde(default)]
    pub properties: HashMap<String, serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_roundtrip() {
        let e = Entity {
            address: "0x0000000000000000000000000000000000000001".into(),
            entity_type: EntityType::EOA,
            label: Some("Test".into()),
            name: None,
            risk_level: RiskLevel::Low,
            source: Some("etherscan".into()),
            is_known: true,
            properties: HashMap::new(),
        };
        let json = serde_json::to_string(&e).unwrap();
        let parsed: Entity = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.address, e.address);
        assert_eq!(parsed.entity_type, EntityType::EOA);
        assert_eq!(parsed.risk_level, RiskLevel::Low);
    }

    #[test]
    fn entity_type_display() {
        assert_eq!(EntityType::CEXHotWallet.to_string(), "CEXHotWallet");
        assert_eq!(EntityType::EOA.to_string(), "EOA");
    }

    #[test]
    fn risk_level_display() {
        assert_eq!(RiskLevel::Critical.to_string(), "critical");
        assert_eq!(RiskLevel::Unknown.to_string(), "unknown");
    }
}
