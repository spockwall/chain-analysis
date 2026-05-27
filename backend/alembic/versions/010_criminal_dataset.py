"""Create criminal dataset entries

Revision ID: 010
Revises: 009
Create Date: 2026-05-27
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "criminal_dataset_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("criminal_address", sa.String(length=42), nullable=True),
        sa.Column("criminal_transaction_hash", sa.String(length=66), nullable=True),
        sa.Column("source_transaction_hash", sa.String(length=66), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            """
            (criminal_address IS NOT NULL AND criminal_transaction_hash IS NULL)
            OR
            (criminal_address IS NULL AND criminal_transaction_hash IS NOT NULL)
            """,
            name="ck_criminal_dataset_entries_one_identifier",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name="fk_criminal_dataset_entries_created_by_users",
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint(
            "criminal_address",
            name="uq_criminal_dataset_entries_address",
        ),
        sa.UniqueConstraint(
            "criminal_transaction_hash",
            name="uq_criminal_dataset_entries_transaction_hash",
        ),
    )
    op.create_index(
        "ix_criminal_dataset_entries_created_at",
        "criminal_dataset_entries",
        ["created_at"],
    )
    op.create_index(
        "ix_criminal_dataset_entries_created_by",
        "criminal_dataset_entries",
        ["created_by_user_id"],
    )
    op.create_index(
        "ix_criminal_dataset_entries_source_tx",
        "criminal_dataset_entries",
        ["source_transaction_hash"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_criminal_dataset_entries_source_tx",
        table_name="criminal_dataset_entries",
    )
    op.drop_index(
        "ix_criminal_dataset_entries_created_by",
        table_name="criminal_dataset_entries",
    )
    op.drop_index(
        "ix_criminal_dataset_entries_created_at",
        table_name="criminal_dataset_entries",
    )
    op.drop_table("criminal_dataset_entries")
