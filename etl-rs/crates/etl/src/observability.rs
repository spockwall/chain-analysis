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

// Targeted (Task A) — user-triggered ingest end-to-end latency.
// Time from `mark_pickup` (worker picks up the queued task) to
// `mark_terminal` (worker writes the final status). Labelled by `kind`
// (addresses / hashes / neighborhood) and `outcome` (success / failure)
// so dashboards can break down deep-trace vs single-address vs whole-hash
// fetches and separate happy-path latency from failure-path latency.
pub const LABEL_TASK_DURATION_SECONDS: &str = "label_task_duration_seconds";

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

    describe_histogram!(
        LABEL_TASK_DURATION_SECONDS,
        Unit::Seconds,
        "End-to-end worker time for a targeted task, from queue pickup to terminal status (labels: kind, outcome)"
    );
}
