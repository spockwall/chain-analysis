"""Entity-related API endpoints."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from api.deps import GraphDBDep
from api.models.entity import (
    EdgeResponse,
    EntityResponse,
    EntityType,
    NeighborsResponse,
    PathResponse,
    RiskLevel,
)

router = APIRouter(prefix="/entities", tags=["entities"])


def _node_to_response(node: dict) -> EntityResponse:
    """Convert a graph node to EntityResponse."""
    props = node.get("properties", {})
    return EntityResponse(
        address=node.get("address", ""),
        entity_type=props.get("entity_type"),
        risk_level=RiskLevel(props.get("risk_level", "unknown")),
        name=props.get("name"),
        labels=node.get("labels", []),
        first_seen_block=props.get("first_seen_block"),
        last_seen_block=props.get("last_seen_block"),
        transaction_count=props.get("tx_count"),
        properties={k: v for k, v in props.items() if k not in {
            "entity_type", "risk_level", "name", "first_seen_block",
            "last_seen_block", "tx_count"
        }},
    )


def _edge_to_response(edge: dict) -> EdgeResponse:
    """Convert a graph edge to EdgeResponse."""
    props = edge.get("properties", {})
    return EdgeResponse(
        source=edge.get("source", ""),
        target=edge.get("target", ""),
        edge_type=edge.get("edge_type", "TRANSFER"),
        value=props.get("value"),
        block_number=props.get("block_number"),
        timestamp=props.get("timestamp"),
        tx_hash=props.get("tx_hash"),
        properties={k: v for k, v in props.items() if k not in {
            "value", "block_number", "timestamp", "tx_hash"
        }},
    )


@router.get("/{address}", response_model=EntityResponse)
async def get_entity(
    address: str,
    graph_db: GraphDBDep,
) -> EntityResponse:
    """
    Get entity information by address.

    Args:
        address: Ethereum address (0x-prefixed, 42 characters)

    Returns:
        Entity information including type, risk level, and metadata
    """
    # Validate address format
    if not address.startswith("0x") or len(address) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")

    address = address.lower()

    node = await graph_db.get_node(address)

    if node is None:
        raise HTTPException(status_code=404, detail="Entity not found")

    return EntityResponse(
        address=node.address,
        entity_type=node.properties.get("entity_type"),
        risk_level=RiskLevel(node.properties.get("risk_level", "unknown")),
        name=node.properties.get("name"),
        labels=node.labels,
        first_seen_block=node.properties.get("first_seen_block"),
        last_seen_block=node.properties.get("last_seen_block"),
        transaction_count=node.properties.get("tx_count"),
        properties={k: v for k, v in node.properties.items() if k not in {
            "entity_type", "risk_level", "name", "first_seen_block",
            "last_seen_block", "tx_count"
        }},
    )


@router.get("/{address}/neighbors", response_model=NeighborsResponse)
async def get_neighbors(
    address: str,
    graph_db: GraphDBDep,
    depth: int = Query(1, ge=1, le=3, description="Number of hops"),
    direction: Literal["in", "out", "both"] = Query("both", description="Edge direction"),
    edge_types: list[str] | None = Query(None, description="Filter by edge types"),
    limit: int = Query(100, ge=1, le=500, description="Maximum nodes to return"),
) -> NeighborsResponse:
    """
    Get the neighborhood of an entity.

    Args:
        address: Center node address
        depth: Number of hops (1-3)
        direction: Edge direction filter
        edge_types: Optional edge type filter (TRANSFER, CALLS, etc.)
        limit: Maximum number of nodes to return

    Returns:
        Subgraph containing nodes and edges in the neighborhood
    """
    # Validate address format
    if not address.startswith("0x") or len(address) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")

    address = address.lower()

    subgraph = await graph_db.get_neighbors(
        address=address,
        depth=depth,
        direction=direction,
        edge_types=edge_types,
        limit=limit,
    )

    nodes = [
        EntityResponse(
            address=node.address,
            entity_type=node.properties.get("entity_type"),
            risk_level=RiskLevel(node.properties.get("risk_level", "unknown")),
            name=node.properties.get("name"),
            labels=node.labels,
            properties=node.properties,
        )
        for node in subgraph.nodes
    ]

    edges = [
        EdgeResponse(
            source=edge.source,
            target=edge.target,
            edge_type=edge.edge_type,
            value=edge.properties.get("value"),
            block_number=edge.properties.get("block_number"),
            properties=edge.properties,
        )
        for edge in subgraph.edges
    ]

    return NeighborsResponse(
        center_address=address,
        nodes=nodes,
        edges=edges,
        total_nodes=len(nodes),
        total_edges=len(edges),
    )


@router.get("/{source}/paths/{target}", response_model=PathResponse)
async def find_paths(
    source: str,
    target: str,
    graph_db: GraphDBDep,
    max_depth: int = Query(10, ge=1, le=20, description="Maximum path length"),
    edge_types: list[str] | None = Query(None, description="Filter by edge types"),
    limit: int = Query(10, ge=1, le=50, description="Maximum paths to return"),
) -> PathResponse:
    """
    Find paths between two entities.

    Args:
        source: Source entity address
        target: Target entity address
        max_depth: Maximum path length
        edge_types: Optional edge type filter
        limit: Maximum number of paths to return

    Returns:
        List of paths between source and target
    """
    # Validate address formats
    for addr, name in [(source, "source"), (target, "target")]:
        if not addr.startswith("0x") or len(addr) != 42:
            raise HTTPException(status_code=400, detail=f"Invalid {name} address format")

    source = source.lower()
    target = target.lower()

    paths = await graph_db.find_paths(
        source=source,
        target=target,
        max_depth=max_depth,
        edge_types=edge_types,
        limit=limit,
    )

    # Convert paths to response format
    path_data = []
    for path in paths:
        path_data.append({
            "nodes": [
                {
                    "address": node.address,
                    "entity_type": node.properties.get("entity_type"),
                    "name": node.properties.get("name"),
                }
                for node in path.nodes
            ],
            "edges": [
                {
                    "source": edge.source,
                    "target": edge.target,
                    "edge_type": edge.edge_type,
                    "value": edge.properties.get("value"),
                }
                for edge in path.edges
            ],
            "length": len(path.edges),
            "total_value": path.total_value,
        })

    return PathResponse(
        source=source,
        target=target,
        paths=path_data,
        total_paths=len(paths),
    )
