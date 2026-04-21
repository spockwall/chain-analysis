use tokio::sync::watch;
use tracing::info;

#[derive(Clone)]
pub struct ShutdownHandle {
    rx: watch::Receiver<bool>,
}

impl ShutdownHandle {
    pub fn is_shutdown(&self) -> bool {
        *self.rx.borrow()
    }

    pub async fn wait(&mut self) {
        while !*self.rx.borrow_and_update() {
            if self.rx.changed().await.is_err() {
                return;
            }
        }
    }
}

pub fn install_shutdown() -> ShutdownHandle {
    let (tx, rx) = watch::channel(false);

    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigint = match signal(SignalKind::interrupt()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "failed to install SIGINT handler");
                    return;
                }
            };
            let mut sigterm = match signal(SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "failed to install SIGTERM handler");
                    return;
                }
            };
            tokio::select! {
                _ = sigint.recv()  => info!("received SIGINT, initiating shutdown"),
                _ = sigterm.recv() => info!("received SIGTERM, initiating shutdown"),
            }
        }
        #[cfg(not(unix))]
        {
            if let Err(e) = tokio::signal::ctrl_c().await {
                tracing::error!(error = %e, "failed to await ctrl_c");
                return;
            }
            info!("received Ctrl+C, initiating shutdown");
        }
        let _ = tx.send(true);
    });

    ShutdownHandle { rx }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn handle_starts_not_shutdown() {
        let mut h = install_shutdown();
        assert!(!h.is_shutdown());
        // wait() must not complete immediately — prove by timing out
        let res = tokio::time::timeout(Duration::from_millis(10), h.wait()).await;
        assert!(res.is_err(), "wait() completed before signal was sent");
        assert!(!h.is_shutdown());
    }

    #[tokio::test]
    async fn handle_clone_sees_same_state() {
        let h = install_shutdown();
        let h2 = h.clone();
        assert_eq!(h.is_shutdown(), h2.is_shutdown());
    }
}
