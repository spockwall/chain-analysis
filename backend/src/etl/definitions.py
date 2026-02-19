"""
Dagster definitions for the Chain-Analysis ETL pipeline.

Run with: dagster dev -f src/etl/definitions.py
"""

from dagster import Definitions

from etl.assets import (
    computed_features,
    graph_edges,
    graph_nodes,
    raw_transactions,
    resolved_entities,
)
from etl.resources import RustWorkerResource

# Define all Dagster assets
all_assets = [
    raw_transactions,
    resolved_entities,
    computed_features,
    graph_nodes,
    graph_edges,
]

# Define resources with configuration
resources = {
    "rust_worker": RustWorkerResource(
        rust_binary_dir="../../etl-rs/target/release",
        ingest_binary="ingest",
        dry_run=False,
    )
}

# Create Dagster definitions
defs = Definitions(assets=all_assets, resources=resources)
