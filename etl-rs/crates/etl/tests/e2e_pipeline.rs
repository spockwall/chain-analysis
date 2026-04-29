//! End-to-end happy path: mock block source → Redis stream → consumer →
//! Neo4j + Postgres assertions.
//!
//! Marked `#[ignore]` because it requires Docker and ~30-60s warmup; CI runs
//! it explicitly via `cargo test --test e2e_pipeline -- --ignored`.

mod common;

use etl::ingest::{ingest_block_range_pipelined, DynBlockSource};
use etl::pipeline::{ProcessProgressReporter, ProgressReporter, RetryPolicy};
use etl::sinks::neo4j::Neo4jWriter;
use etl::sinks::postgres_reader::PostgresReader;
use etl::sinks::postgres_writer::PostgresWriter;
use etl::sinks::redis_consumer::StreamConsumer;
use etl::sinks::redis_stream::{RedisStreamWriter, TransactionWriter};
use etl::sources::mock::MockSource;
use neo4rs::{query, ConfigBuilder, Graph};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;

async fn drain_consumer(
    consumer: &mut StreamConsumer,
    pg: &PostgresReader,
    pg_writer: &PostgresWriter,
    neo4j: &Neo4jWriter,
    reporter: &mut ProcessProgressReporter,
) -> usize {
    let mut total = 0;
    let mut empty_in_a_row = 0;
    while empty_in_a_row < 2 {
        let batch = etl::consumer::read_batch(consumer)
            .await
            .expect("read_batch");
        let n = batch.txs.len() + batch.traces.len() + batch.transfers.len();
        if n == 0 {
            empty_in_a_row += 1;
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        empty_in_a_row = 0;
        total += n;
        etl::consumer::process_read_batch(consumer, pg, pg_writer, neo4j, reporter, batch)
            .await
            .expect("process_read_batch");
    }
    total
}

#[tokio::test]
#[ignore = "requires Docker; run with --ignored"]
async fn e2e_block_ingest_to_stores() {
    common::init_test_tracing();
    let stack = common::start_stack().await;

    let pg_pool = PgPool::connect(&stack.pg_url)
        .await
        .expect("pg pool connect");
    common::apply_pg_schema(&pg_pool).await;
    let pg_writer = PostgresWriter::new(pg_pool.clone());
    let pg_reader = PostgresReader::new(pg_pool.clone());

    let neo4j = Neo4jWriter::connect(
        &stack.neo4j_uri,
        &stack.neo4j_user,
        &stack.neo4j_password,
        "neo4j",
    )
    .await
    .expect("neo4j connect");

    let writer: Box<dyn TransactionWriter> = Box::new(
        RedisStreamWriter::connect(&stack.redis_url, "mock", None)
            .await
            .expect("redis writer"),
    );
    let reporter = ProgressReporter::new_dry_run("e2e-test");
    let source: DynBlockSource = Arc::new(MockSource);

    let (_w, _r, total_txs) = ingest_block_range_pipelined(
        source,
        100,
        104,
        writer,
        reporter,
        &RetryPolicy::default(),
        false,
        false,
        2,
        5,
        0,
    )
    .await
    .expect("ingest pipelined");
    assert!(total_txs > 0, "ingest should have produced txs");

    let mut consumer = StreamConsumer::connect(
        &stack.redis_url,
        "e2e-group",
        "e2e-consumer",
        100,
        500,
    )
    .await
    .expect("consumer connect");
    consumer.ensure_groups().await.expect("ensure groups");

    let mut process_reporter =
        ProcessProgressReporter::new(&stack.redis_url, "e2e-process")
            .await
            .expect("process reporter");

    let processed = drain_consumer(
        &mut consumer,
        &pg_reader,
        &pg_writer,
        &neo4j,
        &mut process_reporter,
    )
    .await;
    assert!(
        processed >= total_txs as usize,
        "consumer drained {} but ingest produced {}",
        processed,
        total_txs
    );

    let assert_graph = Graph::connect(
        ConfigBuilder::default()
            .uri(&stack.neo4j_uri)
            .user(&stack.neo4j_user)
            .password(&stack.neo4j_password)
            .db("neo4j")
            .build()
            .unwrap(),
    )
    .await
    .expect("neo4j assert graph");

    let mut graph_result = assert_graph
        .execute(query("MATCH (e:Entity) RETURN count(e) AS c"))
        .await
        .expect("count entities");
    let entity_count: i64 = graph_result
        .next()
        .await
        .expect("entities row")
        .expect("entities row some")
        .get("c")
        .expect("entities count column");
    assert!(entity_count > 0, "expected entities in Neo4j");

    let mut tx_result = assert_graph
        .execute(query("MATCH (t:Transaction) RETURN count(t) AS c"))
        .await
        .expect("count transactions");
    let tx_count: i64 = tx_result
        .next()
        .await
        .expect("tx row")
        .expect("tx row some")
        .get("c")
        .expect("tx count column");
    assert!(tx_count > 0, "expected transactions in Neo4j");

    let mut edge_result = assert_graph
        .execute(query(
            "MATCH (:Entity)-[s:SENT]->(:Transaction)-[r:RECEIVED]->(:Entity) \
             RETURN count(s) AS sent, count(r) AS recv",
        ))
        .await
        .expect("count edges");
    let edge_row = edge_result
        .next()
        .await
        .expect("edge row")
        .expect("edge row some");
    let sent: i64 = edge_row.get("sent").unwrap();
    let recv: i64 = edge_row.get("recv").unwrap();
    assert!(
        sent > 0 && recv > 0,
        "expected SENT/RECEIVED edges, got sent={}, recv={}",
        sent,
        recv
    );

    let pg_count: (i64,) = sqlx::query_as("SELECT COUNT(*)::bigint FROM entity_features")
        .fetch_one(&pg_pool)
        .await
        .expect("pg count");
    assert!(pg_count.0 > 0, "expected entity_features rows");
}
