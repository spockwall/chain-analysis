//! Async, non-blocking tracing setup shared by every Rust ETL binary.
//!
//! Layers (all daily-rotated, ANSI-stripped on disk):
//! 1. stdout — for `docker logs` / `kubectl logs` / local terminal.
//! 2. `{log_dir}/{service}.log` — full log, all levels honoured by `RUST_LOG`.
//! 3. `{log_dir}/{service}.error.log` — `WARN`+ only.
//! 4. Per-feature splits, one **subdirectory** per feature, each containing
//!    one `{service}.log` filtered by target prefix:
//!    - `{log_dir}/ingest/{service}.log`     — `target = etl::ingest::*`
//!    - `{log_dir}/pipeline/{service}.log`   — `target = etl::pipeline`
//!    - `{log_dir}/sinks/{service}.log`      — `target = etl::sinks::*`
//!    - `{log_dir}/consumers/{service}.log`  — `target = etl::consumer::*`
//!
//! Operators wanting "give me everything for today" still tail
//! `{log_dir}/{service}.log`; the per-feature folders are for narrowing —
//! e.g. an oncall investigating a Redis consumer issue can
//! `tail -f logs/consumers/worker.log` without 30 hz of refresh and ingest
//! noise.
//!
//! Each binary's `main()` calls [`init_tracing`] once at startup and binds
//! the returned [`LoggingHandle`] to a named local. When the handle drops
//! (at process exit), the underlying [`tracing_appender::non_blocking`]
//! workers flush their buffers.

use tracing::info;
use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_appender::rolling::RollingFileAppender;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer;

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
    _guards: Vec<WorkerGuard>,
}

/// Default log directory used when `LOG_DIR` env var isn't set. Created on
/// startup if it doesn't exist. In Docker you'll typically override via
/// `LOG_DIR=/var/log/chain-analysis` + a volume mount; for local dev the
/// default is fine and zero-config.
pub const DEFAULT_LOG_DIR: &str = "./logs";

/// Initialise tracing with the layer stack documented at the module level.
///
/// `log_dir` resolves to (in order):
///   1. `$LOG_DIR` env var, if set and non-empty
///   2. Otherwise [`DEFAULT_LOG_DIR`] (`./logs/`)
///
/// The directory is `mkdir -p`'d on first use. If creation fails (e.g.
/// read-only filesystem, permission denied), file output silently falls back
/// to stdout-only and a warning is logged to stderr.
///
/// Set `RUST_LOG=info,etl=debug` (or similar) to control verbosity. The
/// per-feature filters do **not** raise the verbosity above what `RUST_LOG`
/// allows — they only narrow by target. The `WARN`+ layer on
/// `{service}.error.log` still applies its own level floor regardless.
///
/// All sinks use the **lossy** non-blocking mode by default — when the
/// channel fills, lines are dropped silently and `NonBlocking::error_counter()`
/// increments. For an ETL pipeline writing to container stdout this is the
/// right trade-off (we trust metrics over logs at saturation).
pub fn init_tracing(service: &str) -> LoggingHandle {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let mut guards: Vec<WorkerGuard> = Vec::new();

    // stdout sink — keep ANSI colours for terminal viewing.
    let (stdout_writer, stdout_guard) = tracing_appender::non_blocking(std::io::stdout());
    guards.push(stdout_guard);
    let stdout_layer = fmt::layer().with_writer(stdout_writer);

    let log_dir = std::env::var("LOG_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_LOG_DIR.to_string());

    let dir_ready = match std::fs::create_dir_all(&log_dir) {
        Ok(_) => true,
        Err(e) => {
            // eprintln! because the subscriber isn't installed yet.
            eprintln!(
                "warn: could not create log dir {:?}: {}; falling back to stdout-only",
                log_dir, e
            );
            false
        }
    };

    // Helper: open a daily-rotating file, register its flush guard, and return
    // the writer. Pulled out so the per-feature loop is two lines.
    fn open_log(
        log_dir: &str,
        filename: String,
        guards: &mut Vec<WorkerGuard>,
    ) -> NonBlocking {
        let appender: RollingFileAppender =
            tracing_appender::rolling::daily(log_dir, filename);
        let (writer, guard) = tracing_appender::non_blocking(appender);
        guards.push(guard);
        writer
    }

    // Helper for per-feature subdir layout. Creates `{log_dir}/{subdir}` if
    // missing, then opens a daily-rotating `{service}.log` inside it.
    // Returns `None` if the subdir can't be created (rare — usually means a
    // permission issue we already won past on the parent dir), in which case
    // the caller skips that feature layer.
    fn open_log_subdir(
        log_dir: &str,
        subdir: &str,
        service: &str,
        guards: &mut Vec<WorkerGuard>,
    ) -> Option<NonBlocking> {
        let dir_path = format!("{}/{}", log_dir, subdir);
        if let Err(e) = std::fs::create_dir_all(&dir_path) {
            eprintln!(
                "warn: could not create log subdir {:?}: {}; feature split skipped",
                dir_path, e
            );
            return None;
        }
        Some(open_log(&dir_path, format!("{}.log", service), guards))
    }

    // Build the conditional layers. Each is `Option<L>`; tracing's
    // `Layer for Option<L>` makes `None` a no-op so we can chain `.with(opt)`
    // unconditionally without type-erasing into a `Box<dyn>`.
    let main_layer = dir_ready.then(|| {
        let writer = open_log(&log_dir, format!("{}.log", service), &mut guards);
        fmt::layer().with_writer(writer).with_ansi(false)
    });

    let err_layer = dir_ready.then(|| {
        let writer = open_log(&log_dir, format!("{}.error.log", service), &mut guards);
        fmt::layer()
            .with_writer(writer)
            .with_ansi(false)
            .with_filter(LevelFilter::WARN)
    });

    let ingest_layer = dir_ready
        .then(|| open_log_subdir(&log_dir, "ingest", service, &mut guards))
        .flatten()
        .map(|writer| {
            fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_filter(Targets::new().with_target("etl::ingest", LevelFilter::TRACE))
        });

    let pipeline_layer = dir_ready
        .then(|| open_log_subdir(&log_dir, "pipeline", service, &mut guards))
        .flatten()
        .map(|writer| {
            fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_filter(Targets::new().with_target("etl::pipeline", LevelFilter::TRACE))
        });

    let sinks_layer = dir_ready
        .then(|| open_log_subdir(&log_dir, "sinks", service, &mut guards))
        .flatten()
        .map(|writer| {
            fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_filter(Targets::new().with_target("etl::sinks", LevelFilter::TRACE))
        });

    let consumers_layer = dir_ready
        .then(|| open_log_subdir(&log_dir, "consumers", service, &mut guards))
        .flatten()
        .map(|writer| {
            fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_filter(Targets::new().with_target("etl::consumer", LevelFilter::TRACE))
        });

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stdout_layer)
        .with(main_layer)
        .with(err_layer)
        .with(ingest_layer)
        .with(pipeline_layer)
        .with(sinks_layer)
        .with(consumers_layer)
        .init();

    if dir_ready {
        info!(
            service,
            log_dir = %log_dir,
            "tracing initialised (stdout + {svc}.log + {svc}.error.log + {{ingest,pipeline,sinks,consumers}}/{svc}.log subdirs, daily rotation)",
            svc = service,
        );
    } else {
        info!(service, "tracing initialised (stdout only; log dir unavailable)");
    }

    LoggingHandle { _guards: guards }
}
