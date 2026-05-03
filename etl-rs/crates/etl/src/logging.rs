//! Async, non-blocking tracing setup shared by every Rust ETL binary.
//!
//! Layers:
//! 1. stdout — for `docker logs` / `kubectl logs` / local terminal.
//! 2. `{log_dir}/{service}.log` — full log, daily rotation, all levels.
//! 3. `{log_dir}/{service}.error.log` — `WARN`+ only, daily rotation.
//!
//! Each binary's `main()` calls [`init_tracing`] once at startup and binds
//! the returned [`LoggingHandle`] to a named local. When the handle drops
//! (at process exit), the underlying [`tracing_appender::non_blocking`]
//! workers flush their buffers.

use tracing::info;

/// Hold-onto-this handle returned by [`init_tracing`]. Drops the underlying
/// `WorkerGuard`s when it goes out of scope, which flushes any buffered log
/// lines.
///
/// **Bind to a named variable in `main()`**, never bare `_`:
///
/// ```ignore
/// let _logging = etl::logging::init_tracing("worker");   // ✅ flushes on shutdown
/// let _ = etl::logging::init_tracing("worker");          // ❌ drops immediately, logs lost
/// ```
pub struct LoggingHandle {
    _guards: Vec<tracing_appender::non_blocking::WorkerGuard>,
}

/// Default log directory used when `LOG_DIR` env var isn't set. Created on
/// startup if it doesn't exist. In Docker you'll typically override via
/// `LOG_DIR=/var/log/chain-analysis` + a volume mount; for local dev the
/// default is fine and zero-config.
pub const DEFAULT_LOG_DIR: &str = "./logs";

/// Initialise tracing with three sinks layered together:
///
/// 1. **stdout** (always on) — for `docker logs` / `kubectl logs` / local dev.
///    Wrapped in `tracing_appender::non_blocking` so the call site doesn't
///    block on stdout I/O.
/// 2. **`{log_dir}/{service}.log`** — daily rotated full log, all levels
///    honoured by `RUST_LOG`.
/// 3. **`{log_dir}/{service}.error.log`** — daily rotated, `WARN` and above
///    only. Convenient for alerting / triage.
///
/// `log_dir` resolves to (in order):
///   1. `$LOG_DIR` env var, if set and non-empty
///   2. Otherwise [`DEFAULT_LOG_DIR`] (`./logs/`)
///
/// The directory is `mkdir -p`'d on first use. If creation fails (e.g.
/// read-only filesystem, permission denied), file output silently falls back
/// to stdout-only and a warning is logged to stdout.
///
/// Set `RUST_LOG=info,etl=debug` (or similar) to control verbosity; the
/// per-layer filter on the error file is always at least `WARN`.
///
/// All three sinks use the **lossy** non-blocking mode by default — when the
/// channel fills, lines are dropped silently and `NonBlocking::error_counter()`
/// increments. For an ETL pipeline writing to container stdout this is the
/// right trade-off (we trust metrics over logs at saturation).
pub fn init_tracing(service: &str) -> LoggingHandle {
    use tracing_subscriber::filter::LevelFilter;
    use tracing_subscriber::fmt;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::Layer;

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let mut guards = Vec::new();

    // stdout sink — keep ANSI colours for terminal viewing.
    let (stdout_writer, stdout_guard) = tracing_appender::non_blocking(std::io::stdout());
    guards.push(stdout_guard);
    let stdout_layer = fmt::layer().with_writer(stdout_writer);

    // Resolve the log dir and try to create it. On failure we fall back to
    // stdout-only so a misconfigured environment doesn't take the binary
    // down — log_init shouldn't be a startup hazard.
    let log_dir = std::env::var("LOG_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_LOG_DIR.to_string());
    let dir_ready = match std::fs::create_dir_all(&log_dir) {
        Ok(_) => true,
        Err(e) => {
            // Use eprintln! because the subscriber isn't installed yet.
            eprintln!(
                "warn: could not create log dir {:?}: {}; falling back to stdout-only",
                log_dir, e
            );
            false
        }
    };

    if dir_ready {
        let main_file = tracing_appender::rolling::daily(&log_dir, format!("{}.log", service));
        let (main_writer, main_guard) = tracing_appender::non_blocking(main_file);
        guards.push(main_guard);
        let main_layer = fmt::layer()
            .with_writer(main_writer)
            .with_ansi(false);

        let err_file =
            tracing_appender::rolling::daily(&log_dir, format!("{}.error.log", service));
        let (err_writer, err_guard) = tracing_appender::non_blocking(err_file);
        guards.push(err_guard);
        let err_layer = fmt::layer()
            .with_writer(err_writer)
            .with_ansi(false)
            .with_filter(LevelFilter::WARN);

        tracing_subscriber::registry()
            .with(env_filter)
            .with(stdout_layer)
            .with(main_layer)
            .with(err_layer)
            .init();

        info!(
            service,
            log_dir = %log_dir,
            "tracing initialised (stdout + {service}.log + {service}.error.log, daily rotation)",
            service = service,
        );
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(stdout_layer)
            .init();

        info!(service, "tracing initialised (stdout only; log dir unavailable)");
    }

    LoggingHandle { _guards: guards }
}
