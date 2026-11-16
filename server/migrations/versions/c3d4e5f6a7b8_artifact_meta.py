"""artifact source / skill / parent；message.artifact_id

Revision ID: c3d4e5f6a7b8
Revises: a1b2c3d4e5f6
Create Date: 2026-11-16 03:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('artifact', sa.Column('source_md', sa.Text(), nullable=False, server_default=''))
    op.add_column('artifact', sa.Column('skill', sa.String(length=32), nullable=False, server_default=''))
    op.add_column('artifact', sa.Column('parent_id', sa.String(length=32), nullable=True))
    op.add_column('message', sa.Column('artifact_id', sa.String(length=32), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('message', 'artifact_id')
    op.drop_column('artifact', 'parent_id')
    op.drop_column('artifact', 'skill')
    op.drop_column('artifact', 'source_md')
