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
    member_count: int = Field(0, description="Number of contract members in this group")


class GroupCreateRequest(BaseModel):
    """Request model for creating a new group entity."""

    name: str = Field(..., description="Human-readable group name")
    entity_type: "EntityType" = Field(EntityType.CONTRACT, description="Entity type")
    risk_level: "RiskLevel" = Field(RiskLevel.UNKNOWN, description="Risk level")
    description: str | None = Field(None, description="Optional group description")
    properties: dict[str, Any] = Field(
        default_factory=dict, description="Extra properties"
    )


class GroupUpdateRequest(BaseModel):
    """Request model for updating a group entity."""

    name: str | None = Field(None, description="New group name")
    risk_level: "RiskLevel | None" = Field(None, description="New risk level")
    description: str | None = Field(None, description="New description")
    properties: dict[str, Any] = Field(
        default_factory=dict, description="Extra properties"
    )


class GroupDetailResponse(BaseModel):
    """Response model for a group entity with its members."""

    address: str
    name: str | None
    entity_type: "EntityType | None"
    risk_level: "RiskLevel"
    description: str | None
    member_count: int
    members: list["EntityResponse"]
    properties: dict[str, Any]


class GroupListResponse(BaseModel):
    """Response model for listing all group entities."""

    groups: list[GroupDetailResponse]
    total: int


class GroupMemberRequest(BaseModel):
    """Request model for adding a member to a group entity."""

    member_address: str = Field(..., description="Contract address to add as member")


class GroupMemberResponse(BaseModel):
    """Response model for group member operations."""

    group_address: str = Field(..., description="Group entity address")
    members: list["EntityResponse"] = Field(..., description="Member entities")
    total: int = Field(..., description="Total number of members")


class TransactionResponse(BaseModel):
    """Response model for a Transaction node."""

    hash: str = Field(..., description="Transaction hash")
    from_address: str = Field(..., description="Sender address")
    to_address: str = Field(..., description="Receiver address")
    value: str | None = Field(None, description="Value in wei (as string)")
    block_number: int | None = Field(None, description="Block number")
    timestamp: datetime | None = Field(None, description="Transaction timestamp")
    gas_used: int | None = Field(None, description="Gas used")
    gas_price: str | None = Field(None, description="Gas price in wei (as string)")
    properties: dict[str, Any] = Field(
        default_factory=dict, description="Additional properties"
    )


class NeighborsResponse(BaseModel):
    """Response model for neighborhood exploration."""

    center_address: str = Field(..., description="Center node address")
    nodes: list[EntityResponse] = Field(..., description="Nodes in the neighborhood")
    transactions: list[TransactionResponse] = Field(
        ..., description="Transaction nodes in the neighborhood"
    )
    total_nodes: int = Field(..., description="Total number of nodes returned")
    total_transactions: int = Field(
        ..., description="Total number of transactions returned"
    )


class PathNode(BaseModel):
    """Node in a path."""

    address: str
    entity_type: EntityType | None = None
    name: str | None = None


class PathResponse(BaseModel):
    """Response model for path finding."""

    source: str = Field(..., description="Source address")
    target: str = Field(..., description="Target address")
    paths: list[dict[str, Any]] = Field(..., description="List of paths found")
    total_paths: int = Field(..., description="Total number of paths found")


class NodeUpsertRequest(BaseModel):
    """Request model for creating or updating a node."""

    address: str = Field(..., description="Ethereum address (0x-prefixed, 42 chars)")
    entity_type: EntityType | None = Field(
        None, description="Entity type classification"
    )
    risk_level: RiskLevel = Field(RiskLevel.UNKNOWN, description="Risk level")
    name: str | None = Field(None, description="Human-readable name")
    labels: list[str] = Field(
        default_factory=list, description="Additional labels/tags"
    )
    properties: dict[str, Any] = Field(
        default_factory=dict, description="Extra properties"
    )



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
    user_id: int | None
    entity_address: str
    entity_type: EntityType | None
    risk_level: RiskLevel
    labels: list[str] | None
    notes: str | None
    confidence: float | None
    created_at: datetime


# ── Entity Features (migration 003) ───────────────────────────────────────────


class EntityFeaturesResponse(BaseModel):
    """Response model for computed on-chain behavioural features of an entity."""

    address: str = Field(..., description="Ethereum address")
    chain_id: int = Field(1, description="Chain ID (1 = Ethereum mainnet)")

    # Timestamps / Activity
    first_seen_at: datetime | None = Field(
        None, description="First on-chain appearance"
    )
    last_seen_at: datetime | None = Field(
        None, description="Most recent on-chain activity"
    )
    activity_interval_avg_sec: float | None = Field(
        None, description="Average interval between recent transactions (seconds)"
    )
    active_hour_distribution: list[float] | None = Field(
        None, description="24-element float array — activity ratio per UTC hour"
    )

    # Balance
    balance_avg_wei: str | None = Field(
        None, description="Average wallet balance in wei"
    )
    balance_max_wei: str | None = Field(
        None, description="Maximum observed wallet balance in wei"
    )

    # Behaviour flags
    has_deployed_contract: bool = Field(
        False, description="Whether this address has ever deployed a contract"
    )
    is_labeled: bool = Field(
        False, description="Whether this address is matched in known_labels"
    )

    # Graph topology
    out_degree: int = Field(0, description="Number of outgoing transactions sent")
    in_degree: int = Field(0, description="Number of incoming transactions received")
    unique_interacted_entities: int = Field(
        0, description="Unique addresses interacted with (in + out union)"
    )

    # Risk indicators
    same_type_transfer_count: int = Field(
        0, description="Transfers sent to addresses of the same entity type"
    )
    same_amount_transfer_count: int = Field(
        0, description="Transfers with identical outgoing amount (structuring pattern)"
    )

    # Volume
    volume_in_wei: str | None = Field(None, description="Total incoming value in wei")
    volume_out_wei: str | None = Field(None, description="Total outgoing value in wei")

    # System
    computed_at: datetime | None = Field(
        None, description="Timestamp of the last ETL computation"
    )
    updated_at: datetime | None = Field(None, description="Last row update time")


class EntityFeaturesUpsertRequest(BaseModel):
    """Request model for creating or updating entity features (e.g. from ETL pipeline)."""

    chain_id: int = Field(1, description="Chain ID (default: 1 = Ethereum mainnet)")

    # Timestamps / Activity
    first_seen_at: datetime | None = Field(
        None, description="First on-chain appearance"
    )
    last_seen_at: datetime | None = Field(
        None, description="Most recent on-chain activity"
    )
    activity_interval_avg_sec: float | None = Field(
        None, description="Average interval between recent transactions (seconds)"
    )
    active_hour_distribution: list[float] | None = Field(
        None,
        description="24-element float array — activity ratio per UTC hour",
        min_length=24,
        max_length=24,
    )

    # Balance (wei as string to avoid precision loss)
    balance_avg_wei: str | None = Field(
        None, description="Average wallet balance in wei"
    )
    balance_max_wei: str | None = Field(
        None, description="Maximum observed wallet balance in wei"
    )

    # Behaviour flags
    has_deployed_contract: bool = Field(
        False, description="Whether this address has ever deployed a contract"
    )
    is_labeled: bool = Field(
        False, description="Whether this address is matched in known_labels"
    )

    # Graph topology
    out_degree: int = Field(0, ge=0, description="Number of outgoing transactions")
    in_degree: int = Field(0, ge=0, description="Number of incoming transactions")
    unique_interacted_entities: int = Field(
        0, ge=0, description="Unique counterparty addresses"
    )

    # Risk indicators
    same_type_transfer_count: int = Field(
        0, ge=0, description="Transfers to same-type wallets"
    )
    same_amount_transfer_count: int = Field(
        0, ge=0, description="Transfers with identical amount"
    )

    # Volume (wei as string)
    volume_in_wei: str | None = Field(None, description="Total incoming value in wei")
    volume_out_wei: str | None = Field(None, description="Total outgoing value in wei")

    # System
    computed_at: datetime | None = Field(
        None, description="Timestamp of the ETL computation"
    )
