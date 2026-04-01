"""
MCP server exposing Chain-Analysis tools to agents.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from mcp.server.fastmcp import FastMCP

from api.deps import (
    adapters_are_initialized,
    close_adapters,
    get_graph_db,
    get_message_queue,
    get_relational_db,
    init_adapters,
)
from api.models.entity import (
    AnnotationCreate,
    EntityFeaturesUpsertRequest,
    EntityType,
    GroupCreateRequest,
    GroupMemberRequest,
    GroupUpdateRequest,
    LabelTaskCreate,
    NodeUpsertRequest,
    RiskLevel,
    TransactionUpsertRequest,
)
from api.routes import entities as entity_routes
from api.routes import features as feature_routes
from api.routes import groups as group_routes
from api.routes import health as health_routes
from api.routes import labels as label_routes
from api.routes import stats as stats_routes
from core.config import get_settings
from libs import logger
from services import EntityService, LabelService


def _jsonify(value: Any) -> Any:
    """Convert route and service output into JSON-serialisable data."""
    return jsonable_encoder(value)


def _http_error_message(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, str):
        return detail
    return str(detail)


async def _invoke(func: Any, /, *args: Any, **kwargs: Any) -> Any:
    """Run a route/service helper and normalise failures for MCP clients."""
    try:
        result = await func(*args, **kwargs)
    except HTTPException as exc:
        raise ValueError(_http_error_message(exc)) from exc
    except Exception as exc:
        logger.error("mcp_tool_failed", tool=getattr(func, "__name__", "unknown"), error=str(exc))
        raise RuntimeError(str(exc)) from exc
    return _jsonify(result)


def _entity_service() -> EntityService:
    return EntityService(
        graph_db=get_graph_db(),
        relational_db=get_relational_db(),
    )


def _label_service() -> LabelService:
    return LabelService(
        graph_db=get_graph_db(),
        relational_db=get_relational_db(),
    )


@asynccontextmanager
async def _mcp_lifespan(_server: FastMCP) -> AsyncIterator[None]:
    owns_adapters = False

    if not adapters_are_initialized():
        await init_adapters(get_settings())
        owns_adapters = True
        logger.info("mcp_adapters_initialized")

    try:
        yield
    finally:
        if owns_adapters:
            await close_adapters()
            logger.info("mcp_adapters_closed")


chain_analysis_mcp = FastMCP(
    "Chain Analysis",
    instructions=(
        "Use these tools to investigate Ethereum and EVM transaction graphs, "
        "inspect entity metadata, manage groups and annotations, and review system health."
    ),
    json_response=True,
    streamable_http_path="/",
    lifespan=_mcp_lifespan,
)


@chain_analysis_mcp.resource("chain-analysis://guide")
def get_server_guide() -> str:
    """Describe the most important Chain-Analysis tool semantics."""
    return (
        "Chain-Analysis MCP exposes entity, transaction, graph, group, feature, and labeling tools.\n"
        "- Addresses must be 0x-prefixed 42-character Ethereum addresses.\n"
        "- Transaction hashes must be 0x-prefixed 66-character hashes.\n"
        "- `get_entity_neighbors` currently reflects the backend neighbor implementation, "
        "which is most reliable for 1-hop traversal.\n"
        "- Write tools mutate Neo4j or PostgreSQL state; use read tools first when exploring.\n"
        "- Risk levels are: unknown, low, medium, high, critical.\n"
    )


@chain_analysis_mcp.resource("chain-analysis://taxonomy")
def get_taxonomy() -> str:
    """Return supported entity types and risk levels."""
    entity_types = ", ".join(entity_type.value for entity_type in EntityType)
    risk_levels = ", ".join(risk_level.value for risk_level in RiskLevel)
    return f"Entity types: {entity_types}\nRisk levels: {risk_levels}"


@chain_analysis_mcp.tool(
    name="get_health",
    description="Check the health of Neo4j, PostgreSQL, and Redis.",
    structured_output=True,
)
async def get_health() -> dict[str, Any]:
    return await _invoke(
        health_routes.health_check,
        get_graph_db(),
        get_relational_db(),
        get_message_queue(),
    )


@chain_analysis_mcp.tool(
    name="get_graph_stats",
    description="Return graph node, transaction, edge, entity-type, and risk-level counts.",
    structured_output=True,
)
async def get_graph_stats() -> dict[str, Any]:
    return await _invoke(stats_routes.get_graph_stats, get_graph_db())


@chain_analysis_mcp.tool(
    name="get_entity",
    description="Fetch an entity by Ethereum address.",
    structured_output=True,
)
async def get_entity(address: str) -> dict[str, Any]:
    return await _invoke(entity_routes.get_entity, address, get_graph_db())


@chain_analysis_mcp.tool(
    name="get_entity_neighbors",
    description="Fetch a local neighborhood around an entity address.",
    structured_output=True,
)
async def get_entity_neighbors(
    address: str,
    depth: int = 1,
    direction: str = "both",
    limit: int = 100,
) -> dict[str, Any]:
    return await _invoke(
        entity_routes.get_neighbors,
        address,
        get_graph_db(),
        depth=depth,
        direction=direction,
        limit=limit,
    )


@chain_analysis_mcp.tool(
    name="find_entity_paths",
    description="Find paths between two entity addresses through transaction nodes.",
    structured_output=True,
)
async def find_entity_paths(
    source: str,
    target: str,
    max_depth: int = 10,
    limit: int = 10,
) -> dict[str, Any]:
    return await _invoke(
        entity_routes.find_paths,
        source,
        target,
        get_graph_db(),
        max_depth=max_depth,
        limit=limit,
    )


@chain_analysis_mcp.tool(
    name="get_transaction",
    description="Fetch a transaction node by hash.",
    structured_output=True,
)
async def get_transaction(hash: str) -> dict[str, Any]:
    return await _invoke(entity_routes.get_transaction, hash, get_graph_db())


@chain_analysis_mcp.tool(
    name="get_entity_features",
    description="Fetch computed behavioral features for an entity from PostgreSQL.",
    structured_output=True,
)
async def get_entity_features(address: str) -> dict[str, Any]:
    return await _invoke(feature_routes.get_entity_features, address, get_relational_db())


@chain_analysis_mcp.tool(
    name="list_groups",
    description="List all investigation groups and their members.",
    structured_output=True,
)
async def list_groups() -> dict[str, Any]:
    return await _invoke(group_routes.list_groups, get_graph_db())


@chain_analysis_mcp.tool(
    name="get_group",
    description="Fetch one investigation group and its members by address.",
    structured_output=True,
)
async def get_group(address: str) -> dict[str, Any]:
    return await _invoke(group_routes.get_group, address, get_graph_db())


@chain_analysis_mcp.tool(
    name="get_group_members",
    description="List the members of a group entity.",
    structured_output=True,
)
async def get_group_members(address: str) -> dict[str, Any]:
    return await _invoke(entity_routes.get_group_members, address, get_graph_db())


@chain_analysis_mcp.tool(
    name="list_label_tasks",
    description="List labeling tasks with optional status filtering.",
    structured_output=True,
)
async def list_label_tasks(
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict[str, Any]]:
    return await _invoke(
        label_routes.list_label_tasks,
        get_relational_db(),
        status=status,
        limit=limit,
        offset=offset,
    )


@chain_analysis_mcp.tool(
    name="get_label_task",
    description="Fetch a single labeling task by ID.",
    structured_output=True,
)
async def get_label_task(task_id: int) -> dict[str, Any]:
    return await _invoke(label_routes.get_label_task, task_id, get_relational_db())


@chain_analysis_mcp.tool(
    name="get_entity_annotations",
    description="List annotations recorded for an entity address.",
    structured_output=True,
)
async def get_entity_annotations(
    entity_address: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    return await _invoke(
        label_routes.get_entity_annotations,
        entity_address,
        get_relational_db(),
        limit=limit,
    )


@chain_analysis_mcp.tool(
    name="get_entity_with_known_label",
    description="Fetch an entity enriched with known-label metadata from PostgreSQL.",
    structured_output=True,
)
async def get_entity_with_known_label(address: str) -> dict[str, Any] | None:
    return await _invoke(_entity_service().get_entity_with_known_label, address)


@chain_analysis_mcp.tool(
    name="get_risk_propagation",
    description="Estimate how risk propagates outward from an address.",
    structured_output=True,
)
async def get_risk_propagation(address: str, max_depth: int = 3) -> dict[str, Any]:
    return await _invoke(_entity_service().get_risk_propagation, address, max_depth=max_depth)


@chain_analysis_mcp.tool(
    name="detect_clustering",
    description="Estimate whether a set of addresses likely belong to the same cluster.",
    structured_output=True,
)
async def detect_clustering(addresses: list[str]) -> dict[str, Any]:
    return await _invoke(_entity_service().detect_clustering, addresses)


@chain_analysis_mcp.tool(
    name="upsert_entity",
    description="Create or replace an entity node in Neo4j.",
    structured_output=True,
)
async def upsert_entity(
    address: str,
    entity_type: EntityType | None = None,
    risk_level: RiskLevel = RiskLevel.UNKNOWN,
    name: str | None = None,
    labels: list[str] | None = None,
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = NodeUpsertRequest(
        address=address,
        entity_type=entity_type,
        risk_level=risk_level,
        name=name,
        labels=labels or [],
        properties=properties or {},
    )
    return await _invoke(entity_routes.upsert_entity, address, body, get_graph_db())


@chain_analysis_mcp.tool(
    name="update_entity",
    description="Patch an existing entity node in Neo4j.",
    structured_output=True,
)
async def update_entity(
    address: str,
    entity_type: EntityType | None = None,
    risk_level: RiskLevel = RiskLevel.UNKNOWN,
    name: str | None = None,
    labels: list[str] | None = None,
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = NodeUpsertRequest(
        address=address,
        entity_type=entity_type,
        risk_level=risk_level,
        name=name,
        labels=labels or [],
        properties=properties or {},
    )
    return await _invoke(entity_routes.update_entity, address, body, get_graph_db())


@chain_analysis_mcp.tool(
    name="delete_entity",
    description="Delete an entity node and its relationships from Neo4j.",
    structured_output=True,
)
async def delete_entity(address: str) -> dict[str, bool]:
    await _invoke(entity_routes.delete_entity, address, get_graph_db())
    return {"deleted": True}


@chain_analysis_mcp.tool(
    name="upsert_transaction",
    description="Create or replace a transaction node and its SENT/RECEIVED relationships.",
    structured_output=True,
)
async def upsert_transaction(
    hash: str,
    from_address: str,
    to_address: str,
    value: str | None = None,
    block_number: int | None = None,
    timestamp: datetime | None = None,
    gas_used: int | None = None,
    gas_price: str | None = None,
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = TransactionUpsertRequest(
        from_address=from_address,
        to_address=to_address,
        value=value,
        block_number=block_number,
        timestamp=timestamp,
        gas_used=gas_used,
        gas_price=gas_price,
        properties=properties or {},
    )
    return await _invoke(entity_routes.upsert_transaction, hash, body, get_graph_db())


@chain_analysis_mcp.tool(
    name="delete_transaction",
    description="Delete a transaction node from Neo4j.",
    structured_output=True,
)
async def delete_transaction(hash: str) -> dict[str, bool]:
    await _invoke(entity_routes.delete_transaction, hash, get_graph_db())
    return {"deleted": True}


@chain_analysis_mcp.tool(
    name="create_group",
    description="Create a new investigation group entity.",
    structured_output=True,
)
async def create_group(
    name: str,
    entity_type: EntityType = EntityType.CONTRACT,
    risk_level: RiskLevel = RiskLevel.UNKNOWN,
    description: str | None = None,
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = GroupCreateRequest(
        name=name,
        entity_type=entity_type,
        risk_level=risk_level,
        description=description,
        properties=properties or {},
    )
    return await _invoke(group_routes.create_group, body, get_graph_db())


@chain_analysis_mcp.tool(
    name="update_group",
    description="Update an investigation group's metadata.",
    structured_output=True,
)
async def update_group(
    address: str,
    name: str | None = None,
    risk_level: RiskLevel | None = None,
    description: str | None = None,
    properties: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = GroupUpdateRequest(
        name=name,
        risk_level=risk_level,
        description=description,
        properties=properties or {},
    )
    return await _invoke(group_routes.update_group, address, body, get_graph_db())


@chain_analysis_mcp.tool(
    name="delete_group",
    description="Delete an investigation group when it has no remaining members.",
    structured_output=True,
)
async def delete_group(address: str) -> dict[str, bool]:
    await _invoke(group_routes.delete_group, address, get_graph_db())
    return {"deleted": True}


@chain_analysis_mcp.tool(
    name="add_group_member",
    description="Add an address as a member of a group entity.",
    structured_output=True,
)
async def add_group_member(address: str, member_address: str) -> dict[str, Any]:
    body = GroupMemberRequest(member_address=member_address)
    return await _invoke(entity_routes.add_group_member, address, body, get_graph_db())


@chain_analysis_mcp.tool(
    name="remove_group_member",
    description="Remove a member address from a group entity.",
    structured_output=True,
)
async def remove_group_member(address: str, member_address: str) -> dict[str, bool]:
    await _invoke(entity_routes.remove_group_member, address, member_address, get_graph_db())
    return {"deleted": True}


@chain_analysis_mcp.tool(
    name="upsert_entity_features",
    description="Create or update computed entity features in PostgreSQL.",
    structured_output=True,
)
async def upsert_entity_features(address: str, body: dict[str, Any]) -> dict[str, Any]:
    request = EntityFeaturesUpsertRequest.model_validate(body)
    return await _invoke(feature_routes.upsert_entity_features, address, request, get_relational_db())


@chain_analysis_mcp.tool(
    name="create_label_task",
    description="Create a labeling task for an entity.",
    structured_output=True,
)
async def create_label_task(
    entity_address: str,
    title: str | None = None,
    description: str | None = None,
    priority: int = 0,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body = {
        "entity_address": entity_address,
        "title": title,
        "description": description,
        "priority": priority,
        "context": context,
    }
    request = LabelTaskCreate.model_validate(body)
    return await _invoke(label_routes.create_label_task, request, get_relational_db())


@chain_analysis_mcp.tool(
    name="create_contextual_label_task",
    description="Create a labeling task enriched with graph and prior annotation context.",
    structured_output=True,
)
async def create_contextual_label_task(
    entity_address: str,
    title: str | None = None,
    description: str | None = None,
    priority: int = 0,
    include_neighbors: bool = True,
) -> dict[str, Any]:
    return await _invoke(
        _label_service().create_task_with_context,
        entity_address,
        title=title,
        description=description,
        priority=priority,
        include_neighbors=include_neighbors,
    )


@chain_analysis_mcp.tool(
    name="create_annotation",
    description="Submit an annotation for a labeling task.",
    structured_output=True,
)
async def create_annotation(
    task_id: int,
    entity_address: str,
    risk_level: RiskLevel,
    entity_type: EntityType | None = None,
    labels: list[str] | None = None,
    notes: str | None = None,
    evidence: dict[str, Any] | None = None,
    confidence: float | None = None,
) -> dict[str, Any]:
    body = AnnotationCreate(
        task_id=task_id,
        entity_address=entity_address,
        entity_type=entity_type,
        risk_level=risk_level,
        labels=labels,
        notes=notes,
        evidence=evidence,
        confidence=confidence,
    )
    return await _invoke(label_routes.create_annotation, body, get_relational_db())


chain_analysis_mcp_http_app = chain_analysis_mcp.streamable_http_app()


def main() -> None:
    """Run the MCP server over stdio for local agent integration."""
    chain_analysis_mcp.run(transport="stdio")


def main_http() -> None:
    """Run the MCP server as a standalone Streamable HTTP service."""
    chain_analysis_mcp.run(transport="streamable-http")
