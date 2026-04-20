use types::Transaction;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static MOCK_TIP: AtomicU64 = AtomicU64::new(0);

pub fn mock_latest_block(start_block: u64) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let old = MOCK_TIP.load(Ordering::Relaxed);
    if old == 0 {
        let init = start_block + 5;
        MOCK_TIP.store(init, Ordering::Relaxed);
        return init;
    }

    let next = old + (now % 3) + 1;
    MOCK_TIP.store(next, Ordering::Relaxed);
    next
}

pub fn generate_mock_block(block_number: u64) -> Vec<Transaction> {
    let base = block_number * 3;
    (0..3)
        .map(|i| {
            let idx = base + i;
            Transaction {
                hash: format!("0x{:064x}", idx + 1_000_000),
                from_address: format!("0x{:040x}", (idx * 7 + 1) % 1_000_000),
                to_address: format!("0x{:040x}", (idx * 13 + 2) % 1_000_000),
                value: ((idx as u128 + 1) * 1_000_000_000_000_000_000u128).to_string(),
                block_number,
                timestamp: 1_700_000_000 + block_number * 12,
                gas_used: 21_000,
                gas_price: "20000000000".into(),
                input: "0x".into(),
                contract_address: String::new(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        let a = generate_mock_block(100);
        let b = generate_mock_block(100);
        assert_eq!(a.len(), 3);
        assert_eq!(a[0].hash, b[0].hash);
        assert_eq!(a[1].from_address, b[1].from_address);
    }

    #[test]
    fn hash_format() {
        let txs = generate_mock_block(0);
        assert!(txs[0].hash.starts_with("0x"));
        assert_eq!(txs[0].hash.len(), 66);
    }

    #[test]
    fn address_format() {
        let txs = generate_mock_block(0);
        assert!(txs[0].from_address.starts_with("0x"));
        assert_eq!(txs[0].from_address.len(), 42);
    }
}
