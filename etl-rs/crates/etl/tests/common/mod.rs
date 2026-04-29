//! Shared testcontainers harness for end-to-end and chaos tests.
//!
//! Each test file that wants the harness should `mod common;` and call
//! `common::start_stack().await`. Tests are gated `#[ignore]` because the
//! containers take ~30-60s to spin up and require Docker.

#![allow(dead_code)]

use sqlx::PgPool;
use testcontainers::core::{ContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};
use testcontainers_modules::postgres::Postgres as PgImage;

/// Minimal Postgres schema covering the columns the worker stream consumer
/// reads/writes. Hand-written rather than running Alembic — schema drift
/// will surface here as a test failure, which is the whole point.
pub const PG_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS known_labels (
    address      text PRIMARY KEY,
    name         text,
    entity_type  text NOT NULL DEFAULT 'eoa',
    risk_level   text NOT NULL DEFAULT 'unknown',
    source       text NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS entity_features (
    address                    text NOT NULL,
    chain_id                   int  NOT NULL DEFAULT 1,
    out_degree                 int  NOT NULL DEFAULT 0,
    in_degree                  int  NOT NULL DEFAULT 0,
    unique_interacted_entities int  NOT NULL DEFAULT 0,
    volume_in_wei              numeric(78,0) NOT NULL DEFAULT 0,
    volume_out_wei             numeric(78,0) NOT NULL DEFAULT 0,
    is_labeled                 boolean NOT NULL DEFAULT false,
    first_seen_at              timestamptz,
    last_seen_at               timestamptz,
    last_synced_block          bigint,
    computed_at                timestamptz NOT NULL DEFAULT NOW(),
    updated_at                 timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (address)
);
"#;

pub struct Stack {
    pub redis: ContainerAsync<GenericImage>,
    pub pg: ContainerAsync<PgImage>,
    pub neo4j: ContainerAsync<GenericImage>,
    pub redis_url: String,
    pub pg_url: String,
    pub neo4j_uri: String,
    pub neo4j_user: String,
    pub neo4j_password: String,
}

pub async fn start_stack() -> Stack {
    // Redis: GenericImage (not the testcontainers-modules wrapper) so we can
    // enable AOF persistence — needed for chaos tests that restart Redis and
    // expect un-ACKed messages to survive.
    let redis = GenericImage::new("redis", "7-alpine")
        .with_exposed_port(ContainerPort::Tcp(6379))
        .with_wait_for(WaitFor::message_on_stdout("Ready to accept connections"))
        .with_cmd(["redis-server", "--appendonly", "yes"])
        .start()
        .await
        .expect("redis start");
    let redis_port = redis.get_host_port_ipv4(6379).await.expect("redis port");
    let redis_url = format!("redis://127.0.0.1:{}", redis_port);

    let pg = PgImage::default().start().await.expect("postgres start");
    let pg_port = pg.get_host_port_ipv4(5432).await.expect("pg port");
    let pg_url = format!("postgres://postgres:postgres@127.0.0.1:{}/postgres", pg_port);

    let neo4j = GenericImage::new("neo4j", "5.26.0")
        .with_exposed_port(ContainerPort::Tcp(7687))
        .with_exposed_port(ContainerPort::Tcp(7474))
        .with_wait_for(WaitFor::message_on_stdout("Started."))
        .with_env_var("NEO4J_AUTH", "neo4j/password123")
        .with_env_var("NEO4J_dbms_memory_pagecache_size", "256m")
        .with_env_var("NEO4J_dbms_memory_heap_max__size", "512m")
        .start()
        .await
        .expect("neo4j start");
    let bolt = neo4j.get_host_port_ipv4(7687).await.expect("bolt port");
    let neo4j_uri = format!("bolt://127.0.0.1:{}", bolt);

    Stack {
        redis,
        pg,
        neo4j,
        redis_url,
        pg_url,
        neo4j_uri,
        neo4j_user: "neo4j".to_string(),
        neo4j_password: "password123".to_string(),
    }
}

pub async fn apply_pg_schema(pool: &PgPool) {
    sqlx::raw_sql(PG_SCHEMA)
        .execute(pool)
        .await
        .expect("apply PG schema");
}
