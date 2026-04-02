use eyre::Result;

pub fn hex_to_u64(hex_str: &str) -> Result<u64> {
    let stripped = hex_str
        .strip_prefix("0x")
        .or_else(|| hex_str.strip_prefix("0X"))
        .unwrap_or(hex_str);
    Ok(u64::from_str_radix(stripped, 16)?)
}

pub fn hex_to_u128(hex_str: &str) -> Result<u128> {
    let stripped = hex_str
        .strip_prefix("0x")
        .or_else(|| hex_str.strip_prefix("0X"))
        .unwrap_or(hex_str);
    Ok(u128::from_str_radix(stripped, 16)?)
}

pub fn normalize_address(addr: &str) -> String {
    if addr.is_empty() {
        return String::new();
    }
    let lower = addr.to_lowercase();
    if lower.starts_with("0x") {
        lower
    } else {
        format!("0x{}", lower)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hex_to_u64() {
        assert_eq!(hex_to_u64("0x1").unwrap(), 1);
        assert_eq!(hex_to_u64("0xff").unwrap(), 255);
        assert_eq!(hex_to_u64("0x112A880").unwrap(), 18_000_000);
        assert_eq!(hex_to_u64("0x0").unwrap(), 0);
    }

    #[test]
    fn test_hex_to_u128_large_value() {
        assert_eq!(
            hex_to_u128("0xDE0B6B3A7640000").unwrap(),
            1_000_000_000_000_000_000
        );
    }

    #[test]
    fn test_normalize_address() {
        assert_eq!(normalize_address("0xAbC123"), "0xabc123");
        assert_eq!(normalize_address(""), "");
        assert_eq!(normalize_address("AbC123"), "0xabc123");
    }
}
