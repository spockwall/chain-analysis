"""Entity-related API endpoints."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from api.deps import GraphDBDep
from api.models.entity import (
    EdgeResponse,
    EdgeUpsertRequest,
    EntityResponse,
    EntityType,
    GroupMemberRequest,
    GroupMemberResponse,
    NeighborsResponse,
    NodeUpsertRequest,
    PathResponse,
    RiskLevel,
    TransactionResponse,
)

router = APIRouter(prefix="/entities", tags=["entities"])
write_router = APIRouter(prefix="/entities", tags=["entities"])
transactions_router = APIRouter(prefix="/transactions", tags=["transactions"])


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
        member_count=props.get("member_count", 0),
        properties={k: v for k, v in props.items() if k not in {
            "entity_type", "risk_level", "name", "first_seen_block",
            "last_seen_block", "tx_count", "member_count"
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
        member_count=node.properties.get("member_count", 0),
        properties={k: v for k, v in node.properties.items() if k not in {
            "entity_type", "risk_level", "name", "first_seen_block",
            "last_seen_block", "tx_count", "member_count"
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

    transactions = [
        TransactionResponse(
            hash=tx.hash,
            from_address=tx.from_address,
            to_address=tx.to_address,
            value=tx.properties.get("value"),
            block_number=tx.properties.get("block_number"),
            timestamp=tx.properties.get("timestamp"),
            gas_used=tx.properties.get("gas_used"),
            gas_price=tx.properties.get("gas_price"),
            properties={
                k: v for k, v in tx.properties.items()
                if k not in {"value", "block_number", "timestamp", "gas_used", "gas_price"}
            },
        )
        for tx in subgraph.transactions
    ]

    return NeighborsResponse(
        center_address=address,
        nodes=nodes,
        transactions=transactions,
        total_nodes=len(nodes),
        total_transactions=len(transactions),
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
            "transactions": [
                {
                    "hash": tx.hash,
                    "from_address": tx.from_address,
                    "to_address": tx.to_address,
                    "value": tx.properties.get("value"),
                    "block_number": tx.properties.get("block_number"),
                }
                for tx in path.transactions
            ],
            "length": len(path.transactions),
            "total_value": path.total_value,
        })

    return PathResponse(
        source=source,
        target=target,
        paths=path_data,
        total_paths=len(paths),
    )


# ── Write endpoints ────────────────────────────────────────────────────────────

def _validate_address(address: str, field: str = "address") -> str:
    """Validate and normalise an Ethereum address."""
    if not address.startswith("0x") or len(address) != 42:
        raise HTTPException(status_code=400, detail=f"Invalid {field} format")
    return address.lower()


@write_router.put("/{address}", response_model=EntityResponse)
async def upsert_entity(
    address: str,
    body: NodeUpsertRequest,
    graph_db: GraphDBDep,
) -> EntityResponse:
    """
    Create or update an entity node in Neo4j.

    Uses MERGE semantics — safe to call repeatedly with the same address.
    """
    address = _validate_address(address)
    if address != body.address.lower():
        raise HTTPException(status_code=400, detail="URL address and body address must match")

    # Block reclassification of group parent nodes
    existing = await graph_db.get_node(address)
    if existing and existing.properties.get("member_count", 0) > 0:
        member_count = existing.properties["member_count"]
        raise HTTPException(
            status_code=409,
            detail=f"Address {address} is a group parent with {member_count} member(s) and cannot be reclassified. "
                   "Manage its members via the /members API.",
        )

    labels = ["Entity"]
    if body.entity_type:
        labels.append(body.entity_type.value)
    labels.extend(body.labels)

    properties: dict = {
        "risk_level": body.risk_level.value,
        **body.properties,
    }
    if body.entity_type:
        properties["entity_type"] = body.entity_type.value
    if body.name:
        properties["name"] = body.name

    from core.ports.graph_db import Node
    node = Node(address=address, labels=labels, properties=properties)
    await graph_db.upsert_nodes([node])

    return EntityResponse(
        address=address,
        entity_type=body.entity_type,
        risk_level=body.risk_level,
        name=body.name,
        labels=labels,
        properties=properties,
    )


@write_router.patch("/{address}", response_model=EntityResponse)
async def update_entity(
    address: str,
    body: NodeUpsertRequest,
    graph_db: GraphDBDep,
) -> EntityResponse:
    """
    Update an existing entity node.

    Returns 404 if the entity does not exist.
    """
    address = _validate_address(address)

    existing = await graph_db.get_node(address)
    if existing is None:
        raise HTTPException(status_code=404, detail="Entity not found")

    # Block reclassification of group parent nodes
    if existing.properties.get("member_count", 0) > 0:
        member_count = existing.properties["member_count"]
        raise HTTPException(
            status_code=409,
            detail=f"Address {address} is a group parent with {member_count} member(s) and cannot be reclassified. "
                   "Manage its members via the /members API.",
        )

    # Merge incoming changes on top of the existing properties
    merged_props = {**existing.properties}
    if body.entity_type:
        merged_props["entity_type"] = body.entity_type.value
    if body.risk_level != RiskLevel.UNKNOWN or "risk_level" not in merged_props:
        merged_props["risk_level"] = body.risk_level.value
    if body.name is not None:
        merged_props["name"] = body.name
    merged_props.update(body.properties)

    labels = list({*existing.labels, *(body.labels)})
    if body.entity_type and body.entity_type.value not in labels:
        labels.append(body.entity_type.value)

    from core.ports.graph_db import Node
    node = Node(address=address, labels=labels, properties=merged_props)
    await graph_db.upsert_nodes([node])

    return EntityResponse(
        address=address,
        entity_type=EntityType(merged_props.get("entity_type")) if merged_props.get("entity_type") else None,
        risk_level=RiskLevel(merged_props.get("risk_level", "unknown")),
        name=merged_props.get("name"),
        labels=labels,
        properties=merged_props,
    )


@write_router.delete("/{address}", status_code=204)
async def delete_entity(
    address: str,
    graph_db: GraphDBDep,
) -> None:
    """
    Delete an entity node and all its relationships from Neo4j.
    """
    address = _validate_address(address)

    existing = await graph_db.get_node(address)
    if existing is None:
        raise HTTPException(status_code=404, detail="Entity not found")

    if existing.properties.get("member_count", 0) > 0:
        member_count = existing.properties["member_count"]
        raise HTTPException(
            status_code=409,
            detail=f"Address {address} is a group parent with {member_count} member(s). "
                   "Remove all members before deleting the group.",
        )

    await graph_db.execute_query(
        "MATCH (n:Entity {address: $address}) DETACH DELETE n",
        {"address": address},
    )


# ── Edge write endpoints ───────────────────────────────────────────────────────

@write_router.put("/{source}/edges/{target}", response_model=EdgeResponse)
async def upsert_edge(
    source: str,
    target: str,
    body: EdgeUpsertRequest,
    graph_db: GraphDBDep,
) -> EdgeResponse:
    """
    Create or update a directed edge between two entities.

    Uses MERGE semantics — safe to call repeatedly with the same source/target/type.
    Both nodes are created if they don't exist.
    """
    source = _validate_address(source, "source")
    target = _validate_address(target, "target")
    if source == target:
        raise HTTPException(status_code=400, detail="Source and target must differ")

    properties: dict = {**body.properties}
    if body.value is not None:
        properties["value"] = body.value
    if body.tx_hash is not None:
        properties["tx_hash"] = body.tx_hash
    if body.block_number is not None:
        properties["block_number"] = body.block_number

    from core.ports.graph_db import Edge
    edge = Edge(source=source, target=target, edge_type=body.edge_type, properties=properties)
    await graph_db.upsert_edges([edge])

    return EdgeResponse(
        source=source,
        target=target,
        edge_type=body.edge_type,
        value=body.value,
        tx_hash=body.tx_hash,
        block_number=body.block_number,
        properties=properties,
    )


@write_router.delete("/{source}/edges/{target}", status_code=204)
async def delete_edge(
    source: str,
    target: str,
    graph_db: GraphDBDep,
    edge_type: str = Query("TRANSFER", description="Edge type to delete"),
) -> None:
    """
    Delete a directed edge between two entities.
    """
    source = _validate_address(source, "source")
    target = _validate_address(target, "target")

    await graph_db.execute_query(
        """
        MATCH (a:Entity {address: $source})-[r]->(b:Entity {address: $target})
        WHERE type(r) = $edge_type
        DELETE r
        """,
        {"source": source, "target": target, "edge_type": edge_type},
    )


# ── Group member endpoints ─────────────────────────────────────────────────────

def _node_obj_to_response(node) -> EntityResponse:
    """Convert a core Node dataclass to EntityResponse."""
    return EntityResponse(
        address=node.address,
        entity_type=node.properties.get("entity_type"),
        risk_level=RiskLevel(node.properties.get("risk_level", "unknown")),
        name=node.properties.get("name"),
        labels=node.labels,
        first_seen_block=node.properties.get("first_seen_block"),
        last_seen_block=node.properties.get("last_seen_block"),
        transaction_count=node.properties.get("tx_count"),
        member_count=node.properties.get("member_count", 0),
        properties={k: v for k, v in node.properties.items() if k not in {
            "entity_type", "risk_level", "name", "first_seen_block",
            "last_seen_block", "tx_count", "member_count"
        }},
    )


@write_router.get("/{address}/members", response_model=GroupMemberResponse)
async def get_group_members(
    address: str,
    graph_db: GraphDBDep,
) -> GroupMemberResponse:
    """Get all contract members of a group entity."""
    address = _validate_address(address)
    members = await graph_db.get_group_members(address)
    member_responses = [_node_obj_to_response(m) for m in members]
    return GroupMemberResponse(
        parent_address=address,
        members=member_responses,
        total=len(member_responses),
    )


@write_router.post("/{address}/members", status_code=201, response_model=GroupMemberResponse)
async def add_group_member(
    address: str,
    body: GroupMemberRequest,
    graph_db: GraphDBDep,
) -> GroupMemberResponse:
    """Add a contract address as a member of a group entity."""
    address = _validate_address(address)
    child_address = _validate_address(body.child_address, "child_address")

    if address == child_address:
        raise HTTPException(status_code=400, detail="Parent and child addresses must differ")

    parent_node = await graph_db.get_node(address)
    if parent_node is None:
        raise HTTPException(status_code=404, detail="Parent entity not found")

    # Check if the child already belongs to a different group
    existing_parent = await graph_db.get_group_parent(child_address)
    if existing_parent and existing_parent.address != address:
        raise HTTPException(
            status_code=409,
            detail=f"Address {child_address} is already a member of group {existing_parent.address} "
                   f"({existing_parent.properties.get('name', existing_parent.address)})",
        )

    await graph_db.add_group_member(address, child_address)

    members = await graph_db.get_group_members(address)
    member_responses = [_node_obj_to_response(m) for m in members]
    return GroupMemberResponse(
        parent_address=address,
        members=member_responses,
        total=len(member_responses),
    )


@write_router.delete("/{address}/members/{child_address}", status_code=204)
async def remove_group_member(
    address: str,
    child_address: str,
    graph_db: GraphDBDep,
) -> None:
    """Remove a contract member from a group entity."""
    address = _validate_address(address)
    child_address = _validate_address(child_address, "child_address")
    await graph_db.remove_group_member(address, child_address)


# ── Transaction endpoints ──────────────────────────────────────────────────────

@transactions_router.get("/{hash}", response_model=TransactionResponse)
async def get_transaction(
    hash: str,
    graph_db: GraphDBDep,
) -> TransactionResponse:
    """
    Get a transaction node by hash.

    Args:
        hash: Transaction hash (0x-prefixed)

    Returns:
        Transaction information including from/to addresses, value, and metadata
    """
    tx = await graph_db.get_transaction(hash)

    if tx is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Transaction not found")

    return TransactionResponse(
        hash=tx.hash,
        from_address=tx.from_address,
        to_address=tx.to_address,
        value=tx.properties.get("value"),
        block_number=tx.properties.get("block_number"),
        timestamp=tx.properties.get("timestamp"),
        gas_used=tx.properties.get("gas_used"),
        gas_price=tx.properties.get("gas_price"),
        properties={
            k: v for k, v in tx.properties.items()
            if k not in {"value", "block_number", "timestamp", "gas_used", "gas_price"}
        },
    )
