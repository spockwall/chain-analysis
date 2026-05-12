//! A [`BlockSource`] that delegates to an ordered list of underlying sources,
//! falling back to the next on **recoverable** errors (HTTP 429, 5xx,
//! connection/DNS, timeout). Hard errors (auth, parse, missing data) propagate
//! immediately so we don't mask a real bug by silently switching tiers.
//!
//! Typical configuration: `[etherscan, alchemy, public_rpc]` — Etherscan
//! free-tier is the cheapest 5 req/s, Alchemy provides headroom when a paid
//! key is configured, public RPC catches the rest. The order is set when the
//! `FailoverSource` is constructed; each method tries them top-down.
//!
//! Per-source rate limiting is **out of scope here** — see the Redis
//! token-bucket limiter in `sources::rate_limiter`. This module only handles
//! the "which source did the call land on" question.

use async_trait::async_trait;
use eyre::{eyre, Result};
use std::sync::Arc;
use tracing::warn;

use super::block_source::BlockSource;
use crate::types::{Trace, Transaction, Transfer};

pub struct FailoverSource {
    sources: Vec<Arc<dyn BlockSource>>,
}

impl FailoverSource {
    /// Construct from an ordered list (highest priority first). Empty list
    /// is rejected to surface a misconfiguration at startup rather than
    /// later as a confusing "all sources exhausted" error per call.
    pub fn new(sources: Vec<Arc<dyn BlockSource>>) -> Result<Self> {
        if sources.is_empty() {
            return Err(eyre!(
                "FailoverSource requires at least one underlying source"
            ));
        }
        Ok(Self { sources })
    }

    pub fn tier_names(&self) -> Vec<&'static str> {
        self.sources.iter().map(|s| s.name()).collect()
    }
}

/// Classify an error from an underlying source: recoverable means the
/// failover ladder should try the next tier; hard means propagate.
///
/// Conservative: only match on patterns that genuinely indicate transient
/// provider trouble. Anything else (auth, malformed response) is hard so
/// we don't mask real bugs by silently switching tiers.
fn is_recoverable(err: &eyre::Report) -> bool {
    let s = format!("{:#}", err).to_lowercase();
    // HTTP rate limit
    s.contains("429") || s.contains("rate limit") || s.contains("too many requests")
        // HTTP 5xx — the alchemy/etherscan callers stringify status as
        // "HTTP 5xx" so a substring match is enough.
        || s.contains("http 50") || s.contains("http 51") || s.contains("http 52")
        || s.contains("http 53") || s.contains("http 54") || s.contains("http 59")
        // Network / DNS
        || s.contains("timeout") || s.contains("timed out")
        || s.contains("connection") || s.contains("dns")
        // reqwest's "error sending request" — typically a transport failure
        || s.contains("error sending request")
}

/// Try each source in order; on a recoverable error, log and continue;
/// on a hard error, return immediately; on success, return the value.
/// Designed as a generic so all five `BlockSource` methods share the same
/// loop without duplicated logic.
async fn try_each<T, F, Fut>(
    sources: &[Arc<dyn BlockSource>],
    op_name: &'static str,
    mut op: F,
) -> Result<T>
where
    F: FnMut(Arc<dyn BlockSource>) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut last_err: Option<eyre::Report> = None;
    for src in sources {
        match op(Arc::clone(src)).await {
            Ok(v) => return Ok(v),
            Err(e) if is_recoverable(&e) => {
                warn!(
                    op = op_name,
                    source = src.name(),
                    error = %e,
                    "failover: recoverable error, trying next tier"
                );
                last_err = Some(e);
                continue;
            }
            Err(e) => {
                // Non-recoverable: don't burn budget on the next tier.
                return Err(e.wrap_err(format!(
                    "{} failed (non-recoverable) on source {}",
                    op_name,
                    src.name()
                )));
            }
        }
    }
    Err(last_err
        .unwrap_or_else(|| eyre!("{}: all sources exhausted with no error", op_name))
        .wrap_err(format!("{}: all sources exhausted", op_name)))
}

#[async_trait]
impl BlockSource for FailoverSource {
    fn name(&self) -> &'static str {
        "failover"
    }

    async fn latest_block(&self) -> Result<u64> {
        try_each(&self.sources, "latest_block", |s| async move {
            s.latest_block().await
        })
        .await
    }

    async fn fetch_block(&self, block_num: u64) -> Result<Vec<Transaction>> {
        try_each(&self.sources, "fetch_block", |s| async move {
            s.fetch_block(block_num).await
        })
        .await
    }

    async fn fetch_traces(&self, block_num: u64) -> Result<Vec<Trace>> {
        try_each(&self.sources, "fetch_traces", |s| async move {
            s.fetch_traces(block_num).await
        })
        .await
    }

    async fn fetch_transfers(&self, block_num: u64) -> Result<Vec<Transfer>> {
        try_each(&self.sources, "fetch_transfers", |s| async move {
            s.fetch_transfers(block_num).await
        })
        .await
    }

    async fn fetch_tx_by_hash(&self, tx_hash: &str) -> Result<Option<Transaction>> {
        try_each(&self.sources, "fetch_tx_by_hash", |s| {
            let h = tx_hash.to_string();
            async move { s.fetch_tx_by_hash(&h).await }
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Minimal mock source for testing failover behaviour. Each method
    /// returns `Err(canned)` on the first `failures_remaining` calls then
    /// `Ok(default)` thereafter.
    struct MockSource {
        name: &'static str,
        latest_block_responses: Mutex<Vec<Result<u64>>>,
    }

    impl MockSource {
        fn new(name: &'static str, responses: Vec<Result<u64>>) -> Self {
            Self {
                name,
                latest_block_responses: Mutex::new(responses),
            }
        }
    }

    #[async_trait]
    impl BlockSource for MockSource {
        fn name(&self) -> &'static str {
            self.name
        }
        async fn latest_block(&self) -> Result<u64> {
            let mut q = self.latest_block_responses.lock().unwrap();
            if q.is_empty() {
                return Err(eyre!("mock {}: exhausted responses", self.name));
            }
            q.remove(0)
        }
        async fn fetch_block(&self, _: u64) -> Result<Vec<Transaction>> {
            unimplemented!()
        }
        async fn fetch_traces(&self, _: u64) -> Result<Vec<Trace>> {
            unimplemented!()
        }
        async fn fetch_transfers(&self, _: u64) -> Result<Vec<Transfer>> {
            unimplemented!()
        }
        async fn fetch_tx_by_hash(&self, _: &str) -> Result<Option<Transaction>> {
            unimplemented!()
        }
    }

    #[test]
    fn is_recoverable_classifies_429() {
        let e = eyre!("HTTP 429 too many requests");
        assert!(is_recoverable(&e));
    }

    #[test]
    fn is_recoverable_classifies_5xx() {
        let e = eyre!("HTTP 502 Bad Gateway");
        assert!(is_recoverable(&e));
    }

    #[test]
    fn is_recoverable_classifies_timeout() {
        let e = eyre!("operation timed out");
        assert!(is_recoverable(&e));
    }

    #[test]
    fn is_recoverable_rejects_auth() {
        let e = eyre!("HTTP 401 Unauthorized: invalid api key");
        assert!(!is_recoverable(&e));
    }

    #[test]
    fn is_recoverable_rejects_parse() {
        let e = eyre!("missing result field for eth_blockNumber");
        assert!(!is_recoverable(&e));
    }

    #[test]
    fn new_rejects_empty() {
        assert!(FailoverSource::new(vec![]).is_err());
    }

    #[tokio::test]
    async fn first_source_success_returns_immediately() {
        let primary = Arc::new(MockSource::new("primary", vec![Ok(100)]));
        let secondary = Arc::new(MockSource::new("secondary", vec![Ok(999)]));
        let f = FailoverSource::new(vec![primary, secondary]).unwrap();
        assert_eq!(f.latest_block().await.unwrap(), 100);
    }

    #[tokio::test]
    async fn falls_back_on_recoverable_error() {
        let primary = Arc::new(MockSource::new(
            "primary",
            vec![Err(eyre!("HTTP 429 rate limit"))],
        ));
        let secondary = Arc::new(MockSource::new("secondary", vec![Ok(200)]));
        let f = FailoverSource::new(vec![primary, secondary]).unwrap();
        assert_eq!(f.latest_block().await.unwrap(), 200);
    }

    #[tokio::test]
    async fn stops_on_hard_error() {
        let primary = Arc::new(MockSource::new(
            "primary",
            vec![Err(eyre!("HTTP 401 Unauthorized"))],
        ));
        let secondary = Arc::new(MockSource::new("secondary", vec![Ok(200)]));
        let f = FailoverSource::new(vec![primary, secondary]).unwrap();
        let err = f.latest_block().await.unwrap_err();
        let msg = format!("{:#}", err);
        assert!(msg.contains("non-recoverable"), "got: {}", msg);
    }

    #[tokio::test]
    async fn all_recoverable_errors_exhausts_with_last() {
        let primary = Arc::new(MockSource::new("primary", vec![Err(eyre!("HTTP 429"))]));
        let secondary = Arc::new(MockSource::new(
            "secondary",
            vec![Err(eyre!("connection refused"))],
        ));
        let f = FailoverSource::new(vec![primary, secondary]).unwrap();
        let err = f.latest_block().await.unwrap_err();
        let msg = format!("{:#}", err);
        assert!(msg.contains("all sources exhausted"), "got: {}", msg);
    }
}
