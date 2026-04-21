# Multi-stage build for the Rust ETL binaries.
# Builds `ingest`, `process`, and `clickhouse-process` in one pass and
# produces three minimal runtime images (selectable by --target).

FROM rust:1.89-slim-bookworm AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

RUN cargo build --release --workspace --bins


FROM debian:bookworm-slim AS runtime-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*


FROM runtime-base AS ingest
COPY --from=builder /build/target/release/ingest /usr/local/bin/ingest
ENTRYPOINT ["/usr/local/bin/ingest"]


FROM runtime-base AS process
COPY --from=builder /build/target/release/process /usr/local/bin/process
ENTRYPOINT ["/usr/local/bin/process"]


FROM runtime-base AS clickhouse-process
COPY --from=builder /build/target/release/clickhouse-process /usr/local/bin/clickhouse-process
ENTRYPOINT ["/usr/local/bin/clickhouse-process"]
