"""Add 'queued' value to ingestionstatus enum

Revision ID: 006
Revises: 005
Create Date: 2026-04-21

Phase H — the web-triggered ingest path records a run row the instant the
job is LPUSHed onto ingest:targeted_queue, before any Rust worker picks it
up. That intermediate state is `queued`. The Rust drain transitions it to
`running` on pickup and `completed`/`failed` on finish.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction on older
    # Postgres, but alembic's connection autocommits this DDL cleanly on PG13+.
    op.execute("ALTER TYPE ingestionstatus ADD VALUE IF NOT EXISTS 'queued' BEFORE 'running'")


def downgrade() -> None:
    # Postgres does not support removing enum values without a full type
    # rebuild. Downgrade is intentionally a no-op.
    pass
