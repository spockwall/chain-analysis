"""Add pickup_at to label_tasks

Revision ID: 009
Revises: 008
Create Date: 2026-05-12

Issue #3 acceptance: measure deep-trace latency from queue pickup to
completion as a Prometheus histogram. label_tasks already has
created_at (enqueue time) and completed_at (finish time); pickup_at
captures the moment the worker actually started the task, so the
histogram measures *worker time*, not queue wait. Useful for
distinguishing "deep trace is slow because the worker is busy" from
"deep trace is slow because Etherscan is slow".

Nullable to keep existing rows valid. Newly-created rows fill it in
via mark_pickup() in etl-rs/crates/etl/src/ingest/targeted.rs.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "label_tasks",
        sa.Column("pickup_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("label_tasks", "pickup_at")
