use eyre::Result;
use std::future::Future;
use std::time::Duration;
use tracing::warn;

pub struct RetryPolicy {
    pub max_retries: u32,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub multiplier: f64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 5,
            initial_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(60),
            multiplier: 2.0,
        }
    }
}

pub async fn with_retry<F, Fut, T>(
    policy: &RetryPolicy,
    operation: &str,
    mut f: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut attempt = 0u32;
    let mut backoff = policy.initial_backoff;

    loop {
        attempt += 1;
        match f().await {
            Ok(val) => return Ok(val),
            Err(e) if attempt > policy.max_retries => {
                return Err(e.wrap_err(format!(
                    "{} failed after {} retries",
                    operation, policy.max_retries
                )));
            }
            Err(e) => {
                warn!(
                    operation,
                    attempt,
                    error = %e,
                    backoff_ms = backoff.as_millis() as u64,
                    "Retrying after error"
                );
                tokio::time::sleep(backoff).await;
                backoff = Duration::from_secs_f64(
                    backoff.as_secs_f64() * policy.multiplier,
                )
                .min(policy.max_backoff);
            }
        }
    }
}
