"""Drop labelers table and make annotations.user_id nullable

Revision ID: 004
Revises: 003
Create Date: 2026-02-25

Changes:
1. Drop the `labelers` table (replaced by `users` in migration 002/003).
2. Rename annotations.labeler_id -> annotations.user_id for clarity.
3. Make annotations.user_id nullable (SET NULL on delete) so label routes
   work before a user session is wired to the endpoint.
4. Drop the taskstatus enum's dependency on labelers (already done via FKs
   in 003 — this just cleans up the orphaned table itself).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -------------------------------------------------------------------------
    # 1. annotations: drop FK to users, rename column, make nullable, re-add FK
    # -------------------------------------------------------------------------
    op.drop_constraint("fk_annotations_labeler_users", "annotations", type_="foreignkey")
    op.drop_index("ix_annotations_entity_labeler", table_name="annotations")

    op.alter_column("annotations", "labeler_id", new_column_name="user_id", nullable=True)

    op.create_index(
        "ix_annotations_entity_user",
        "annotations",
        ["entity_address", "user_id"],
    )
    op.create_foreign_key(
        "fk_annotations_user_users",
        "annotations",
        "users",
        ["user_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # -------------------------------------------------------------------------
    # 2. Drop the labelers table (no FKs point to it after migration 003)
    # -------------------------------------------------------------------------
    op.drop_table("labelers")


def downgrade() -> None:
    # Recreate labelers table
    op.create_table(
        "labelers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(100), unique=True, nullable=False),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # Restore annotations FK
    op.drop_constraint("fk_annotations_user_users", "annotations", type_="foreignkey")
    op.drop_index("ix_annotations_entity_user", table_name="annotations")

    op.alter_column("annotations", "user_id", new_column_name="labeler_id", nullable=False)

    op.create_index(
        "ix_annotations_entity_labeler",
        "annotations",
        ["entity_address", "labeler_id"],
    )
    op.create_foreign_key(
        "fk_annotations_labeler_users",
        "annotations",
        "users",
        ["labeler_id"],
        ["id"],
        ondelete="RESTRICT",
    )
