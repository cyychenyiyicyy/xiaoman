"""artifact.kind 放宽到 16（flashcards）

Revision ID: a1b2c3d4e5f6
Revises: f7c3a9e1b2d4
Create Date: 2026-11-16 02:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'f7c3a9e1b2d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column(
        'artifact',
        'kind',
        existing_type=sa.String(length=8),
        type_=sa.String(length=16),
        existing_nullable=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("update artifact set kind='html' where kind='flashcards'")
    op.alter_column(
        'artifact',
        'kind',
        existing_type=sa.String(length=16),
        type_=sa.String(length=8),
        existing_nullable=False,
    )
