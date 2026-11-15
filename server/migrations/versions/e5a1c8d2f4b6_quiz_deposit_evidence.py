"""quiz + deposit + kp evidence（自动沉淀 / 出题检测 / 主动消息）

Revision ID: e5a1c8d2f4b6
Revises: c2f9a1d4e6b7
Create Date: 2026-11-15 22:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'e5a1c8d2f4b6'
down_revision: Union[str, Sequence[str], None] = 'c2f9a1d4e6b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'quiz',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('conversation_id', sa.String(length=32), nullable=False),
        sa.Column('message_id', sa.String(length=32), nullable=True),
        sa.Column('question_id', sa.String(length=32), nullable=True),
        sa.Column('subject', sa.String(length=20), nullable=False),
        sa.Column('stem_md', sa.Text(), nullable=False),
        sa.Column('options', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('answer', sa.Text(), nullable=False),
        sa.Column('explanation', sa.Text(), nullable=False),
        sa.Column('kp_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('kp_names', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('status', sa.String(length=12), nullable=False),
        sa.Column('chosen', sa.String(length=200), nullable=False),
        sa.Column('correct', sa.Boolean(), nullable=True),
        sa.Column('source', sa.String(length=12), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('answered_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversation.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['message_id'], ['message.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['question_id'], ['question.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_quiz_conversation_id'), 'quiz', ['conversation_id'], unique=False)
    op.create_index(op.f('ix_quiz_message_id'), 'quiz', ['message_id'], unique=False)
    op.create_index(op.f('ix_quiz_question_id'), 'quiz', ['question_id'], unique=False)
    op.create_index(op.f('ix_quiz_created_at'), 'quiz', ['created_at'], unique=False)

    op.create_table(
        'deposit',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('conversation_id', sa.String(length=32), nullable=False),
        sa.Column('message_id', sa.String(length=32), nullable=False),
        sa.Column('kind', sa.String(length=12), nullable=False),
        sa.Column('status', sa.String(length=12), nullable=False),
        sa.Column('question_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('kp_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversation.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['message_id'], ['message.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_deposit_conversation_id'), 'deposit', ['conversation_id'], unique=False)
    op.create_index(op.f('ix_deposit_message_id'), 'deposit', ['message_id'], unique=False)
    op.create_index(op.f('ix_deposit_created_at'), 'deposit', ['created_at'], unique=False)

    op.create_table(
        'kp_evidence',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('kp_id', sa.String(length=40), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('weight', sa.Float(), nullable=False),
        sa.Column('source', sa.String(length=40), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['kp_id'], ['kp.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_kp_evidence_kp_id'), 'kp_evidence', ['kp_id'], unique=False)
    op.create_index(op.f('ix_kp_evidence_created_at'), 'kp_evidence', ['created_at'], unique=False)

    op.add_column('message', sa.Column('deposits', postgresql.JSONB(astext_type=sa.Text()), nullable=False,
                                       server_default=sa.text("'[]'::jsonb")))
    op.add_column('question', sa.Column('status', sa.String(length=12), nullable=False, server_default='learning'))
    op.add_column('question', sa.Column('error_type', sa.String(length=16), nullable=False, server_default=''))
    op.add_column('question', sa.Column('next_due_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('question', sa.Column('asked_count', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('question', sa.Column('last_asked_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('question', sa.Column('streak', sa.Integer(), nullable=False, server_default='0'))
    op.create_index(op.f('ix_question_status'), 'question', ['status'], unique=False)
    op.create_index(op.f('ix_question_next_due_at'), 'question', ['next_due_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_question_next_due_at'), table_name='question')
    op.drop_index(op.f('ix_question_status'), table_name='question')
    op.drop_column('question', 'streak')
    op.drop_column('question', 'last_asked_at')
    op.drop_column('question', 'asked_count')
    op.drop_column('question', 'next_due_at')
    op.drop_column('question', 'error_type')
    op.drop_column('question', 'status')
    op.drop_column('message', 'deposits')

    op.drop_index(op.f('ix_kp_evidence_created_at'), table_name='kp_evidence')
    op.drop_index(op.f('ix_kp_evidence_kp_id'), table_name='kp_evidence')
    op.drop_table('kp_evidence')

    op.drop_index(op.f('ix_deposit_created_at'), table_name='deposit')
    op.drop_index(op.f('ix_deposit_message_id'), table_name='deposit')
    op.drop_index(op.f('ix_deposit_conversation_id'), table_name='deposit')
    op.drop_table('deposit')

    op.drop_index(op.f('ix_quiz_created_at'), table_name='quiz')
    op.drop_index(op.f('ix_quiz_question_id'), table_name='quiz')
    op.drop_index(op.f('ix_quiz_message_id'), table_name='quiz')
    op.drop_index(op.f('ix_quiz_conversation_id'), table_name='quiz')
    op.drop_table('quiz')
