//! Prometheus metrics server shared by the Rust ETL binaries.
//!
//! Call [`init`] once during binary startup. It spins up a background HTTP
//! listener on `0.0.0.0:{METRICS_PORT}` (default 9100) that serves
//! `/metrics` in the Prometheus text exposition format.
//!
//! Metric name constants are exported so call sites don't stringly-reference
//! names and dashboards can reuse the same identifiers.

use std::net::SocketAddr;

use eyre::Result;
use metrics_exporter_prometheus::PrometheusBuilder;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Metric names — keep in sync with Grafana dashboards under
// compose/grafana/dashboards/.
// ---------------------------------------------------------------------------

// Ingest tier
pub const INGEST_BLOCKS_FETCHED: &str = "ingest_blocks_fetched_total";
pub const INGEST_BLOCKS_FAILED: &str = "ingest_blocks_failed_total";
pub const INGEST_FETCH_DURATION: &str = "ingest_fetch_duration_seconds";

// Stream publisher
pub const STREAM_MESSAGES_PUBLISHED: &str = "stream_messages_published_total";
pub const STREAM_MAXLEN_TRIMS: &str = "stream_maxlen_trims_total";

// Consumer tier
pub const CONSUMER_BATCHES_PROCESSED: &str = "consumer_batches_processed_total";
pub const CONSUMER_MESSAGES_PROCESSED: &str = "consumer_messages_processed_total";
pub const CONSUMER_PARSE_FAILURES: &str = "consumer_parse_failures_total";
pub const CONSUMER_BATCH_DURATION: &str = "consumer_batch_duration_seconds";

// DLQ
pub const DLQ_MOVES: &str = "dlq_moves_total";
pub const DLQ_MESSAGES_MOVED: &str = "dlq_messages_moved_total";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/// Default port; overridable via `METRICS_PORT` env var at the call site.
pub const DEFAULT_METRICS_PORT: u16 = 9100;

/// Start a Prometheus scrape endpoint on `0.0.0.0:{port}/metrics`.
///
/// Fails fast if the port is already bound. Callers may log and continue so a
/// port collision doesn't take the whole worker down.
pub fn init(service: &'static str, port: u16) -> Result<()> {
    let addr: SocketAddr = ([0, 0, 0, 0], port).into();
    let builder = PrometheusBuilder::new()
        .with_http_listener(addr)
        .add_global_label("service", service);

    builder
        .install()
        .map_err(|e| eyre::eyre!("failed to install prometheus exporter on {addr}: {e}"))?;

    describe_metrics();
    info!(service, %addr, "metrics exporter listening");
    Ok(())
}

/// Same as [`init`] but logs the error instead of propagating — useful when
/// the worker should keep running even if the metrics port is busy (e.g.
/// when multiple consumers share a host in tests).
pub fn init_best_effort(service: &'static str, port: u16) {
    if let Err(e) = init(service, port) {
        warn!(%e, "metrics exporter not started; continuing without metrics");
    }
}

fn describe_metrics() {
    use metrics::{describe_counter, describe_histogram, Unit};

    describe_counter!(
        INGEST_BLOCKS_FETCHED,
        "Blocks successfully fetched from a source (labels: source)"
    );
    describe_counter!(
        INGEST_BLOCKS_FAILED,
        "Block fetches that terminally failed (labels: source)"
    );
    describe_histogram!(
        INGEST_FETCH_DURATION,
        Unit::Seconds,
        "Wall time of a single block fetch (labels: source)"
    );

    describe_counter!(
        STREAM_MESSAGES_PUBLISHED,
        "Messages XADDed to a Redis stream (labels: stream)"
    );
    describe_counter!(
        STREAM_MAXLEN_TRIMS,
        "Number of XADD calls that performed MAXLEN trimming (labels: stream)"
    );

    describe_counter!(
        CONSUMER_BATCHES_PROCESSED,
        "Consumer batches successfully processed (labels: group, outcome)"
    );
    describe_counter!(
        CONSUMER_MESSAGES_PROCESSED,
        "Individual messages processed across all streams (labels: group, stream)"
    );
    describe_counter!(
        CONSUMER_PARSE_FAILURES,
        "JSON parse failures on stream messages (labels: group, stream)"
    );
    describe_histogram!(
        CONSUMER_BATCH_DURATION,
        Unit::Seconds,
        "Wall time to process one batch end-to-end (labels: group)"
    );

    describe_counter!(
        DLQ_MOVES,
        "Batches moved to a DLQ stream after exceeding max attempts (labels: stream)"
    );
    describe_counter!(
        DLQ_MESSAGES_MOVED,
        "Individual messages moved to DLQ streams (labels: stream)"
    );
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

/// Hold-onto-this handle returned by [`init_tracing`]. Drops the underlying
/// `WorkerGuard`s when it goes out of scope, which flushes any buffered log
/// lines.
///
/// **Bind to a named variable in `main()`**, never bare `_`:
///
/// ```ignore
/// let _logging = etl::observability::init_tracing("worker");   // ✅ flushes on shutdown
/// let _ = etl::observability::init_tracing("worker");          // ❌ drops immediately, logs lost
/// ```
pub struct LoggingHandle {
    _guards: Vec<tracing_appender::non_blocking::WorkerGuard>,
}

/// Initialise tracing with three sinks layered together:
///
/// 1. **stdout** (always on) — for `docker logs` / `kubectl logs` / local dev.
///    Wrapped in `tracing_appender::non_blocking` so the call site doesn't
///    block on stdout I/O.
/// 2. **`{LOG_DIR}/{service}.log`** (when `LOG_DIR` env var is set) — daily
///    rotated full log, all levels honoured by `RUST_LOG`.
/// 3. **`{LOG_DIR}/{service}.error.log`** (when `LOG_DIR` env var is set) —
///    daily rotated, `WARN` and above only. Convenient for alerting / triage.
///
/// `LOG_DIR` must already exist and be writable; the rolling appender creates
/// only the per-day file, not the parent directory. In Docker, mount a host
/// directory or named volume at this path. Set `RUST_LOG=info,etl=debug` (or
/// similar) to control verbosity; the per-layer filter on the error file is
/// always at least `WARN`.
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

    let log_dir = std::env::var("LOG_DIR").ok().filter(|s| !s.is_empty());

    if let Some(ref dir) = log_dir {
        // Main file: all levels (subject to global EnvFilter).
        let main_file = tracing_appender::rolling::daily(dir, format!("{}.log", service));
        let (main_writer, main_guard) = tracing_appender::non_blocking(main_file);
        guards.push(main_guard);
        let main_layer = fmt::layer()
            .with_writer(main_writer)
            .with_ansi(false);

        // Error-only file: warn+. Per-layer filter intersects with the global
        // EnvFilter, so this is "warn or higher AND whatever EnvFilter allows".
        let err_file = tracing_appender::rolling::daily(dir, format!("{}.error.log", service));
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
            log_dir = %dir,
            "tracing initialised (stdout + {service}.log + {service}.error.log, daily rotation)",
            service = service,
        );
    } else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(stdout_layer)
            .init();

        info!(
            service,
            "tracing initialised (stdout only; set LOG_DIR for file output)"
        );
    }

    LoggingHandle { _guards: guards }
}
