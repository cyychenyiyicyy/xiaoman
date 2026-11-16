"""artifact + message.skill（技能产物）

Revision ID: f7c3a9e1b2d4
Revises: e5a1c8d2f4b6
Create Date: 2026-11-16 00:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'f7c3a9e1b2d4'
down_revision: Union[str, Sequence[str], None] = 'e5a1c8d2f4b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('message', sa.Column('skill', sa.String(length=32), nullable=False, server_default=''))

    op.create_table(
        'artifact',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('conversation_id', sa.String(length=32), nullable=False),
        sa.Column('message_id', sa.String(length=32), nullable=True),
        sa.Column('kind', sa.String(length=8), nullable=False),
        sa.Column('title', sa.String(length=120), nullable=False),
        sa.Column('subject', sa.String(length=20), nullable=False),
        sa.Column('path', sa.String(length=500), nullable=False),
        sa.Column('mime', sa.String(length=120), nullable=False),
        sa.Column('bytes', sa.Integer(), nullable=False),
        sa.Column('kp_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversation.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['message_id'], ['message.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_artifact_conversation_id'), 'artifact', ['conversation_id'], unique=False)
    op.create_index(op.f('ix_artifact_message_id'), 'artifact', ['message_id'], unique=False)
    op.create_index(op.f('ix_artifact_created_at'), 'artifact', ['created_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_artifact_created_at'), table_name='artifact')
    op.drop_index(op.f('ix_artifact_message_id'), table_name='artifact')
    op.drop_index(op.f('ix_artifact_conversation_id'), table_name='artifact')
    op.drop_table('artifact')
    op.drop_column('message', 'skill')
