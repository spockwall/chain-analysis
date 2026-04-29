"""Group entity CRUD endpoints."""

import uuid

from fastapi import APIRouter, HTTPException

from api.deps import GraphDBDep
from api.models.entity import (
    EntityResponse,
    EntityType,
    GroupCreateRequest,
    GroupDetailResponse,
    GroupListResponse,
    GroupUpdateRequest,
    RiskLevel,
)
from core.ports.graph_db import Node

router = APIRouter(prefix="/groups", tags=["groups"])


def _validate_address(address: str) -> str:
    if not address.startswith("0x") or len(address) != 42:
        raise HTTPException(status_code=400, detail="Invalid address format")
    return address.lower()


def _node_to_entity_response(node: Node) -> EntityResponse:
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
            "last_seen_block", "tx_count", "member_count",
        }},
    )


def _build_group_detail(node: Node, members: list[Node]) -> GroupDetailResponse:
    props = node.properties
    return GroupDetailResponse(
        address=node.address,
        name=props.get("name"),
        entity_type=EntityType(props["entity_type"]) if props.get("entity_type") else None,
        risk_level=RiskLevel(props.get("risk_level", "unknown")),
        description=props.get("description"),
        member_count=props.get("member_count", len(members)),
        members=[_node_to_entity_response(m) for m in members],
        properties={k: v for k, v in props.items() if k not in {
            "entity_type", "risk_level", "name", "description",
            "first_seen_block", "last_seen_block", "tx_count", "member_count",
        }},
    )


@router.get("", response_model=GroupListResponse)
async def list_groups(graph_db: GraphDBDep) -> GroupListResponse:
    """List all group entities (nodes with is_group=true, plus any with IN_GROUP members)."""
    query = """
    MATCH (grp:Entity)
    WHERE grp.is_group = true
    OPTIONAL MATCH (member:Entity)-[:IN_GROUP]->(grp)
    WITH grp, labels(grp) AS labels, count(member) AS member_count
    RETURN grp, labels, member_count
    ORDER BY member_count DESC
    """
    records = await graph_db.execute_query(query)

    groups: list[GroupDetailResponse] = []
    for record in records:
        node_data = dict(record["grp"])
        node_address = node_data.pop("address")
        node_data["member_count"] = record["member_count"]
        node = Node(
            address=node_address,
            labels=[lbl for lbl in record["labels"] if lbl != "Entity"],
            properties=node_data,
        )
        members = await graph_db.get_group_members(node_address)
        groups.append(_build_group_detail(node, members))

    return GroupListResponse(groups=groups, total=len(groups))


@router.post("", response_model=GroupDetailResponse, status_code=201)
async def create_group(body: GroupCreateRequest, graph_db: GraphDBDep) -> GroupDetailResponse:
    """Create a new group entity node. Address is auto-generated."""
    # Generate a deterministic-looking fake address from a UUID so it fits the 0x+40 hex format
    raw = uuid.uuid4().hex  # 32 hex chars
    address = ("0x" + raw + "0" * 8)[:42]  # pad to 42 chars

    labels = ["Entity", body.entity_type.value]
    properties: dict = {
        "risk_level": body.risk_level.value,
        "name": body.name,
        "entity_type": body.entity_type.value,
        "is_group": True,
        **body.properties,
    }
    if body.description is not None:
        properties["description"] = body.description

    node = Node(address=address, labels=labels, properties=properties)
    await graph_db.upsert_nodes([node])

    created = await graph_db.get_node(address)
    assert created is not None
    return _build_group_detail(created, [])


@router.get("/{address}", response_model=GroupDetailResponse)
async def get_group(address: str, graph_db: GraphDBDep) -> GroupDetailResponse:
    """Get a group entity and its members."""
    address = _validate_address(address)

    node = await graph_db.get_node(address)
    if node is None:
        raise HTTPException(status_code=404, detail="Group not found")

    members = await graph_db.get_group_members(address)
    return _build_group_detail(node, members)


@router.patch("/{address}", response_model=GroupDetailResponse)
async def update_group(
    address: str, body: GroupUpdateRequest, graph_db: GraphDBDep
) -> GroupDetailResponse:
    """Update name, risk_level, or description of a group entity."""
    address = _validate_address(address)

    node = await graph_db.get_node(address)
    if node is None:
        raise HTTPException(status_code=404, detail="Group not found")

    merged = {**node.properties}
    if body.name is not None:
        merged["name"] = body.name
    if body.risk_level is not None:
        merged["risk_level"] = body.risk_level.value
    if body.description is not None:
        merged["description"] = body.description
    merged.update(body.properties)

    updated_node = Node(address=address, labels=node.labels, properties=merged)
    await graph_db.upsert_nodes([updated_node])

    refreshed = await graph_db.get_node(address)
    assert refreshed is not None
    members = await graph_db.get_group_members(address)
    return _build_group_detail(refreshed, members)


@router.delete("/{address}", status_code=204, response_model=None)
async def delete_group(address: str, graph_db: GraphDBDep) -> None:
    """Delete a group entity. Fails with 409 if the group still has members."""
    address = _validate_address(address)

    node = await graph_db.get_node(address)
    if node is None:
        raise HTTPException(status_code=404, detail="Group not found")

    member_count = node.properties.get("member_count", 0)
    if member_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Group {address} has {member_count} member(s). Remove all members before deleting.",
        )

    await graph_db.execute_query(
        "MATCH (n:Entity {address: $address}) DETACH DELETE n",
        {"address": address},
    )
