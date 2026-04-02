"""Raw transactions partitioned table

Revision ID: 004
Revises: 003
Create Date: 2026-03-04

Tables: raw_transactions (hash partitioned)
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '004'
down_revision: Union[str, None] = '003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create the parent partitioned table
    op.create_table(
        'raw_transactions',
        sa.Column('hash', sa.String(length=66), nullable=False),
        sa.Column('chain_id', sa.Integer(), nullable=False),
        sa.Column('block_number', sa.BigInteger(), nullable=False),
        sa.Column('block_timestamp', sa.DateTime(timezone=True), nullable=False),
        sa.Column('from_address', sa.String(length=42), nullable=False),
        sa.Column('to_address', sa.String(length=42), nullable=True),
        sa.Column('from_category', sa.String(length=100), nullable=True),
        sa.Column('to_category', sa.String(length=100), nullable=True),
        sa.Column('value_wei', sa.Numeric(precision=78, scale=0), nullable=False),
        sa.Column('gas_used', sa.BigInteger(), nullable=True),
        sa.Column('gas_price', sa.Numeric(precision=78, scale=0), nullable=True),
        sa.Column('method_id', sa.String(length=10), nullable=True),
        sa.Column('function_name', sa.String(length=255), nullable=True),
        sa.PrimaryKeyConstraint('hash', 'chain_id'),
        postgresql_partition_by='HASH (hash)'
    )

    # 2. Create indexes on the parent table
    op.create_index(op.f('ix_raw_transactions_block_number'), 'raw_transactions', ['block_number'], unique=False)
    op.create_index(op.f('ix_raw_transactions_block_timestamp'), 'raw_transactions', ['block_timestamp'], unique=False)
    op.create_index(op.f('ix_raw_transactions_from_address'), 'raw_transactions', ['from_address'], unique=False)
    op.create_index(op.f('ix_raw_transactions_to_address'), 'raw_transactions', ['to_address'], unique=False)
    op.create_index(op.f('ix_raw_transactions_method_id'), 'raw_transactions', ['method_id'], unique=False)

    # 3. Create 16 hash partitions
    for i in range(16):
        op.execute(f"""
            CREATE TABLE raw_transactions_{i}
            PARTITION OF raw_transactions
            FOR VALUES WITH (MODULUS 16, REMAINDER {i});
        """)


def downgrade() -> None:
    # Dropping the parent table automatically drops all partitions in PostgreSQL
    op.drop_index(op.f('ix_raw_transactions_method_id'), table_name='raw_transactions')
    op.drop_index(op.f('ix_raw_transactions_to_address'), table_name='raw_transactions')
    op.drop_index(op.f('ix_raw_transactions_from_address'), table_name='raw_transactions')
    op.drop_index(op.f('ix_raw_transactions_block_timestamp'), table_name='raw_transactions')
    op.drop_index(op.f('ix_raw_transactions_block_number'), table_name='raw_transactions')
    op.drop_table('raw_transactions')
