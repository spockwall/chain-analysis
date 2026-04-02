use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transfer {
    pub transaction_hash: String,
    #[serde(default)]
    pub log_index: u64,
    pub token_address: String,
    pub from_address: String,
    pub to_address: String,
    pub value: String,
    pub block_number: u64,
    #[serde(default)]
    pub timestamp: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_roundtrip() {
        let t = Transfer {
            transaction_hash: "0x01".into(),
            log_index: 0,
            token_address: "0xdac17f958d2ee523a2206206994597c13d831ec7".into(),
            from_address: "0xaaa".into(),
            to_address: "0xbbb".into(),
            value: "1000000".into(),
            block_number: 18000000,
            timestamp: 1700000000,
        };
        let json = serde_json::to_string(&t).unwrap();
        let parsed: Transfer = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.token_address, t.token_address);
        assert_eq!(parsed.value, "1000000");
    }
}
