"""Rename taskstatus enum value in_progress -> running

Revision ID: 008
Revises: 007
Create Date: 2026-04-22

Aligns label_tasks with ingestion_runs, which already uses 'running'.
Single source of truth for an active-task badge across the app.
"""

from typing import Sequence, Union

from alembic import op


revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE taskstatus RENAME VALUE 'in_progress' TO 'running'")


def downgrade() -> None:
    op.execute("ALTER TYPE taskstatus RENAME VALUE 'running' TO 'in_progress'")
