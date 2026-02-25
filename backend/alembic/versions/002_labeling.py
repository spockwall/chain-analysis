"""Labeling — label_tasks, annotations, known_labels

Revision ID: 002
Revises: 001
Create Date: 2026-02-25

Tables: label_tasks, annotations, known_labels

Labeling workflow tables:
  label_tasks   — one task per entity address to be reviewed by an analyst
  annotations   — label decisions submitted by analysts (user_id nullable
                  so routes work before a session is wired to the endpoint)
  known_labels  — reference data for well-known entities (exchanges, mixers…)
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# References to pre-existing enum types (created in migration 001).
# create_type=False tells SQLAlchemy never to emit CREATE/DROP TYPE DDL.
taskstatus = postgresql.ENUM(
    "pending", "in_progress", "completed", "skipped",
    name="taskstatus",
    create_type=False,
)
entitytype = postgresql.ENUM(
    "EOA", "Contract", "Mixer", "LendingPool", "Bridge",
    "DEX", "CEXHotWallet", "Application", "Unknown",
    name="entitytype",
    create_type=False,
)
risklevel = postgresql.ENUM(
    "unknown", "low", "medium", "high", "critical",
    name="risklevel",
    create_type=False,
)


def upgrade() -> None:
    # ── label_tasks ───────────────────────────────────────────────────────────
    op.create_table(
        "label_tasks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("entity_address", sa.String(42), nullable=False, index=True),
        sa.Column(
            "status",
            taskstatus,
            nullable=False,
            server_default="pending",
        ),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("title", sa.String(255)),
        sa.Column("description", sa.Text()),
        sa.Column("context", sa.JSON()),
        sa.Column(
            "assignee_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL", name="fk_label_tasks_assignee_users"),
            nullable=True,
        ),
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

    # ── annotations ───────────────────────────────────────────────────────────
    op.create_table(
        "annotations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "task_id",
            sa.Integer(),
            sa.ForeignKey("label_tasks.id", name="fk_annotations_task"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL", name="fk_annotations_user_users"),
            nullable=True,
        ),
        sa.Column("entity_address", sa.String(42), nullable=False, index=True),
        sa.Column(
            "entity_type",
            entitytype,
            nullable=True,
        ),
        sa.Column(
            "risk_level",
            risklevel,
            nullable=False,
            server_default="unknown",
        ),
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
        "ix_annotations_entity_user",
        "annotations",
        ["entity_address", "user_id"],
    )

    # ── known_labels ──────────────────────────────────────────────────────────
    op.create_table(
        "known_labels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("address", sa.String(42), nullable=False, index=True),
        sa.Column("chain_id", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "entity_type",
            entitytype,
            nullable=True,
        ),
        sa.Column("category", sa.String(100)),
        sa.Column("subcategory", sa.String(100)),
        sa.Column(
            "risk_level",
            risklevel,
            nullable=False,
            server_default="unknown",
        ),
        sa.Column("source", sa.String(100), nullable=False),
        sa.Column("source_url", sa.String(500)),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default="false"),
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
        sa.UniqueConstraint("address", "chain_id", name="uq_known_labels_address_chain"),
    )
    op.create_index("ix_known_labels_category", "known_labels", ["category"])


def downgrade() -> None:
    op.drop_index("ix_known_labels_category", table_name="known_labels")
    op.drop_table("known_labels")

    op.drop_index("ix_annotations_entity_user", table_name="annotations")
    op.drop_table("annotations")

    op.drop_index("ix_label_tasks_status_priority", table_name="label_tasks")
    op.drop_table("label_tasks")
