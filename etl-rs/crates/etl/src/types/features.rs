use serde::{Deserialize, Serialize};

use super::entity::{EntityType, RiskLevel};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityFeatures {
    pub address: String,
    #[serde(default)]
    pub entity_type: EntityType,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub risk_level: RiskLevel,
    #[serde(default)]
    pub tx_count_in: u64,
    #[serde(default)]
    pub tx_count_out: u64,
    #[serde(default = "default_zero_str")]
    pub volume_in: String,
    #[serde(default = "default_zero_str")]
    pub volume_out: String,
    #[serde(default)]
    pub unique_counterparties_in: u64,
    #[serde(default)]
    pub unique_counterparties_out: u64,
    #[serde(default)]
    pub first_seen: Option<u64>,
    #[serde(default)]
    pub last_seen: Option<u64>,
}

fn default_zero_str() -> String {
    "0".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_roundtrip() {
        let f = EntityFeatures {
            address: "0x01".into(),
            entity_type: EntityType::EOA,
            label: None,
            risk_level: RiskLevel::Unknown,
            tx_count_in: 5,
            tx_count_out: 3,
            volume_in: "1000000000000000000".into(),
            volume_out: "500000000000000000".into(),
            unique_counterparties_in: 2,
            unique_counterparties_out: 1,
            first_seen: Some(1700000000),
            last_seen: Some(1700001000),
        };
        let json = serde_json::to_string(&f).unwrap();
        let parsed: EntityFeatures = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.tx_count_in, 5);
        assert_eq!(parsed.volume_in, "1000000000000000000");
    }

    #[test]
    fn defaults_on_missing_fields() {
        let json = r#"{"address":"0x01"}"#;
        let f: EntityFeatures = serde_json::from_str(json).unwrap();
        assert_eq!(f.tx_count_in, 0);
        assert_eq!(f.volume_in, "0");
        assert_eq!(f.entity_type, EntityType::Unknown);
    }
}
