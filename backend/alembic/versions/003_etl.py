"""ETL — ingestion_runs, entity_features

Revision ID: 003
Revises: 002
Create Date: 2026-02-25

Tables: ingestion_runs, entity_features

ETL pipeline tables:
  ingestion_runs   — tracks every ETL run for monitoring and auditability
  entity_features  — computed on-chain behavioural features per address,
                     persisted here for structured querying and ML feature
                     engineering (previously only written to Neo4j properties)
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Reference to pre-existing enum type (created in migration 001).
ingestionstatus = postgresql.ENUM(
    "running", "completed", "failed",
    name="ingestionstatus",
    create_type=False,
)


def upgrade() -> None:
    # ── ingestion_runs ────────────────────────────────────────────────────────
    op.create_table(
        "ingestion_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("run_id", sa.String(36), unique=True, nullable=False),
        sa.Column("chain_id", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("start_block", sa.BigInteger(), nullable=False),
        sa.Column("end_block", sa.BigInteger(), nullable=False),
        sa.Column("data_source", sa.String(50), nullable=False),
        sa.Column(
            "status",
            ingestionstatus,
            nullable=False,
            server_default="running",
        ),
        sa.Column("error_message", sa.Text()),
        sa.Column("transactions_processed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("traces_processed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("nodes_created", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("edges_created", sa.Integer(), nullable=False, server_default="0"),
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

    # ── entity_features ───────────────────────────────────────────────────────
    op.create_table(
        "entity_features",
        sa.Column("address", sa.String(42), primary_key=True),
        sa.Column("chain_id", sa.Integer(), nullable=False, server_default="1"),

        # ── Timestamps / Activity ─────────────────────────────────────────────
        # First on-chain appearance
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=True),
        # Most recent on-chain activity
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        # Average interval between recent transactions (seconds)
        sa.Column("activity_interval_avg_sec", sa.Float(), nullable=True),
        # 24-element float array — activity ratio per UTC hour
        sa.Column("active_hour_distribution", sa.JSON(), nullable=True),

        # ── Balance ───────────────────────────────────────────────────────────
        # Stored as NUMERIC(78,0) to hold full uint256 wei values without loss
        sa.Column("balance_avg_wei", sa.Numeric(precision=78, scale=0), nullable=True),
        sa.Column("balance_max_wei", sa.Numeric(precision=78, scale=0), nullable=True),

        # ── Behaviour Flags ───────────────────────────────────────────────────
        sa.Column(
            "has_deployed_contract",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
        sa.Column("is_labeled", sa.Boolean(), nullable=False, server_default="false"),

        # ── Graph Topology ────────────────────────────────────────────────────
        sa.Column("out_degree", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("in_degree", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "unique_interacted_entities",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),

        # ── Risk Indicators ───────────────────────────────────────────────────
        # Transfers sent to addresses of the same entity type (e.g. EOA → EOA)
        sa.Column(
            "same_type_transfer_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        # Transfers with identical outgoing amount (structuring / round-number pattern)
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


def downgrade() -> None:
    op.drop_index("ix_entity_features_risk_indicators", table_name="entity_features")
    op.drop_index("ix_entity_features_chain_last_seen", table_name="entity_features")
    op.drop_table("entity_features")

    op.drop_index("ix_ingestion_runs_blocks", table_name="ingestion_runs")
    op.drop_index("ix_ingestion_runs_status", table_name="ingestion_runs")
    op.drop_table("ingestion_runs")
