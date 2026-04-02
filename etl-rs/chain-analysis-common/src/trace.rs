use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trace {
    pub transaction_hash: String,
    pub from_address: String,
    pub to_address: String,
    pub value: String,
    pub trace_type: String,
    #[serde(default)]
    pub call_type: Option<String>,
    #[serde(default)]
    pub gas: u64,
    #[serde(default)]
    pub gas_used: u64,
    #[serde(default = "default_input")]
    pub input: String,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub error: Option<String>,
    pub block_number: u64,
    #[serde(default)]
    pub trace_address: Vec<u32>,
}

fn default_input() -> String {
    "0x".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_roundtrip() {
        let t = Trace {
            transaction_hash: "0x01".into(),
            from_address: "0xaaa".into(),
            to_address: "0xbbb".into(),
            value: "1000".into(),
            trace_type: "call".into(),
            call_type: Some("call".into()),
            gas: 21000,
            gas_used: 21000,
            input: "0x".into(),
            output: "0x".into(),
            error: None,
            block_number: 100,
            trace_address: vec![0],
        };
        let json = serde_json::to_string(&t).unwrap();
        let parsed: Trace = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.transaction_hash, "0x01");
        assert_eq!(parsed.trace_type, "call");
    }
}
