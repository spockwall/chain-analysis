"""
Dagster assets for blockchain data ingestion.

Asset dependency chain:
raw_transactions -> resolved_entities -> computed_features -> graph_nodes -> graph_transactions
"""

import json
import uuid
from collections import defaultdict
from typing import Any

from dagster import (
    AssetExecutionContext,
    AssetIn,
    Config,
    MaterializeResult,
    MetadataValue,
    asset,
)

from core.ports.graph_db import Edge, Node, Transaction
from etl.resources.adapters import Neo4jResource, PostgresResource, RedisResource
from etl.resources.rust_worker import RustWorkerResource
from libs import logger

# Redis stream topic names
TOPIC_INGESTED_TXS = "ingested_txs"
TOPIC_RESOLVED_ENTITIES = "resolved_entities"
TOPIC_ENRICHED_ENTITIES = "enriched_entities"

# Batch sizes
REDIS_READ_BATCH_SIZE = 1000
NEO4J_BATCH_SIZE = 1000


class BlockRangeConfig(Config):
    """Configuration for block range ingestion."""

    start_block: int
    end_block: int
    chain_id: int = 1


@asset(
    group_name="ingestion",
    description="Ingest raw transactions from blockchain data source",
)
def raw_transactions(
    context: AssetExecutionContext,
    config: BlockRangeConfig,
    rust_worker: RustWorkerResource,
) -> MaterializeResult:
    """
    Ingest raw transactions using the Rust worker.

    This asset triggers the chain-analysis-ingest Rust binary which:
    1. Fetches transactions from Allium API
    2. Writes them to Redis Streams
    """
    run_id = str(uuid.uuid4())

    context.log.info(
        f"Starting ingestion for blocks {config.start_block} to {config.end_block}"
    )

    result = rust_worker.run_ingestion(
        start_block=config.start_block,
        end_block=config.end_block,
        run_id=run_id,
    )

    if not result["success"]:
        raise RuntimeError(f"Ingestion failed: {result.get('error', 'Unknown error')}")

    return MaterializeResult(
        metadata={
            "run_id": MetadataValue.text(run_id),
            "start_block": MetadataValue.int(config.start_block),
            "end_block": MetadataValue.int(config.end_block),
            "chain_id": MetadataValue.int(config.chain_id),
        }
    )


async def _read_stream_messages(
    redis_adapter,
    topic: str,
    count: int = REDIS_READ_BATCH_SIZE,
    block_ms: int = 5000,
) -> list[dict[str, Any]]:
    """
    Read messages from a Redis stream.

    Returns a list of parsed message data dictionaries.
    """
    messages = []
    # Read from the beginning of the stream
    result = await redis_adapter.redis.xread({topic: "0"}, count=count, block=block_ms)

    if not result:
        return messages

    for _stream_name, stream_messages in result:
        for _msg_id, fields in stream_messages:
            data = fields.get(b"data", b"{}")
            if isinstance(data, bytes):
                data = data.decode("utf-8")
            try:
                parsed = json.loads(data)
                messages.append(parsed)
            except json.JSONDecodeError:
                logger.warning("failed_to_parse_message", data=data[:100])

    return messages


async def _publish_to_stream(
    redis_adapter,
    topic: str,
    data: dict[str, Any],
    metadata: dict[str, Any] | None = None,
) -> str:
    """Publish a message to a Redis stream."""
    message_bytes = json.dumps(data).encode("utf-8")
    return await redis_adapter.publish(topic, message_bytes, metadata)


@asset(
    group_name="ingestion",
    description="Resolve entity metadata from raw transactions",
    ins={"raw_txs": AssetIn("raw_transactions")},
)
async def resolved_entities(
    context: AssetExecutionContext,
    config: BlockRangeConfig,
    raw_txs: MaterializeResult,
    redis: RedisResource,
    postgres: PostgresResource,
) -> MaterializeResult:
    """
    Resolve entity information from raw transactions.

    This asset:
    1. Reads transactions from Redis Streams (topic: ingested_txs)
    2. Extracts unique addresses (from, to, contract_address)
    3. Queries known_labels table for matches
    4. Classifies entity type (EOA vs Contract)
    5. Writes resolved entities to Redis (topic: resolved_entities)
    """
    context.log.info("Resolving entities from transactions")

    redis_adapter = redis.create_adapter()
    postgres_adapter = postgres.create_adapter()

    try:
        await redis_adapter.connect()
        await postgres_adapter.connect()

        # Read transactions from Redis
        transactions = await _read_stream_messages(redis_adapter, TOPIC_INGESTED_TXS)
        context.log.info(f"Read {len(transactions)} transactions from Redis")

        # Extract unique addresses
        addresses: set[str] = set()
        address_info: dict[str, dict[str, Any]] = {}

        for tx in transactions:
            from_addr = tx.get("from_address", "").lower()
            to_addr = tx.get("to_address", "").lower()
            contract_addr = tx.get("contract_address", "").lower()

            if from_addr:
                addresses.add(from_addr)
                if from_addr not in address_info:
                    address_info[from_addr] = {"is_contract": False}

            if to_addr:
                addresses.add(to_addr)
                # If to_address has no input data, it's likely an EOA
                # Contract interactions have input data
                input_data = tx.get("input", "0x")
                if to_addr not in address_info:
                    address_info[to_addr] = {
                        "is_contract": len(input_data) > 2 if input_data else False
                    }

            if contract_addr:
                addresses.add(contract_addr)
                address_info[contract_addr] = {"is_contract": True}

        context.log.info(f"Extracted {len(addresses)} unique addresses")

        # Query known_labels table for existing labels
        known_labels: dict[str, dict[str, Any]] = {}
        if addresses:
            address_list = list(addresses)
            # Query in batches
            for i in range(0, len(address_list), 500):
                batch = address_list[i : i + 500]
                placeholders = ", ".join([f":addr_{j}" for j in range(len(batch))])
                params = {f"addr_{j}": addr for j, addr in enumerate(batch)}

                query = f"""
                    SELECT address, label, entity_type, risk_level, source
                    FROM known_labels
                    WHERE LOWER(address) IN ({placeholders})
                """

                try:
                    results = await postgres_adapter.execute(query, params)
                    for row in results:
                        known_labels[row["address"].lower()] = {
                            "label": row.get("label"),
                            "entity_type": row.get("entity_type"),
                            "risk_level": row.get("risk_level"),
                            "source": row.get("source"),
                        }
                except Exception as e:
                    context.log.warning(f"Failed to query known_labels: {e}")

        context.log.info(f"Found {len(known_labels)} addresses in known_labels table")

        # Build resolved entities
        resolved = []
        for addr in addresses:
            info = address_info.get(addr, {})
            known = known_labels.get(addr, {})

            # Determine entity type
            if known.get("entity_type"):
                entity_type = known["entity_type"]
            elif info.get("is_contract"):
                entity_type = "Contract"
            else:
                entity_type = "EOA"

            entity = {
                "address": addr,
                "entity_type": entity_type,
                "label": known.get("label"),
                "risk_level": known.get("risk_level", "unknown"),
                "source": known.get("source"),
                "is_known": bool(known),
            }
            resolved.append(entity)

            # Publish to Redis stream
            await _publish_to_stream(
                redis_adapter,
                TOPIC_RESOLVED_ENTITIES,
                entity,
                {"block_range": f"{config.start_block}-{config.end_block}"},
            )

        context.log.info(f"Resolved and published {len(resolved)} entities")

    finally:
        await redis_adapter.close()
        await postgres_adapter.close()

    return MaterializeResult(
        metadata={
            "entities_resolved": MetadataValue.int(len(resolved)),
            "known_entities": MetadataValue.int(len(known_labels)),
            "start_block": MetadataValue.int(config.start_block),
            "end_block": MetadataValue.int(config.end_block),
        }
    )


@asset(
    group_name="features",
    description="Compute entity features (transaction counts, volumes, etc.)",
    ins={"entities": AssetIn("resolved_entities")},
)
async def computed_features(
    context: AssetExecutionContext,
    config: BlockRangeConfig,
    entities: MaterializeResult,
    redis: RedisResource,
) -> MaterializeResult:
    """
    Compute features for entities.

    Features include:
    - tx_count_in, tx_count_out: Transaction counts
    - volume_in, volume_out: Total value transferred (in/out) as wei strings
    - unique_counterparties_in, unique_counterparties_out: Unique addresses
    - first_seen, last_seen: Timestamps
    """
    context.log.info("Computing entity features")

    redis_adapter = redis.create_adapter()

    try:
        await redis_adapter.connect()

        # Read resolved entities
        entities_data = await _read_stream_messages(
            redis_adapter, TOPIC_RESOLVED_ENTITIES
        )
        context.log.info(f"Read {len(entities_data)} resolved entities")

        # Read transactions for feature computation
        transactions = await _read_stream_messages(redis_adapter, TOPIC_INGESTED_TXS)
        context.log.info(f"Read {len(transactions)} transactions for feature computation")

        # Compute features per entity
        entity_features: dict[str, dict[str, Any]] = {}

        # Initialize entities
        for entity in entities_data:
            addr = entity["address"]
            entity_features[addr] = {
                **entity,
                "tx_count_in": 0,
                "tx_count_out": 0,
                "volume_in": 0,  # Will convert to string later
                "volume_out": 0,
                "counterparties_in": set(),
                "counterparties_out": set(),
                "first_seen": None,
                "last_seen": None,
            }

        # Aggregate transaction data
        for tx in transactions:
            from_addr = tx.get("from_address", "").lower()
            to_addr = tx.get("to_address", "").lower()
            value = int(tx.get("value", 0))
            timestamp = tx.get("timestamp") or tx.get("block_timestamp")

            # Update outgoing metrics for sender
            if from_addr in entity_features:
                entity_features[from_addr]["tx_count_out"] += 1
                entity_features[from_addr]["volume_out"] += value
                if to_addr:
                    entity_features[from_addr]["counterparties_out"].add(to_addr)
                if timestamp:
                    if (
                        entity_features[from_addr]["first_seen"] is None
                        or timestamp < entity_features[from_addr]["first_seen"]
                    ):
                        entity_features[from_addr]["first_seen"] = timestamp
                    if (
                        entity_features[from_addr]["last_seen"] is None
                        or timestamp > entity_features[from_addr]["last_seen"]
                    ):
                        entity_features[from_addr]["last_seen"] = timestamp

            # Update incoming metrics for receiver
            if to_addr in entity_features:
                entity_features[to_addr]["tx_count_in"] += 1
                entity_features[to_addr]["volume_in"] += value
                if from_addr:
                    entity_features[to_addr]["counterparties_in"].add(from_addr)
                if timestamp:
                    if (
                        entity_features[to_addr]["first_seen"] is None
                        or timestamp < entity_features[to_addr]["first_seen"]
                    ):
                        entity_features[to_addr]["first_seen"] = timestamp
                    if (
                        entity_features[to_addr]["last_seen"] is None
                        or timestamp > entity_features[to_addr]["last_seen"]
                    ):
                        entity_features[to_addr]["last_seen"] = timestamp

        # Finalize features and publish to Redis
        enriched_count = 0
        for addr, features in entity_features.items():
            # Convert sets to counts and volumes to strings (wei)
            enriched_entity = {
                "address": addr,
                "entity_type": features.get("entity_type", "Unknown"),
                "label": features.get("label"),
                "risk_level": features.get("risk_level", "unknown"),
                "tx_count_in": features["tx_count_in"],
                "tx_count_out": features["tx_count_out"],
                "volume_in": str(features["volume_in"]),  # Wei as string
                "volume_out": str(features["volume_out"]),  # Wei as string
                "unique_counterparties_in": len(features["counterparties_in"]),
                "unique_counterparties_out": len(features["counterparties_out"]),
                "first_seen": features["first_seen"],
                "last_seen": features["last_seen"],
            }

            await _publish_to_stream(
                redis_adapter,
                TOPIC_ENRICHED_ENTITIES,
                enriched_entity,
                {"block_range": f"{config.start_block}-{config.end_block}"},
            )
            enriched_count += 1

        context.log.info(f"Computed and published features for {enriched_count} entities")

    finally:
        await redis_adapter.close()

    return MaterializeResult(
        metadata={
            "features_computed": MetadataValue.int(enriched_count),
            "transactions_processed": MetadataValue.int(len(transactions)),
            "start_block": MetadataValue.int(config.start_block),
            "end_block": MetadataValue.int(config.end_block),
        }
    )


@asset(
    group_name="graph",
    description="Upsert entity nodes to Neo4j",
    ins={"features": AssetIn("computed_features")},
)
async def graph_nodes(
    context: AssetExecutionContext,
    config: BlockRangeConfig,
    features: MaterializeResult,
    redis: RedisResource,
    neo4j: Neo4jResource,
) -> MaterializeResult:
    """
    Upsert entity nodes to Neo4j graph database.

    Uses MERGE with UNWIND for efficient batch upserts.
    """
    context.log.info("Upserting graph nodes to Neo4j")

    redis_adapter = redis.create_adapter()
    neo4j_adapter = neo4j.create_adapter()

    try:
        await redis_adapter.connect()
        await neo4j_adapter.connect()

        # Read enriched entities from Redis
        entities = await _read_stream_messages(redis_adapter, TOPIC_ENRICHED_ENTITIES)
        context.log.info(f"Read {len(entities)} enriched entities from Redis")

        # Convert to Node objects
        nodes: list[Node] = []
        for entity in entities:
            # Build labels list
            labels = [entity.get("entity_type", "Unknown")]
            if entity.get("label"):
                # Known entity labels (e.g., "Mixer", "CEXHotWallet")
                labels.append(entity["label"])

            node = Node(
                address=entity["address"],
                labels=labels,
                properties={
                    "tx_count_in": entity.get("tx_count_in", 0),
                    "tx_count_out": entity.get("tx_count_out", 0),
                    "volume_in": entity.get("volume_in", "0"),
                    "volume_out": entity.get("volume_out", "0"),
                    "unique_counterparties_in": entity.get("unique_counterparties_in", 0),
                    "unique_counterparties_out": entity.get("unique_counterparties_out", 0),
                    "first_seen": entity.get("first_seen"),
                    "last_seen": entity.get("last_seen"),
                    "risk_level": entity.get("risk_level", "unknown"),
                },
            )
            nodes.append(node)

        # Batch upsert to Neo4j
        total_upserted = 0
        for i in range(0, len(nodes), NEO4J_BATCH_SIZE):
            batch = nodes[i : i + NEO4J_BATCH_SIZE]
            count = await neo4j_adapter.upsert_nodes(batch)
            total_upserted += count
            context.log.info(f"Upserted batch of {count} nodes")

        context.log.info(f"Total nodes upserted: {total_upserted}")

    finally:
        await redis_adapter.close()
        await neo4j_adapter.close()

    return MaterializeResult(
        metadata={
            "nodes_upserted": MetadataValue.int(total_upserted),
            "entities_processed": MetadataValue.int(len(entities)),
            "start_block": MetadataValue.int(config.start_block),
            "end_block": MetadataValue.int(config.end_block),
        }
    )


@asset(
    group_name="graph",
    description="Upsert transaction nodes to Neo4j with SENT/RECEIVED relationships",
    ins={"nodes": AssetIn("graph_nodes")},
)
async def graph_transactions(
    context: AssetExecutionContext,
    config: BlockRangeConfig,
    nodes: MaterializeResult,
    redis: RedisResource,
    neo4j: Neo4jResource,
) -> MaterializeResult:
    """
    Upsert Transaction nodes to Neo4j graph database.

    Creates (from:Entity)-[:SENT]->(tx:Transaction)-[:RECEIVED]->(to:Entity)
    using MERGE with UNWIND for efficient batch upserts.
    """
    context.log.info("Upserting transaction nodes to Neo4j")

    redis_adapter = redis.create_adapter()
    neo4j_adapter = neo4j.create_adapter()

    try:
        await redis_adapter.connect()
        await neo4j_adapter.connect()

        # Read transactions from Redis
        transfers = await _read_stream_messages(redis_adapter, TOPIC_INGESTED_TXS)
        context.log.info(f"Read {len(transfers)} transactions from Redis")

        # Convert to Transaction objects — skip rows missing required fields
        txs: list[Transaction] = [
            Transaction(
                hash=tx["hash"],
                from_address=tx.get("from_address", "").lower(),
                to_address=tx.get("to_address", "").lower(),
                properties={
                    "value": str(tx.get("value", 0)),  # Wei as string
                    "block_number": tx.get("block_number"),
                    "timestamp": tx.get("timestamp") or tx.get("block_timestamp"),
                    "gas_used": tx.get("gas_used"),
                    "gas_price": str(tx.get("gas_price", 0)),
                },
            )
            for tx in transfers
            if tx.get("hash") and tx.get("from_address") and tx.get("to_address")
        ]

        context.log.info(f"Created {len(txs)} transaction objects")

        # Batch upsert to Neo4j
        total_upserted = 0
        for i in range(0, len(txs), NEO4J_BATCH_SIZE):
            batch = txs[i : i + NEO4J_BATCH_SIZE]
            count = await neo4j_adapter.upsert_transactions(batch)
            total_upserted += count
            context.log.info(f"Upserted batch of {count} transaction nodes")

        context.log.info(f"Total transaction nodes upserted: {total_upserted}")

    finally:
        await redis_adapter.close()
        await neo4j_adapter.close()

    return MaterializeResult(
        metadata={
            "transactions_upserted": MetadataValue.int(total_upserted),
            "transfers_processed": MetadataValue.int(len(transfers)),
            "start_block": MetadataValue.int(config.start_block),
            "end_block": MetadataValue.int(config.end_block),
        }
    )
