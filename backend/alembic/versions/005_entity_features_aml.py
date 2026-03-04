"""AML extensions for Entity Features

Revision ID: 005
Revises: 004
Create Date: 2026-03-04

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '005'
down_revision: Union[str, None] = '004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add new gas and interaction features to entity_features
    op.add_column('entity_features', sa.Column('total_gas_spent_wei', sa.Numeric(precision=78, scale=0), nullable=True))
    op.add_column('entity_features', sa.Column('same_gas_fee_tx_count', sa.Integer(), nullable=False, server_default='0'))
    
    # Add label interaction features
    op.add_column('entity_features', sa.Column('mixer_interaction_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('entity_features', sa.Column('bridge_interaction_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('entity_features', sa.Column('labeled_contract_interaction_count', sa.Integer(), nullable=False, server_default='0'))
    
    # Add flags for graph-detected money laundering patterns
    op.add_column('entity_features', sa.Column('is_peel_chain_suspect', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('entity_features', sa.Column('is_fan_out_suspect', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('entity_features', sa.Column('is_hopping_suspect', sa.Boolean(), nullable=False, server_default='false'))


def downgrade() -> None:
    # Drop AML pattern flags
    op.drop_column('entity_features', 'is_hopping_suspect')
    op.drop_column('entity_features', 'is_fan_out_suspect')
    op.drop_column('entity_features', 'is_peel_chain_suspect')
    
    # Drop label interactions
    op.drop_column('entity_features', 'labeled_contract_interaction_count')
    op.drop_column('entity_features', 'bridge_interaction_count')
    op.drop_column('entity_features', 'mixer_interaction_count')
    
    # Drop gas features
    op.drop_column('entity_features', 'same_gas_fee_tx_count')
    op.drop_column('entity_features', 'total_gas_spent_wei')
