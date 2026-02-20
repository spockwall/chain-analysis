"""Pydantic models for entity-related API endpoints."""

from datetime import datetime
from enum import Enum
from pydantic import BaseModel, Field
from typing import Any


class EntityType(str, Enum):
    """Entity type classification."""

    EOA = "EOA"
    CONTRACT = "Contract"
    MIXER = "Mixer"
    LENDING_POOL = "LendingPool"
    BRIDGE = "Bridge"
    DEX = "DEX"
    CEX_HOT_WALLET = "CEXHotWallet"
    APPLICATION = "Application"
    UNKNOWN = "Unknown"


class RiskLevel(str, Enum):
    """Risk level for entities."""

    UNKNOWN = "unknown"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class EntityResponse(BaseModel):
    """Response model for a single entity."""

    address: str = Field(..., description="Ethereum address (0x-prefixed)")
    entity_type: EntityType | None = Field(
        None, description="Entity type classification"
    )
    risk_level: RiskLevel = Field(
        RiskLevel.UNKNOWN, description="Risk level assessment"
    )
    name: str | None = Field(None, description="Human-readable name if known")
    labels: list[str] = Field(
        default_factory=list, description="Additional labels/tags"
    )
    first_seen_block: int | None = Field(None, description="First block with activity")
    last_seen_block: int | None = Field(None, description="Last block with activity")
    transaction_count: int | None = Field(None, description="Total transaction count")
    properties: dict[str, Any] = Field(
        default_factory=dict, description="Additional properties"
    )


class EdgeResponse(BaseModel):
    """Response model for an edge (transfer/call)."""

    source: str = Field(..., description="Source address")
    target: str = Field(..., description="Target address")
    edge_type: str = Field(..., description="Edge type (TRANSFER, CALLS, etc.)")
    value: str | None = Field(None, description="Value in wei (as string)")
    block_number: int | None = Field(None, description="Block number")
    timestamp: datetime | None = Field(None, description="Transaction timestamp")
    tx_hash: str | None = Field(None, description="Transaction hash")
    properties: dict[str, Any] = Field(
        default_factory=dict, description="Additional properties"
    )


class NeighborsResponse(BaseModel):
    """Response model for neighborhood exploration."""

    center_address: str = Field(..., description="Center node address")
    nodes: list[EntityResponse] = Field(..., description="Nodes in the neighborhood")
    edges: list[EdgeResponse] = Field(..., description="Edges in the neighborhood")
    total_nodes: int = Field(..., description="Total number of nodes returned")
    total_edges: int = Field(..., description="Total number of edges returned")


class PathNode(BaseModel):
    """Node in a path."""

    address: str
    entity_type: EntityType | None = None
    name: str | None = None


class PathEdge(BaseModel):
    """Edge in a path."""

    source: str
    target: str
    edge_type: str
    value: str | None = None


class PathResponse(BaseModel):
    """Response model for path finding."""

    source: str = Field(..., description="Source address")
    target: str = Field(..., description="Target address")
    paths: list[dict[str, Any]] = Field(..., description="List of paths found")
    total_paths: int = Field(..., description="Total number of paths found")


class NodeUpsertRequest(BaseModel):
    """Request model for creating or updating a node."""

    address: str = Field(..., description="Ethereum address (0x-prefixed, 42 chars)")
    entity_type: EntityType | None = Field(None, description="Entity type classification")
    risk_level: RiskLevel = Field(RiskLevel.UNKNOWN, description="Risk level")
    name: str | None = Field(None, description="Human-readable name")
    labels: list[str] = Field(default_factory=list, description="Additional labels/tags")
    properties: dict[str, Any] = Field(default_factory=dict, description="Extra properties")


class EdgeUpsertRequest(BaseModel):
    """Request model for creating or updating an edge."""

    source: str = Field(..., description="Source address (0x-prefixed, 42 chars)")
    target: str = Field(..., description="Target address (0x-prefixed, 42 chars)")
    edge_type: str = Field("TRANSFER", description="Edge type (TRANSFER, CALLS, DEPLOYED)")
    value: str | None = Field(None, description="Value in wei (as string)")
    tx_hash: str | None = Field(None, description="Transaction hash")
    block_number: int | None = Field(None, description="Block number")
    properties: dict[str, Any] = Field(default_factory=dict, description="Extra properties")


class LabelTaskCreate(BaseModel):
    """Request model for creating a labeling task."""

    entity_address: str = Field(..., description="Entity address to label")
    title: str | None = Field(None, description="Task title")
    description: str | None = Field(None, description="Task description")
    priority: int = Field(0, description="Task priority (higher = more urgent)")
    context: dict[str, Any] | None = Field(None, description="Additional context")


class LabelTaskResponse(BaseModel):
    """Response model for a labeling task."""

    id: int
    entity_address: str
    status: str
    priority: int
    title: str | None
    description: str | None
    assignee_id: int | None
    created_at: datetime
    updated_at: datetime


class AnnotationCreate(BaseModel):
    """Request model for creating an annotation."""

    task_id: int = Field(..., description="ID of the labeling task")
    entity_address: str = Field(..., description="Entity address being annotated")
    entity_type: EntityType | None = Field(None, description="Entity type")
    risk_level: RiskLevel = Field(RiskLevel.UNKNOWN, description="Risk level")
    labels: list[str] | None = Field(None, description="Additional labels")
    notes: str | None = Field(None, description="Analyst notes")
    evidence: dict[str, Any] | None = Field(None, description="Supporting evidence")
    confidence: float | None = Field(
        None, ge=0.0, le=1.0, description="Confidence score"
    )


class AnnotationResponse(BaseModel):
    """Response model for an annotation."""

    id: int
    task_id: int
    labeler_id: int
    entity_address: str
    entity_type: EntityType | None
    risk_level: RiskLevel
    labels: list[str] | None
    notes: str | None
    confidence: float | None
    created_at: datetime
