# Multi-stage build for Rust ETL binaries (ingest + process)

# =============================================================================
# Stage 1: Build both binaries
# =============================================================================
FROM rust:1.86-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY chain-analysis-common/ chain-analysis-common/
COPY chain-analysis-ingest/ chain-analysis-ingest/
COPY chain-analysis-process/ chain-analysis-process/

RUN cargo build --release

# =============================================================================
# Stage 2: Shared runtime base
# =============================================================================
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*

# =============================================================================
# Stage 3a: Ingest binary
# =============================================================================
FROM runtime AS ingest

COPY --from=builder /build/target/release/ingest /usr/local/bin/ingest
ENTRYPOINT ["ingest"]

# =============================================================================
# Stage 3b: Process binary
# =============================================================================
FROM runtime AS process

COPY --from=builder /build/target/release/process /usr/local/bin/process
ENTRYPOINT ["process"]
