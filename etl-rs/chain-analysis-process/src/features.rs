use chain_analysis_common::{Entity, EntityFeatures, Transaction};
use std::collections::{HashMap, HashSet};

pub fn compute_features(entities: &[Entity], txs: &[Transaction]) -> Vec<EntityFeatures> {
    let mut acc: HashMap<String, FeatureAccumulator> = HashMap::new();

    for entity in entities {
        acc.insert(
            entity.address.clone(),
            FeatureAccumulator {
                entity: entity.clone(),
                tx_count_in: 0,
                tx_count_out: 0,
                volume_in: 0u128,
                volume_out: 0u128,
                counterparties_in: HashSet::new(),
                counterparties_out: HashSet::new(),
                first_seen: None,
                last_seen: None,
            },
        );
    }

    for tx in txs {
        let from = tx.from_address.to_lowercase();
        let to = tx.to_address.to_lowercase();
        let value: u128 = tx.value.parse().unwrap_or(0);
        let ts = tx.timestamp;

        if let Some(f) = acc.get_mut(&from) {
            f.tx_count_out += 1;
            f.volume_out += value;
            if !to.is_empty() {
                f.counterparties_out.insert(to.clone());
            }
            update_timestamps(f, ts);
        }

        if let Some(f) = acc.get_mut(&to) {
            f.tx_count_in += 1;
            f.volume_in += value;
            if !from.is_empty() {
                f.counterparties_in.insert(from.clone());
            }
            update_timestamps(f, ts);
        }
    }

    acc.into_values()
        .map(|f| EntityFeatures {
            address: f.entity.address,
            entity_type: f.entity.entity_type,
            label: f.entity.label,
            risk_level: f.entity.risk_level,
            tx_count_in: f.tx_count_in,
            tx_count_out: f.tx_count_out,
            volume_in: f.volume_in.to_string(),
            volume_out: f.volume_out.to_string(),
            unique_counterparties_in: f.counterparties_in.len() as u64,
            unique_counterparties_out: f.counterparties_out.len() as u64,
            first_seen: f.first_seen,
            last_seen: f.last_seen,
        })
        .collect()
}

struct FeatureAccumulator {
    entity: Entity,
    tx_count_in: u64,
    tx_count_out: u64,
    volume_in: u128,
    volume_out: u128,
    counterparties_in: HashSet<String>,
    counterparties_out: HashSet<String>,
    first_seen: Option<u64>,
    last_seen: Option<u64>,
}

fn update_timestamps(f: &mut FeatureAccumulator, ts: u64) {
    if ts == 0 {
        return;
    }
    match f.first_seen {
        None => f.first_seen = Some(ts),
        Some(prev) if ts < prev => f.first_seen = Some(ts),
        _ => {}
    }
    match f.last_seen {
        None => f.last_seen = Some(ts),
        Some(prev) if ts > prev => f.last_seen = Some(ts),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chain_analysis_common::entity::{EntityType, RiskLevel};

    fn make_entity(addr: &str) -> Entity {
        Entity {
            address: addr.into(),
            entity_type: EntityType::EOA,
            label: None,
            name: None,
            risk_level: RiskLevel::Unknown,
            source: None,
            is_known: false,
            properties: HashMap::new(),
        }
    }

    fn make_tx(from: &str, to: &str, value: &str, ts: u64) -> Transaction {
        Transaction {
            hash: format!("0x{:064x}", ts),
            from_address: from.into(),
            to_address: to.into(),
            value: value.into(),
            block_number: 1,
            timestamp: ts,
            gas_used: 21000,
            gas_price: "0".into(),
            input: "0x".into(),
            contract_address: String::new(),
        }
    }

    #[test]
    fn basic_feature_computation() {
        let entities = vec![make_entity("0xa"), make_entity("0xb")];
        let txs = vec![
            make_tx("0xa", "0xb", "1000000000000000000", 100),
            make_tx("0xa", "0xb", "2000000000000000000", 200),
        ];
        let features = compute_features(&entities, &txs);

        let a = features.iter().find(|f| f.address == "0xa").unwrap();
        assert_eq!(a.tx_count_out, 2);
        assert_eq!(a.tx_count_in, 0);
        assert_eq!(a.volume_out, "3000000000000000000");
        assert_eq!(a.unique_counterparties_out, 1);
        assert_eq!(a.first_seen, Some(100));
        assert_eq!(a.last_seen, Some(200));

        let b = features.iter().find(|f| f.address == "0xb").unwrap();
        assert_eq!(b.tx_count_in, 2);
        assert_eq!(b.volume_in, "3000000000000000000");
    }

    #[test]
    fn empty_inputs() {
        let features = compute_features(&[], &[]);
        assert!(features.is_empty());
    }
}
