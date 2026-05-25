"""Add last_synced_block to entity_features

Revision ID: 007
Revises: 006
Create Date: 2026-04-22

Phase I — the Rust worker's background refresh loop needs a per-address
delta cursor so each refresh only fetches blocks newer than the last
successful ingest. Defaults to 0 so existing rows fall back to a full
range fetch on first refresh.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "entity_features",
        sa.Column(
            "last_synced_block",
            sa.BigInteger(),
            server_default="0",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("entity_features", "last_synced_block")
