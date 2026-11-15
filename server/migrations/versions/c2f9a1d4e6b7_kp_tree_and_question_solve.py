"""kp tree + question solve fields

知识点树（kp / kp_edge）、题目↔知识点（question_kp），
以及题目上的解析状态与年级 / 难度。

Revision ID: c2f9a1d4e6b7
Revises: 70e71bacbbcf
Create Date: 2026-11-15 19:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c2f9a1d4e6b7'
down_revision: Union[str, Sequence[str], None] = '70e71bacbbcf'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'kp',
        sa.Column('id', sa.String(length=40), nullable=False),
        sa.Column('subject', sa.String(length=20), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('name_norm', sa.String(length=200), nullable=False),
        sa.Column('kind', sa.String(length=12), nullable=False),
        sa.Column('parent_id', sa.String(length=40), nullable=True),
        sa.Column('grade', sa.String(length=10), nullable=False),
        sa.Column('module', sa.String(length=80), nullable=False),
        sa.Column('chapter', sa.String(length=200), nullable=False),
        sa.Column('summary_md', sa.Text(), nullable=False),
        sa.Column('aliases', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column('difficulty', sa.Float(), nullable=False, server_default='0'),
        sa.Column('kp_type', sa.String(length=20), nullable=False),
        sa.Column('source', sa.String(length=20), nullable=False),
        sa.Column('source_id', sa.String(length=64), nullable=False),
        sa.Column('q_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sort', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['parent_id'], ['kp.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_kp_parent_id'), 'kp', ['parent_id'], unique=False)
    op.create_index(op.f('ix_kp_name_norm'), 'kp', ['name_norm'], unique=False)
    op.create_index(op.f('ix_kp_subject'), 'kp', ['subject'], unique=False)

    op.create_table(
        'kp_edge',
        sa.Column('id', sa.String(length=40), nullable=False),
        sa.Column('from_kp_id', sa.String(length=40), nullable=False),
        sa.Column('to_kp_id', sa.String(length=40), nullable=False),
        sa.Column('type', sa.String(length=16), nullable=False),
        sa.Column('subject', sa.String(length=20), nullable=False),
        sa.Column('source', sa.String(length=20), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['from_kp_id'], ['kp.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['to_kp_id'], ['kp.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('from_kp_id', 'to_kp_id', 'type', name='uq_kp_edge_triple'),
    )
    op.create_index(op.f('ix_kp_edge_from_kp_id'), 'kp_edge', ['from_kp_id'], unique=False)
    op.create_index(op.f('ix_kp_edge_to_kp_id'), 'kp_edge', ['to_kp_id'], unique=False)

    # 硬规则（AGENTS §3.3）：kp_edge 只能同学科内。用触发器强制，别只在代码里相信调用方。
    op.execute(
        """
        CREATE OR REPLACE FUNCTION kp_edge_same_subject() RETURNS trigger AS $$
        DECLARE s_from text; s_to text;
        BEGIN
          SELECT subject INTO s_from FROM kp WHERE id = NEW.from_kp_id;
          SELECT subject INTO s_to   FROM kp WHERE id = NEW.to_kp_id;
          IF s_from IS NULL OR s_to IS NULL THEN
            RAISE EXCEPTION 'kp_edge: from/to 知识点不存在';
          END IF;
          IF s_from <> s_to THEN
            RAISE EXCEPTION 'kp_edge 只能同学科内（% -> %）', s_from, s_to;
          END IF;
          NEW.subject := s_from;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_kp_edge_same_subject
        BEFORE INSERT OR UPDATE ON kp_edge
        FOR EACH ROW EXECUTE FUNCTION kp_edge_same_subject();
        """
    )

    op.create_table(
        'question_kp',
        sa.Column('question_id', sa.String(length=32), nullable=False),
        sa.Column('kp_id', sa.String(length=40), nullable=False),
        sa.Column('weight', sa.Float(), nullable=False, server_default='0.5'),
        sa.Column('is_primary', sa.Boolean(), nullable=False, server_default=sa.text('false')),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['question_id'], ['question.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['kp_id'], ['kp.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('question_id', 'kp_id'),
    )

    # 题目上的解析状态 + 年级 / 难度
    op.add_column('question', sa.Column('grade', sa.String(length=10), nullable=False, server_default=''))
    op.add_column('question', sa.Column('difficulty', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('question', sa.Column('solve_status', sa.String(length=12), nullable=False, server_default=''))
    op.add_column('question', sa.Column('solve_error', sa.Text(), nullable=False, server_default=''))
    op.add_column('question', sa.Column('solved_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        'question',
        sa.Column('ai_meta', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.create_index(op.f('ix_question_solve_status'), 'question', ['solve_status'], unique=False)
    op.create_index(op.f('ix_question_grade'), 'question', ['grade'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_question_grade'), table_name='question')
    op.drop_index(op.f('ix_question_solve_status'), table_name='question')
    op.drop_column('question', 'ai_meta')
    op.drop_column('question', 'solved_at')
    op.drop_column('question', 'solve_error')
    op.drop_column('question', 'solve_status')
    op.drop_column('question', 'difficulty')
    op.drop_column('question', 'grade')

    op.drop_table('question_kp')

    op.execute('DROP TRIGGER IF EXISTS trg_kp_edge_same_subject ON kp_edge;')
    op.execute('DROP FUNCTION IF EXISTS kp_edge_same_subject();')
    op.drop_index(op.f('ix_kp_edge_to_kp_id'), table_name='kp_edge')
    op.drop_index(op.f('ix_kp_edge_from_kp_id'), table_name='kp_edge')
    op.drop_table('kp_edge')

    op.drop_index(op.f('ix_kp_subject'), table_name='kp')
    op.drop_index(op.f('ix_kp_name_norm'), table_name='kp')
    op.drop_index(op.f('ix_kp_parent_id'), table_name='kp')
    op.drop_table('kp')
