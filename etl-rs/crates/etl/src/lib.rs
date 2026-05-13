//! `etl` — the single library crate shared by every chain-analysis Rust
//! binary. Each submodule below used to be a standalone crate; they were
//! collapsed to remove boilerplate and to let small helpers share a
//! Cargo.toml.
//!
//! Layout:
//!
//! - [`config`]         — env-driven configuration (one struct per subsystem)
//! - [`logging`]        — async tracing setup (stdout + rotating log files)
//! - [`observability`]  — Prometheus exporter + metric-name constants
//! - [`types`]          — serde value types shared across tiers
//! - [`sources`]        — `BlockSource` trait + Etherscan / Alchemy / mock impls
//! - [`sinks`]          — Neo4j / Postgres / Redis / ClickHouse writers + readers
//! - [`pipeline`]       — retry, shutdown, DLQ, progress reporters
//! - [`ingest`]         — fetch-tier orchestration (block range, address, targeted)
//! - [`consumer`]       — Redis-streams → Neo4j+Postgres processor

pub mod config;
pub mod consumer;
pub mod dlq;
pub mod ingest;
pub mod logging;
pub mod observability;
pub mod pipeline;
pub mod sinks;
pub mod sources;
pub mod types;
