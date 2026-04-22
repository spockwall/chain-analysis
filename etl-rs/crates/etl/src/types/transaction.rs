use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub hash: String,
    pub from_address: String,
    pub to_address: String,
    pub value: String,
    pub block_number: u64,
    pub timestamp: u64,
    pub gas_used: u64,
    pub gas_price: String,
    #[serde(default = "default_input")]
    pub input: String,
    #[serde(default)]
    pub contract_address: String,
}

fn default_input() -> String {
    "0x".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_roundtrip() {
        let tx = Transaction {
            hash: "0x0000000000000000000000000000000000000000000000000000000000000001".into(),
            from_address: "0x0000000000000000000000000000000000000001".into(),
            to_address: "0x0000000000000000000000000000000000000002".into(),
            value: "1000000000000000000".into(),
            block_number: 18_000_000,
            timestamp: 1_700_000_000,
            gas_used: 21_000,
            gas_price: "20000000000".into(),
            input: "0x".into(),
            contract_address: String::new(),
        };
        let json = serde_json::to_string(&tx).unwrap();
        let parsed: Transaction = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.hash, tx.hash);
        assert_eq!(parsed.from_address, tx.from_address);
        assert_eq!(parsed.value, tx.value);
    }

    #[test]
    fn deserialize_missing_optional_fields() {
        let json = r#"{"hash":"0x01","from_address":"0x01","to_address":"0x02","value":"0","block_number":1,"timestamp":0,"gas_used":0,"gas_price":"0"}"#;
        let tx: Transaction = serde_json::from_str(json).unwrap();
        assert_eq!(tx.input, "0x");
        assert_eq!(tx.contract_address, "");
    }
}
