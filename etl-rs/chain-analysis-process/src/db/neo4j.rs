use chain_analysis_common::{EntityFeatures, Trace, Transaction, Transfer};
use eyre::Result;
use neo4rs::{query, BoltList, BoltMap, BoltString, BoltType, Graph};
use tracing::{debug, info};

const NEO4J_BATCH_SIZE: usize = 1000;

fn key(s: &str) -> BoltString {
    BoltString::from(s)
}

pub struct Neo4jWriter {
    graph: Graph,
}

impl Neo4jWriter {
    pub async fn connect(uri: &str, user: &str, password: &str, db: &str) -> Result<Self> {
        let config = neo4rs::ConfigBuilder::default()
            .uri(uri)
            .user(user)
            .password(password)
            .db(db)
            .build()?;
        let graph = Graph::connect(config).await?;
        info!("Connected to Neo4j");
        Ok(Self { graph })
    }

    pub async fn upsert_entities(&self, entities: &[EntityFeatures]) -> Result<u64> {
        let mut total = 0u64;

        for chunk in entities.chunks(NEO4J_BATCH_SIZE) {
            let mut node_list = BoltList::new();

            for entity in chunk {
                let mut props = BoltMap::new();
                props.put(key("entity_type"), entity.entity_type.to_string().into());
                props.put(key("risk_level"), entity.risk_level.to_string().into());
                props.put(key("tx_count_in"), (entity.tx_count_in as i64).into());
                props.put(key("tx_count_out"), (entity.tx_count_out as i64).into());
                props.put(key("volume_in"), entity.volume_in.as_str().into());
                props.put(key("volume_out"), entity.volume_out.as_str().into());
                props.put(
                    key("unique_counterparties_in"),
                    (entity.unique_counterparties_in as i64).into(),
                );
                props.put(
                    key("unique_counterparties_out"),
                    (entity.unique_counterparties_out as i64).into(),
                );
                if let Some(ts) = entity.first_seen {
                    props.put(key("first_seen"), (ts as i64).into());
                }
                if let Some(ts) = entity.last_seen {
                    props.put(key("last_seen"), (ts as i64).into());
                }
                if let Some(ref label) = entity.label {
                    props.put(key("label"), label.as_str().into());
                }

                let mut node = BoltMap::new();
                node.put(key("address"), entity.address.as_str().into());
                node.put(key("properties"), BoltType::Map(props));
                node_list.push(BoltType::Map(node));
            }

            let mut result = self
                .graph
                .execute(
                    query(
                        "UNWIND $nodes AS node \
                         MERGE (e:Entity {address: node.address}) \
                         SET e += node.properties \
                         RETURN count(e) AS count",
                    )
                    .param("nodes", BoltType::List(node_list)),
                )
                .await?;

            if let Some(row) = result.next().await? {
                let count: i64 = row.get("count")?;
                total += count as u64;
            }

            debug!(batch_size = chunk.len(), "Upserted entity batch");
        }

        info!(total, "Entity nodes upserted");
        Ok(total)
    }

    pub async fn upsert_transactions(&self, txs: &[Transaction]) -> Result<u64> {
        let mut total = 0u64;

        for chunk in txs.chunks(NEO4J_BATCH_SIZE) {
            let mut tx_list = BoltList::new();

            for tx in chunk {
                let mut props = BoltMap::new();
                props.put(key("value"), tx.value.as_str().into());
                props.put(key("block_number"), (tx.block_number as i64).into());
                props.put(key("timestamp"), (tx.timestamp as i64).into());
                props.put(key("gas_used"), (tx.gas_used as i64).into());
                props.put(key("gas_price"), tx.gas_price.as_str().into());

                let mut tx_map = BoltMap::new();
                tx_map.put(key("hash"), tx.hash.as_str().into());
                tx_map.put(key("from_address"), tx.from_address.as_str().into());
                tx_map.put(key("to_address"), tx.to_address.as_str().into());
                tx_map.put(key("properties"), BoltType::Map(props));
                tx_list.push(BoltType::Map(tx_map));
            }

            let mut result = self
                .graph
                .execute(
                    query(
                        "UNWIND $txs AS tx \
                         MERGE (from:Entity {address: tx.from_address}) \
                           ON CREATE SET from.risk_level = 'unknown' \
                         MERGE (to:Entity {address: tx.to_address}) \
                           ON CREATE SET to.risk_level = 'unknown' \
                         MERGE (t:Transaction {hash: tx.hash}) \
                         SET t += tx.properties, \
                             t.from_address = tx.from_address, \
                             t.to_address = tx.to_address \
                         MERGE (from)-[:SENT]->(t) \
                         MERGE (t)-[:RECEIVED]->(to) \
                         RETURN count(t) AS count",
                    )
                    .param("txs", BoltType::List(tx_list)),
                )
                .await?;

            if let Some(row) = result.next().await? {
                let count: i64 = row.get("count")?;
                total += count as u64;
            }

            debug!(batch_size = chunk.len(), "Upserted transaction batch");
        }

        info!(total, "Transaction nodes upserted");
        Ok(total)
    }

    pub async fn upsert_traces(&self, traces: &[Trace]) -> Result<u64> {
        let mut total = 0u64;

        for chunk in traces.chunks(NEO4J_BATCH_SIZE) {
            let mut trace_list = BoltList::new();

            for trace in chunk {
                let trace_addr_str = trace
                    .trace_address
                    .iter()
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
                    .join("_");
                let uid = format!("{}_{}", trace.transaction_hash, trace_addr_str);

                let mut m = BoltMap::new();
                m.put(key("uid"), uid.as_str().into());
                m.put(
                    key("transaction_hash"),
                    trace.transaction_hash.as_str().into(),
                );
                m.put(key("from_address"), trace.from_address.as_str().into());
                m.put(key("to_address"), trace.to_address.as_str().into());
                m.put(key("value"), trace.value.as_str().into());
                m.put(key("trace_type"), trace.trace_type.as_str().into());
                m.put(key("block_number"), (trace.block_number as i64).into());
                m.put(key("gas"), (trace.gas as i64).into());
                m.put(key("gas_used"), (trace.gas_used as i64).into());
                if let Some(ref ct) = trace.call_type {
                    m.put(key("call_type"), ct.as_str().into());
                }
                trace_list.push(BoltType::Map(m));
            }

            let mut result = self
                .graph
                .execute(
                    query(
                        "UNWIND $traces AS trace \
                         MERGE (from:Entity {address: trace.from_address}) \
                           ON CREATE SET from.risk_level = 'unknown' \
                         MERGE (to:Entity {address: trace.to_address}) \
                           ON CREATE SET to.risk_level = 'unknown' \
                         MERGE (t:Trace {uid: trace.uid}) \
                         SET t.transaction_hash = trace.transaction_hash, \
                             t.value = trace.value, \
                             t.trace_type = trace.trace_type, \
                             t.block_number = trace.block_number, \
                             t.gas = trace.gas, \
                             t.gas_used = trace.gas_used, \
                             t.from_address = trace.from_address, \
                             t.to_address = trace.to_address \
                         MERGE (from)-[:SENT_INTERNAL]->(t) \
                         MERGE (t)-[:RECEIVED_INTERNAL]->(to) \
                         WITH t, trace \
                         OPTIONAL MATCH (parent:Transaction {hash: trace.transaction_hash}) \
                         FOREACH (_ IN CASE WHEN parent IS NOT NULL THEN [1] ELSE [] END | \
                           MERGE (parent)-[:HAS_TRACE]->(t) \
                         ) \
                         RETURN count(t) AS count",
                    )
                    .param("traces", BoltType::List(trace_list)),
                )
                .await?;

            if let Some(row) = result.next().await? {
                let count: i64 = row.get("count")?;
                total += count as u64;
            }

            debug!(batch_size = chunk.len(), "Upserted trace batch");
        }

        info!(total, "Trace nodes upserted");
        Ok(total)
    }

    pub async fn upsert_transfers(&self, transfers: &[Transfer]) -> Result<u64> {
        let mut total = 0u64;

        for chunk in transfers.chunks(NEO4J_BATCH_SIZE) {
            let mut xfer_list = BoltList::new();

            for transfer in chunk {
                let uid = format!("{}_{}", transfer.transaction_hash, transfer.log_index);

                let mut m = BoltMap::new();
                m.put(key("uid"), uid.as_str().into());
                m.put(
                    key("transaction_hash"),
                    transfer.transaction_hash.as_str().into(),
                );
                m.put(key("from_address"), transfer.from_address.as_str().into());
                m.put(key("to_address"), transfer.to_address.as_str().into());
                m.put(key("token_address"), transfer.token_address.as_str().into());
                m.put(key("value"), transfer.value.as_str().into());
                m.put(
                    key("block_number"),
                    (transfer.block_number as i64).into(),
                );
                m.put(key("timestamp"), (transfer.timestamp as i64).into());
                m.put(key("log_index"), (transfer.log_index as i64).into());
                xfer_list.push(BoltType::Map(m));
            }

            let mut result = self
                .graph
                .execute(
                    query(
                        "UNWIND $transfers AS xfer \
                         MERGE (from:Entity {address: xfer.from_address}) \
                           ON CREATE SET from.risk_level = 'unknown' \
                         MERGE (to:Entity {address: xfer.to_address}) \
                           ON CREATE SET to.risk_level = 'unknown' \
                         MERGE (token:Entity {address: xfer.token_address}) \
                           ON CREATE SET token.risk_level = 'unknown', \
                                         token.entity_type = 'Contract' \
                         MERGE (t:TokenTransfer {uid: xfer.uid}) \
                         SET t.transaction_hash = xfer.transaction_hash, \
                             t.value = xfer.value, \
                             t.token_address = xfer.token_address, \
                             t.block_number = xfer.block_number, \
                             t.timestamp = xfer.timestamp, \
                             t.log_index = xfer.log_index, \
                             t.from_address = xfer.from_address, \
                             t.to_address = xfer.to_address \
                         MERGE (from)-[:SENT_TOKEN]->(t) \
                         MERGE (t)-[:RECEIVED_TOKEN]->(to) \
                         MERGE (t)-[:TOKEN_CONTRACT]->(token) \
                         WITH t, xfer \
                         OPTIONAL MATCH (parent:Transaction {hash: xfer.transaction_hash}) \
                         FOREACH (_ IN CASE WHEN parent IS NOT NULL THEN [1] ELSE [] END | \
                           MERGE (parent)-[:HAS_TOKEN_TRANSFER]->(t) \
                         ) \
                         RETURN count(t) AS count",
                    )
                    .param("transfers", BoltType::List(xfer_list)),
                )
                .await?;

            if let Some(row) = result.next().await? {
                let count: i64 = row.get("count")?;
                total += count as u64;
            }

            debug!(batch_size = chunk.len(), "Upserted transfer batch");
        }

        info!(total, "TokenTransfer nodes upserted");
        Ok(total)
    }
}
