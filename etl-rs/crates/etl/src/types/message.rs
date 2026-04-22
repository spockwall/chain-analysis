use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum IngestionMessage {
    Progress {
        run_id: String,
        current_block: u64,
        total_blocks: u64,
        transactions_processed: u64,
    },
    Complete {
        run_id: String,
        blocks_processed: u64,
        transactions_processed: u64,
    },
    Error {
        run_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProcessingMessage {
    Progress {
        run_id: String,
        stage: String,
        processed: u64,
        total: u64,
    },
    Complete {
        run_id: String,
        entities_processed: u64,
        transactions_processed: u64,
    },
    Error {
        run_id: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tagged_serde_roundtrip() {
        let msg = IngestionMessage::Progress {
            run_id: "test-123".into(),
            current_block: 100,
            total_blocks: 10,
            transactions_processed: 30,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"Progress""#));
        let parsed: IngestionMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            IngestionMessage::Progress { run_id, current_block, .. } => {
                assert_eq!(run_id, "test-123");
                assert_eq!(current_block, 100);
            }
            _ => panic!("Wrong variant"),
        }
    }

    #[test]
    fn error_variant() {
        let msg = IngestionMessage::Error {
            run_id: "r1".into(),
            message: "block fetch failed".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"Error""#));
    }
}
