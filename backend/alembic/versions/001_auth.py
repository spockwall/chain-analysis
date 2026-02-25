"""Auth — users table and shared enums

Revision ID: 001
Revises:
Create Date: 2026-02-25

Tables: users
Enums:  taskstatus, risklevel, entitytype, ingestionstatus

All shared PostgreSQL enums are created here so subsequent migrations
can reference them without re-declaring them.

Roles:
  admin    — full control; manage users and all data
  operator — data provider / analyst; can ingest and annotate
  user     — read-only viewer
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Shared enums ──────────────────────────────────────────────────────────
    op.execute(
        "CREATE TYPE taskstatus AS ENUM"
        " ('pending', 'in_progress', 'completed', 'skipped')"
    )
    op.execute(
        "CREATE TYPE risklevel AS ENUM"
        " ('unknown', 'low', 'medium', 'high', 'critical')"
    )
    op.execute(
        "CREATE TYPE entitytype AS ENUM"
        " ('EOA', 'Contract', 'Mixer', 'LendingPool', 'Bridge',"
        "  'DEX', 'CEXHotWallet', 'Application', 'Unknown')"
    )
    op.execute(
        "CREATE TYPE ingestionstatus AS ENUM"
        " ('running', 'completed', 'failed')"
    )

    # ── users ─────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(100), unique=True, nullable=False),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column(
            "role",
            sa.String(50),
            nullable=False,
            server_default="user",
        ),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
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
        sa.CheckConstraint(
            "role IN ('admin', 'operator', 'user')",
            name="ck_users_role",
        ),
    )


def downgrade() -> None:
    op.drop_table("users")

    op.execute("DROP TYPE IF EXISTS taskstatus")
    op.execute("DROP TYPE IF EXISTS risklevel")
    op.execute("DROP TYPE IF EXISTS entitytype")
    op.execute("DROP TYPE IF EXISTS ingestionstatus")
