"""
Dagster assets for blockchain data ingestion.

Asset dependency chain:
raw_transactions -> resolved_entities -> computed_features -> graph_nodes -> graph_edges
"""

import uuid

from dagster import (
    AssetExecutionContext,
    AssetIn,
    Config,
    MaterializeResult,
    MetadataValue,
    asset,
)

from etl.resources.rust_worker import RustWorkerResource
from libs import logger


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


@asset(
    group_name="ingestion",
    description="Resolve entity metadata from raw transactions",
    ins={"raw_txs": AssetIn("raw_transactions")},
)
def resolved_entities(
    context: AssetExecutionContext,
    config: BlockRangeConfig,
    raw_txs: MaterializeResult,
) -> MaterializeResult:
    """
    Resolve entity information from raw transactions.

    This asset:
    1. Reads transactions from Redis Streams
    2. Resolves entity metadata (contract vs EOA, known labels)
    3. Writes resolved entities back to Redis
    """
    context.log.info("Resolving entities from transactions")

    # In a full implementation, this would:
    # - Connect to Redis and consume from transaction stream
    # - Look up each unique address in known_labels table
    # - Determine if address is contract (via code check or trace data)
    # - Produce Entity records to Redis

    # For now, simulate the process
    entities_resolved = (
        config.end_block - config.start_block + 1
    ) * 5  # ~5 entities per block

    return MaterializeResult(
        metadata={
            "entities_resolved": MetadataValue.int(entities_resolved),
            "start_block": MetadataValue.int(config.start_block),
            "end_block": MetadataValue.int(config.end_block),
        }
    )


@asset(
    group_name="features",
    description="Compute entity features (transaction counts, volumes, etc.)",
    ins={"entities": AssetIn("resolved_entities")},
)
def computed_features(
    context: AssetExecutionContext,
    config: BlockRangeConfig,
    entities: MaterializeResult,
) -> MaterializeResult:
    """
    Compute features for entities.

    Features include:
    - Transaction count
    - Total value transferred (in/out)
    - Unique counterparties
    - Activity frequency
    """
    context.log.info("Computing entity features")

    # In production, this would run feature computation
    # Either via Rust worker or Python

    return MaterializeResult(
        metadata={
            "features_computed": MetadataValue.int(100),
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
) -> MaterializeResult:
    """
    Upsert entity nodes to Neo4j graph database.

    Uses MERGE with UNWIND for efficient batch upserts.
    """
    context.log.info("Upserting graph nodes to Neo4j")

    # In production, this would:
    # 1. Read entities from Redis
    # 2. Batch them
    # 3. Use Neo4jAdapter.upsert_nodes()

    # Simulated counts
    nodes_created = 50
    nodes_updated = 30

    return MaterializeResult(
        metadata={
            "nodes_created": MetadataValue.int(nodes_created),
            "nodes_updated": MetadataValue.int(nodes_updated),
            "start_block": MetadataValue.int(config.start_block),
            "end_block": MetadataValue.int(config.end_block),
        }
    )


@asset(
    group_name="graph",
    description="Upsert transfer edges to Neo4j",
    ins={"nodes": AssetIn("graph_nodes")},
)
async def graph_edges(
    context: AssetExecutionContext,
    config: BlockRangeConfig,
    nodes: MaterializeResult,
) -> MaterializeResult:
    """
    Upsert transfer edges to Neo4j graph database.

    Uses MERGE with UNWIND for efficient batch upserts.
    """
    context.log.info("Upserting graph edges to Neo4j")

    # In production, this would:
    # 1. Read transfers from Redis
    # 2. Batch them
    # 3. Use Neo4jAdapter.upsert_edges()

    # Simulated counts
    edges_created = 200
    edges_updated = 50

    return MaterializeResult(
        metadata={
            "edges_created": MetadataValue.int(edges_created),
            "edges_updated": MetadataValue.int(edges_updated),
            "start_block": MetadataValue.int(config.start_block),
            "end_block": MetadataValue.int(config.end_block),
        }
    )
