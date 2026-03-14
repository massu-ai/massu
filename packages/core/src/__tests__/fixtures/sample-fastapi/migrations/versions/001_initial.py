"""Initial migration - create users and posts tables

Revision ID: 001abc
Revises:
Create Date: 2026-01-01
"""
revision = '001abc'
down_revision = None

from alembic import op
import sqlalchemy as sa

def upgrade():
    op.create_table('users',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('email', sa.String(255)),
    )
    op.create_table('posts',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('title', sa.String(200), nullable=False),
        sa.Column('author_id', sa.Integer(), sa.ForeignKey('users.id')),
    )

def downgrade():
    op.drop_table('posts')
    op.drop_table('users')
