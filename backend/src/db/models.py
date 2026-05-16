"""
SQLAlchemy models for PostgreSQL.

These tables store:
- Labeling workflow data (label tasks, annotations)
- Known entity references
- ETL ingestion metadata
- Users and authentication
"""

from datetime import datetime
from decimal import Decimal
from enum import Enum as PyEnum
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.sql import func


class Base(DeclarativeBase):
    """Base class for all models."""

    type_annotation_map = {
        dict[str, Any]: JSON,
    }


# =============================================================================
# Enums
# =============================================================================


class UserRole(str, PyEnum):
    """Application user role."""

    ADMIN = "admin"  # Full control — manage users, operators, all data
    OPERATOR = "operator"  # Data provider / analyst — can ingest and annotate
    USER = "user"  # Read-only viewer; future subscribe-API tier


class TaskStatus(str, PyEnum):
    """Label task status."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    SKIPPED = "skipped"


class RiskLevel(str, PyEnum):
    """Risk level for entities."""

    UNKNOWN = "unknown"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class EntityType(str, PyEnum):
    """Entity types matching Neo4j labels."""

    EOA = "EOA"
    CONTRACT = "Contract"
    MIXER = "Mixer"
    LENDING_POOL = "LendingPool"
    BRIDGE = "Bridge"
    DEX = "DEX"
    CEX_HOT_WALLET = "CEXHotWallet"
    APPLICATION = "Application"
    UNKNOWN = "Unknown"


class IngestionStatus(str, PyEnum):
    """Ingestion run status."""

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


# =============================================================================
# Models
# =============================================================================


class User(Base):
    """Application user with authentication credentials."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(
        String(50), default=UserRole.USER.value, nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class LabelTask(Base):
    """A labeling task for an entity or subgraph."""

    __tablename__ = "label_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_address: Mapped[str] = mapped_column(String(42), nullable=False, index=True)
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus), default=TaskStatus.PENDING
    )
    priority: Mapped[int] = mapped_column(Integer, default=0)  # Higher = more urgent

    # Task metadata
    title: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    context: Mapped[dict[str, Any] | None] = mapped_column(JSON)  # Subgraph context

    # Assignment
    assignee_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey(
            "users.id", ondelete="SET NULL", name="fk_label_tasks_assignee_users"
        ),
        nullable=True,
    )
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Relationships
    assignee: Mapped["User | None"] = relationship("User", foreign_keys=[assignee_id])
    annotations: Mapped[list["Annotation"]] = relationship(
        "Annotation", back_populates="task"
    )

    __table_args__ = (Index("ix_label_tasks_status_priority", "status", "priority"),)


class Annotation(Base):
    """A label annotation submitted by a user."""

    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("label_tasks.id"), nullable=False
    )
    user_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey(
            "users.id", ondelete="SET NULL", name="fk_annotations_user_users"
        ),
        nullable=True,
    )
    entity_address: Mapped[str] = mapped_column(String(42), nullable=False, index=True)

    # Label data
    entity_type: Mapped[EntityType | None] = mapped_column(Enum(EntityType))
    risk_level: Mapped[RiskLevel] = mapped_column(
        Enum(RiskLevel), default=RiskLevel.UNKNOWN
    )
    labels: Mapped[list[str] | None] = mapped_column(JSON)  # Additional tags
    notes: Mapped[str | None] = mapped_column(Text)
    evidence: Mapped[dict[str, Any] | None] = mapped_column(JSON)  # Supporting data

    # Confidence
    confidence: Mapped[float | None] = mapped_column()  # 0.0 - 1.0

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # Relationships
    task: Mapped[LabelTask] = relationship("LabelTask", back_populates="annotations")
    user: Mapped["User | None"] = relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        Index("ix_annotations_entity_user", "entity_address", "user_id"),
    )


class KnownLabel(Base):
    """
    Reference data for known entities (exchanges, mixers, etc.).
    Pre-populated from public sources like Etherscan labels.
    """

    __tablename__ = "known_labels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    address: Mapped[str] = mapped_column(String(42), nullable=False, index=True)
    chain_id: Mapped[int] = mapped_column(Integer, default=1)  # 1 = Ethereum mainnet

    # Label data
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    entity_type: Mapped[EntityType | None] = mapped_column(Enum(EntityType))
    category: Mapped[str | None] = mapped_column(
        String(100)
    )  # e.g., "exchange", "defi"
    subcategory: Mapped[str | None] = mapped_column(String(100))
    risk_level: Mapped[RiskLevel] = mapped_column(
        Enum(RiskLevel), default=RiskLevel.UNKNOWN
    )

    # Source tracking
    source: Mapped[str] = mapped_column(
        String(100), nullable=False
    )  # e.g., "etherscan"
    source_url: Mapped[str | None] = mapped_column(String(500))
    verified: Mapped[bool] = mapped_column(Boolean, default=False)

    # Additional metadata
    extra_data: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSON)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("address", "chain_id", name="uq_known_labels_address_chain"),
        Index("ix_known_labels_category", "category"),
    )


class IngestionRun(Base):
    """
    Track ETL ingestion runs for monitoring and debugging.
    """

    __tablename__ = "ingestion_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(36), unique=True, nullable=False)

    # Run parameters
    chain_id: Mapped[int] = mapped_column(Integer, default=1)
    start_block: Mapped[int] = mapped_column(BigInteger, nullable=False)
    end_block: Mapped[int] = mapped_column(BigInteger, nullable=False)
    data_source: Mapped[str] = mapped_column(
        String(50), nullable=False
    )  # e.g., "allium"

    # Status
    status: Mapped[IngestionStatus] = mapped_column(
        Enum(IngestionStatus), default=IngestionStatus.RUNNING
    )
    error_message: Mapped[str | None] = mapped_column(Text)

    # Metrics
    transactions_processed: Mapped[int] = mapped_column(Integer, default=0)
    traces_processed: Mapped[int] = mapped_column(Integer, default=0)
    nodes_created: Mapped[int] = mapped_column(Integer, default=0)
    edges_created: Mapped[int] = mapped_column(Integer, default=0)

    # Timestamps
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Dagster integration
    dagster_run_id: Mapped[str | None] = mapped_column(String(36))

    __table_args__ = (
        Index("ix_ingestion_runs_status", "status"),
        Index("ix_ingestion_runs_blocks", "chain_id", "start_block", "end_block"),
    )


class EntityFeatures(Base):
    """
    Computed on-chain behavioural features for each entity address.

    Populated by the `computed_features` Dagster ETL asset and persisted here
    for structured querying, ML feature engineering, and risk dashboards.
    Primary key is (address, chain_id) but address alone is used as PK for
    simplicity since the system currently targets Ethereum mainnet only.
    """

    __tablename__ = "entity_features"

    address: Mapped[str] = mapped_column(String(42), primary_key=True)
    chain_id: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    # ── Timestamps / Activity ────────────────────────────────────────────────
    # First on-chain appearance (creation time)
    first_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Most recent on-chain activity
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Average interval between recent transactions (seconds)
    activity_interval_avg_sec: Mapped[float | None] = mapped_column(
        Float, nullable=True
    )
    # Active timezone distribution: 24-element float list, one value per UTC hour
    # e.g. [0.0, 0.0, 0.12, ..., 0.45]
    active_hour_distribution: Mapped[list | None] = mapped_column(JSON, nullable=True)

    # ── Balance ──────────────────────────────────────────────────────────────
    # Average wallet balance in wei. Numeric(78,0) returns Decimal, not int.
    balance_avg_wei: Mapped[Decimal | None] = mapped_column(
        Numeric(precision=78, scale=0), nullable=True
    )
    # Maximum observed wallet balance in wei
    balance_max_wei: Mapped[Decimal | None] = mapped_column(
        Numeric(precision=78, scale=0), nullable=True
    )

    # ── Behaviour Flags ──────────────────────────────────────────────────────
    # Whether this address has ever deployed a contract
    has_deployed_contract: Mapped[bool] = mapped_column(Boolean, default=False)
    # Whether this address is matched in the known_labels reference table
    is_labeled: Mapped[bool] = mapped_column(Boolean, default=False)

    # Highest block number whose transactions have been ingested for this
    # address. The Rust worker's refresh loop uses this as a delta cursor.
    last_synced_block: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )

    # ── Graph Topology ───────────────────────────────────────────────────────
    # Out-degree: number of outgoing transactions sent
    out_degree: Mapped[int] = mapped_column(Integer, default=0)
    # In-degree: number of incoming transactions received
    in_degree: Mapped[int] = mapped_column(Integer, default=0)
    # Number of unique entities interacted with (union of in + out counterparties)
    unique_interacted_entities: Mapped[int] = mapped_column(Integer, default=0)

    # ── Behaviour Patterns (Risk Indicators) ─────────────────────────────────
    # Number of transfers sent to addresses of the same entity type
    same_type_transfer_count: Mapped[int] = mapped_column(Integer, default=0)
    # Number of transfers with the same outgoing amount (structuring / round-number pattern)
    same_amount_transfer_count: Mapped[int] = mapped_column(Integer, default=0)

    # ── Volume ───────────────────────────────────────────────────────────────
    # Total value transferred in wei. Numeric(78,0) returns Decimal, not int.
    volume_in_wei: Mapped[Decimal | None] = mapped_column(
        Numeric(precision=78, scale=0), nullable=True
    )
    volume_out_wei: Mapped[Decimal | None] = mapped_column(
        Numeric(precision=78, scale=0), nullable=True
    )

    # ── Gas & Pattern Features (AML extensions) ──────────────────────────────
    total_gas_spent_wei: Mapped[Decimal | None] = mapped_column(
        Numeric(precision=78, scale=0), nullable=True
    )
    same_gas_fee_tx_count: Mapped[int] = mapped_column(Integer, default=0)
    
    # ── Label Interactions (Cross-chain/Mixer) ───────────────────────────────
    mixer_interaction_count: Mapped[int] = mapped_column(Integer, default=0)
    bridge_interaction_count: Mapped[int] = mapped_column(Integer, default=0)
    labeled_contract_interaction_count: Mapped[int] = mapped_column(Integer, default=0)

    # ── AML Topology Flags (Populated from Neo4j) ────────────────────────────
    is_peel_chain_suspect: Mapped[bool] = mapped_column(Boolean, default=False)
    is_fan_out_suspect: Mapped[bool] = mapped_column(Boolean, default=False)
    is_hopping_suspect: Mapped[bool] = mapped_column(Boolean, default=False)

    # ── System Fields ────────────────────────────────────────────────────────
    # Timestamp of the ETL run that last computed these features
    computed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_entity_features_chain_last_seen", "chain_id", "last_seen_at"),
        Index(
            "ix_entity_features_risk_indicators",
            "same_amount_transfer_count",
            "out_degree",
        ),
    )


class AddressNickname(Base):
    """A user's private nickname for an on-chain address (typically an EOA)."""

    __tablename__ = "address_nicknames"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey(
            "users.id",
            ondelete="CASCADE",
            name="fk_address_nicknames_user_users",
        ),
        nullable=False,
    )
    address: Mapped[str] = mapped_column(String(42), nullable=False)
    nickname: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        UniqueConstraint(
            "user_id", "address", name="uq_address_nicknames_user_address"
        ),
    )


class RawTransaction(Base):
    """
    Raw transactions ingested from the blockchain.
    Partitioned by the transaction hash to distribute the massive data load evenly.
    """

    __tablename__ = "raw_transactions"
    __table_args__ = {
        "postgresql_partition_by": "HASH (hash)"
    }

    hash: Mapped[str] = mapped_column(String(66), primary_key=True)
    chain_id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    
    block_number: Mapped[int] = mapped_column(BigInteger, index=True)
    block_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    
    from_address: Mapped[str] = mapped_column(String(42), index=True)
    to_address: Mapped[str | None] = mapped_column(String(42), nullable=True, index=True)
    
    # Label contexts 
    from_category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    to_category: Mapped[str | None] = mapped_column(String(100), nullable=True)

    value_wei: Mapped[Decimal] = mapped_column(Numeric(78, 0))
    gas_used: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    gas_price: Mapped[Decimal | None] = mapped_column(Numeric(78, 0), nullable=True)
    
    # Function calls
    method_id: Mapped[str | None] = mapped_column(String(10), nullable=True, index=True)
    function_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
