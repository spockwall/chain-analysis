use chain_analysis_common::entity::{EntityType, RiskLevel};
use chain_analysis_common::{Entity, Trace, Transaction, Transfer};
use std::collections::HashMap;

use crate::db::postgres_reader::{self, KnownLabel};

pub struct AddressInfo {
    pub is_contract: bool,
}

pub fn extract_addresses(txs: &[Transaction]) -> HashMap<String, AddressInfo> {
    let mut addrs: HashMap<String, AddressInfo> = HashMap::new();

    for tx in txs {
        let from = tx.from_address.to_lowercase();
        let to = tx.to_address.to_lowercase();

        if !from.is_empty() {
            addrs.entry(from).or_insert(AddressInfo { is_contract: false });
        }

        if !to.is_empty() {
            addrs.entry(to.clone()).or_insert_with(|| {
                let has_input = tx.input.len() > 2;
                AddressInfo {
                    is_contract: has_input,
                }
            });
        }

        if !tx.contract_address.is_empty() {
            let ca = tx.contract_address.to_lowercase();
            addrs.insert(ca, AddressInfo { is_contract: true });
        }
    }

    addrs
}

pub fn extract_addresses_from_traces(
    traces: &[Trace],
    addrs: &mut HashMap<String, AddressInfo>,
) {
    for trace in traces {
        let from = trace.from_address.to_lowercase();
        let to = trace.to_address.to_lowercase();

        if !from.is_empty() {
            addrs.entry(from).or_insert(AddressInfo { is_contract: false });
        }

        if !to.is_empty() {
            let is_create = trace.trace_type == "create" || trace.trace_type == "create2";
            addrs
                .entry(to)
                .or_insert(AddressInfo { is_contract: is_create });
        }
    }
}

pub fn extract_addresses_from_transfers(
    transfers: &[Transfer],
    addrs: &mut HashMap<String, AddressInfo>,
) {
    for transfer in transfers {
        let from = transfer.from_address.to_lowercase();
        let to = transfer.to_address.to_lowercase();
        let token = transfer.token_address.to_lowercase();

        if !from.is_empty() {
            addrs.entry(from).or_insert(AddressInfo { is_contract: false });
        }
        if !to.is_empty() {
            addrs.entry(to).or_insert(AddressInfo { is_contract: false });
        }
        if !token.is_empty() {
            addrs.insert(token, AddressInfo { is_contract: true });
        }
    }
}

pub fn resolve_entities(
    address_info: &HashMap<String, AddressInfo>,
    known_labels: &HashMap<String, KnownLabel>,
) -> Vec<Entity> {
    let mut entities = Vec::with_capacity(address_info.len());

    for (addr, info) in address_info {
        let known = known_labels.get(addr);

        let entity_type = if let Some(label) = known {
            label
                .entity_type
                .as_deref()
                .map(postgres_reader::parse_entity_type)
                .unwrap_or_else(|| {
                    if info.is_contract {
                        EntityType::Contract
                    } else {
                        EntityType::EOA
                    }
                })
        } else if info.is_contract {
            EntityType::Contract
        } else {
            EntityType::EOA
        };

        let risk_level = known
            .and_then(|l| l.risk_level.as_deref())
            .map(postgres_reader::parse_risk_level)
            .unwrap_or(RiskLevel::Unknown);

        entities.push(Entity {
            address: addr.clone(),
            entity_type,
            label: known.map(|l| l.name.clone()),
            name: known.map(|l| l.name.clone()),
            risk_level,
            source: known.map(|l| l.source.clone()),
            is_known: known.is_some(),
            properties: HashMap::new(),
        });
    }

    entities
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_tx(from: &str, to: &str, input: &str) -> Transaction {
        Transaction {
            hash: "0x01".into(),
            from_address: from.into(),
            to_address: to.into(),
            value: "0".into(),
            block_number: 1,
            timestamp: 0,
            gas_used: 21000,
            gas_price: "0".into(),
            input: input.into(),
            contract_address: String::new(),
        }
    }

    #[test]
    fn extracts_unique_addresses() {
        let txs = vec![
            make_tx("0xaaa", "0xbbb", "0x"),
            make_tx("0xaaa", "0xccc", "0xabcdef"),
        ];
        let addrs = extract_addresses(&txs);
        assert_eq!(addrs.len(), 3);
        assert!(!addrs["0xaaa"].is_contract);
        assert!(!addrs["0xbbb"].is_contract);
        assert!(addrs["0xccc"].is_contract);
    }

    #[test]
    fn resolves_as_eoa_by_default() {
        let mut info = HashMap::new();
        info.insert("0xaaa".into(), AddressInfo { is_contract: false });
        let entities = resolve_entities(&info, &HashMap::new());
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].entity_type, EntityType::EOA);
        assert!(!entities[0].is_known);
    }

    #[test]
    fn resolves_contract_from_input() {
        let mut info = HashMap::new();
        info.insert("0xbbb".into(), AddressInfo { is_contract: true });
        let entities = resolve_entities(&info, &HashMap::new());
        assert_eq!(entities[0].entity_type, EntityType::Contract);
    }

    #[test]
    fn known_label_overrides() {
        let mut info = HashMap::new();
        info.insert("0xccc".into(), AddressInfo { is_contract: false });
        let mut known = HashMap::new();
        known.insert(
            "0xccc".into(),
            KnownLabel {
                address: "0xccc".into(),
                name: "Tornado Cash".into(),
                entity_type: Some("Mixer".into()),
                risk_level: Some("critical".into()),
                source: "ofac".into(),
            },
        );
        let entities = resolve_entities(&info, &known);
        assert_eq!(entities[0].entity_type, EntityType::Mixer);
        assert_eq!(entities[0].risk_level, RiskLevel::Critical);
        assert!(entities[0].is_known);
    }
}
