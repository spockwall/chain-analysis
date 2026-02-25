"""Add entity_features table and re-point labeler FKs to users

Revision ID: 003
Revises: 002
Create Date: 2026-02-23

Changes:
1. Add `entity_features` table for persisting computed on-chain behavioural
   features (previously only written to Neo4j via the ETL pipeline).
2. Drop the FK constraints on label_tasks.assignee_id and
   annotations.labeler_id that point to `labelers`, and re-create them
   pointing to `users`. This is the first step toward removing the redundant
   `labelers` table (deferred to migration 004).
"""

import sqlalchemy as sa
from typing import Sequence, Union
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -------------------------------------------------------------------------
    # 1. entity_features table
    # -------------------------------------------------------------------------
    op.create_table(
        "entity_features",
        sa.Column("address", sa.String(42), primary_key=True),
        sa.Column("chain_id", sa.Integer(), nullable=False, server_default="1"),
        # ── Timestamps / Activity ─────────────────────────────────────────────
        # First on-chain appearance (creation time)
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=True),
        # Most recent on-chain activity
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        # Average interval between recent transactions (seconds, computed by ETL)
        sa.Column("activity_interval_avg_sec", sa.Float(), nullable=True),
        # Active timezone distribution: 24-element float array, one entry per UTC hour
        # e.g. [0.0, 0.0, 0.12, ..., 0.45] — peaks indicate preferred active hours
        sa.Column("active_hour_distribution", sa.JSON(), nullable=True),
        # ── Balance ───────────────────────────────────────────────────────────
        # Average wallet balance in wei
        sa.Column("balance_avg_wei", sa.Numeric(precision=78, scale=0), nullable=True),
        # Maximum observed wallet balance in wei
        sa.Column("balance_max_wei", sa.Numeric(precision=78, scale=0), nullable=True),
        # ── Behaviour Flags ───────────────────────────────────────────────────
        # Whether this address has ever deployed a contract
        sa.Column(
            "has_deployed_contract",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
        # Whether this address is matched in the known_labels reference table
        sa.Column("is_labeled", sa.Boolean(), nullable=False, server_default="false"),
        # ── Graph Topology ────────────────────────────────────────────────────
        # Out-degree: number of outgoing transactions sent
        sa.Column("out_degree", sa.Integer(), nullable=False, server_default="0"),
        # In-degree: number of incoming transactions received
        sa.Column("in_degree", sa.Integer(), nullable=False, server_default="0"),
        # Number of unique entities interacted with (union of in + out counterparties)
        sa.Column(
            "unique_interacted_entities",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        # ── Behaviour Patterns (Risk Indicators) ──────────────────────────────
        # Number of transfers sent to addresses of the same entity type (e.g. EOA → EOA)
        sa.Column(
            "same_type_transfer_count", sa.Integer(), nullable=False, server_default="0"
        ),
        # Number of transfers with the same outgoing amount (structuring / round-number pattern)
        sa.Column(
            "same_amount_transfer_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        # ── Volume ────────────────────────────────────────────────────────────
        sa.Column("volume_in_wei", sa.Numeric(precision=78, scale=0), nullable=True),
        sa.Column("volume_out_wei", sa.Numeric(precision=78, scale=0), nullable=True),
        # ── System Fields ─────────────────────────────────────────────────────
        # Timestamp of the ETL run that last computed these features
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_entity_features_chain_last_seen",
        "entity_features",
        ["chain_id", "last_seen_at"],
    )
    op.create_index(
        "ix_entity_features_risk_indicators",
        "entity_features",
        ["same_amount_transfer_count", "out_degree"],
    )

    # -------------------------------------------------------------------------
    # 2. Re-point label_tasks.assignee_id → users.id
    # -------------------------------------------------------------------------
    # Drop old FK (labelers)
    op.drop_constraint(
        "label_tasks_assignee_id_fkey", "label_tasks", type_="foreignkey"
    )
    # Re-create pointing to users
    op.create_foreign_key(
        "fk_label_tasks_assignee_users",
        "label_tasks",
        "users",
        ["assignee_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # -------------------------------------------------------------------------
    # 3. Re-point annotations.labeler_id → users.id
    # -------------------------------------------------------------------------
    op.drop_constraint("annotations_labeler_id_fkey", "annotations", type_="foreignkey")
    op.create_foreign_key(
        "fk_annotations_labeler_users",
        "annotations",
        "users",
        ["labeler_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    # Restore annotations FK → labelers
    op.drop_constraint(
        "fk_annotations_labeler_users", "annotations", type_="foreignkey"
    )
    op.create_foreign_key(
        "annotations_labeler_id_fkey",
        "annotations",
        "labelers",
        ["labeler_id"],
        ["id"],
    )

    # Restore label_tasks FK → labelers
    op.drop_constraint(
        "fk_label_tasks_assignee_users", "label_tasks", type_="foreignkey"
    )
    op.create_foreign_key(
        "label_tasks_assignee_id_fkey",
        "label_tasks",
        "labelers",
        ["assignee_id"],
        ["id"],
    )

    op.drop_index("ix_entity_features_risk_indicators", table_name="entity_features")
    op.drop_index("ix_entity_features_chain_last_seen", table_name="entity_features")
    op.drop_table("entity_features")
