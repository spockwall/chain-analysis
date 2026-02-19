"""Initial schema

Revision ID: 001
Revises:
Create Date: 2024-01-01

"""

import sqlalchemy as sa

from typing import Sequence, Union
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create enums
    task_status = sa.Enum(
        "pending", "in_progress", "completed", "skipped", name="taskstatus"
    )
    risk_level = sa.Enum(
        "unknown", "low", "medium", "high", "critical", name="risklevel"
    )
    entity_type = sa.Enum(
        "EOA",
        "Contract",
        "Mixer",
        "LendingPool",
        "Bridge",
        "DEX",
        "CEXHotWallet",
        "Application",
        "Unknown",
        name="entitytype",
    )
    ingestion_status = sa.Enum("running", "completed", "failed", name="ingestionstatus")

    # Create labelers table
    op.create_table(
        "labelers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(100), unique=True, nullable=False),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("is_active", sa.Boolean(), default=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
    )

    # Create label_tasks table
    op.create_table(
        "label_tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("entity_address", sa.String(42), nullable=False, index=True),
        sa.Column("status", task_status, default="pending"),
        sa.Column("priority", sa.Integer(), default=0),
        sa.Column("title", sa.String(255)),
        sa.Column("description", sa.Text()),
        sa.Column("context", sa.JSON()),
        sa.Column("assignee_id", sa.Integer(), sa.ForeignKey("labelers.id")),
        sa.Column("assigned_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
    )
    op.create_index(
        "ix_label_tasks_status_priority",
        "label_tasks",
        ["status", "priority"],
    )

    # Create annotations table
    op.create_table(
        "annotations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "task_id", sa.Integer(), sa.ForeignKey("label_tasks.id"), nullable=False
        ),
        sa.Column(
            "labeler_id", sa.Integer(), sa.ForeignKey("labelers.id"), nullable=False
        ),
        sa.Column("entity_address", sa.String(42), nullable=False, index=True),
        sa.Column("entity_type", entity_type),
        sa.Column("risk_level", risk_level, default="unknown"),
        sa.Column("labels", sa.JSON()),
        sa.Column("notes", sa.Text()),
        sa.Column("evidence", sa.JSON()),
        sa.Column("confidence", sa.Float()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_annotations_entity_labeler",
        "annotations",
        ["entity_address", "labeler_id"],
    )

    # Create known_labels table
    op.create_table(
        "known_labels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("address", sa.String(42), nullable=False, index=True),
        sa.Column("chain_id", sa.Integer(), default=1),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("entity_type", entity_type),
        sa.Column("category", sa.String(100)),
        sa.Column("subcategory", sa.String(100)),
        sa.Column("risk_level", risk_level, default="unknown"),
        sa.Column("source", sa.String(100), nullable=False),
        sa.Column("source_url", sa.String(500)),
        sa.Column("verified", sa.Boolean(), default=False),
        sa.Column("metadata", sa.JSON()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "address", "chain_id", name="uq_known_labels_address_chain"
        ),
    )
    op.create_index("ix_known_labels_category", "known_labels", ["category"])

    # Create ingestion_runs table
    op.create_table(
        "ingestion_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("run_id", sa.String(36), unique=True, nullable=False),
        sa.Column("chain_id", sa.Integer(), default=1),
        sa.Column("start_block", sa.BigInteger(), nullable=False),
        sa.Column("end_block", sa.BigInteger(), nullable=False),
        sa.Column("data_source", sa.String(50), nullable=False),
        sa.Column("status", ingestion_status, default="running"),
        sa.Column("error_message", sa.Text()),
        sa.Column("transactions_processed", sa.Integer(), default=0),
        sa.Column("traces_processed", sa.Integer(), default=0),
        sa.Column("nodes_created", sa.Integer(), default=0),
        sa.Column("edges_created", sa.Integer(), default=0),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("dagster_run_id", sa.String(36)),
    )
    op.create_index("ix_ingestion_runs_status", "ingestion_runs", ["status"])
    op.create_index(
        "ix_ingestion_runs_blocks",
        "ingestion_runs",
        ["chain_id", "start_block", "end_block"],
    )


def downgrade() -> None:
    op.drop_table("ingestion_runs")
    op.drop_table("known_labels")
    op.drop_table("annotations")
    op.drop_table("label_tasks")
    op.drop_table("labelers")

    # Drop enums
    op.execute("DROP TYPE IF EXISTS taskstatus")
    op.execute("DROP TYPE IF EXISTS risklevel")
    op.execute("DROP TYPE IF EXISTS entitytype")
    op.execute("DROP TYPE IF EXISTS ingestionstatus")
