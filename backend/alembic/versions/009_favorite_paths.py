"""Favorite paths — per-user saved transaction paths

Revision ID: 009
Revises: 008
Create Date: 2026-05-16

Tables: favorite_paths

A user can bookmark (source, target) address pairs they want to revisit in
the graph explorer. Storage is server-side so favorites follow the user
across browsers/devices rather than living only in localStorage.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "favorite_paths",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey(
                "users.id",
                ondelete="CASCADE",
                name="fk_favorite_paths_user_users",
            ),
            nullable=False,
        ),
        sa.Column("source", sa.String(42), nullable=False),
        sa.Column("target", sa.String(42), nullable=False),
        sa.Column("label", sa.String(255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "user_id", "source", "target", name="uq_favorite_paths_user_endpoints"
        ),
    )
    op.create_index(
        "ix_favorite_paths_user_created",
        "favorite_paths",
        ["user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_favorite_paths_user_created", table_name="favorite_paths")
    op.drop_table("favorite_paths")
