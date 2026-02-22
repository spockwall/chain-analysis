"""
SQLAlchemy models for PostgreSQL.

These tables store:
- Labeling workflow data (labelers, tasks, annotations)
- Known entity references
- ETL ingestion metadata
"""

from datetime import datetime
from enum import Enum as PyEnum
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
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
    IN_PROGRESS = "in_progress"
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


class Labeler(Base):
    """Human analyst who performs labeling tasks."""

    __tablename__ = "labelers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    assigned_tasks: Mapped[list["LabelTask"]] = relationship(
        "LabelTask", back_populates="assignee"
    )
    annotations: Mapped[list["Annotation"]] = relationship(
        "Annotation", back_populates="labeler"
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
        Integer, ForeignKey("labelers.id"), nullable=True
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
    assignee: Mapped[Labeler | None] = relationship(
        "Labeler", back_populates="assigned_tasks"
    )
    annotations: Mapped[list["Annotation"]] = relationship(
        "Annotation", back_populates="task"
    )

    __table_args__ = (Index("ix_label_tasks_status_priority", "status", "priority"),)


class Annotation(Base):
    """A label annotation submitted by a labeler."""

    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("label_tasks.id"), nullable=False
    )
    labeler_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("labelers.id"), nullable=False
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
    labeler: Mapped[Labeler] = relationship("Labeler", back_populates="annotations")

    __table_args__ = (
        Index("ix_annotations_entity_labeler", "entity_address", "labeler_id"),
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
