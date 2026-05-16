"""Address nicknames — per-user EOA aliases

Revision ID: 009
Revises: 008
Create Date: 2026-05-16

Tables: address_nicknames

Lets an analyst attach their own nickname to any address (typically EOAs).
Storage is per-user so two analysts looking at the same graph can keep
their own private labels without stepping on each other.
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
        "address_nicknames",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey(
                "users.id",
                ondelete="CASCADE",
                name="fk_address_nicknames_user_users",
            ),
            nullable=False,
        ),
        sa.Column("address", sa.String(42), nullable=False),
        sa.Column("nickname", sa.String(255), nullable=False),
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
        sa.UniqueConstraint(
            "user_id", "address", name="uq_address_nicknames_user_address"
        ),
    )


def downgrade() -> None:
    op.drop_table("address_nicknames")
