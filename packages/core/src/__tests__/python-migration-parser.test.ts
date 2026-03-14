// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { parseAlembicMigration } from '../python/migration-parser.ts';

describe('python-migration-parser', () => {
  it('parses revision and down_revision', () => {
    const source = `revision = 'abc123'
down_revision = 'xyz789'

def upgrade():
    pass

def downgrade():
    pass`;
    const result = parseAlembicMigration(source);
    expect(result.revision).toBe('abc123');
    expect(result.downRevision).toBe('xyz789');
  });

  it('handles base migration (down_revision = None)', () => {
    const source = `revision = 'initial'
down_revision = None

def upgrade():
    pass`;
    const result = parseAlembicMigration(source);
    expect(result.revision).toBe('initial');
    expect(result.downRevision).toBeNull();
  });

  it('parses create_table operation', () => {
    const source = `revision = 'abc'
down_revision = None

def upgrade():
    op.create_table('users',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(100)),
    )`;
    const result = parseAlembicMigration(source);
    expect(result.operations.length).toBeGreaterThanOrEqual(1);
    const createOp = result.operations.find(o => o.type === 'create_table');
    expect(createOp).toBeDefined();
    expect(createOp?.table).toBe('users');
  });

  it('parses add_column operation', () => {
    const source = `revision = 'def'
down_revision = 'abc'

def upgrade():
    op.add_column('users', sa.Column('email', sa.String()))`;
    const result = parseAlembicMigration(source);
    const addOp = result.operations.find(o => o.type === 'add_column');
    expect(addOp).toBeDefined();
    expect(addOp?.table).toBe('users');
  });

  it('parses drop_column operation', () => {
    const source = `revision = 'ghi'
down_revision = 'def'

def upgrade():
    op.drop_column('users', 'email')`;
    const result = parseAlembicMigration(source);
    const dropOp = result.operations.find(o => o.type === 'drop_column');
    expect(dropOp).toBeDefined();
  });

  it('handles empty upgrade function', () => {
    const source = `revision = 'empty'
down_revision = 'base'

def upgrade():
    pass`;
    const result = parseAlembicMigration(source);
    expect(result.revision).toBe('empty');
    expect(result.operations).toHaveLength(0);
  });

  it('extracts description from docstring', () => {
    const source = `"""Add users table

Revision ID: abc
"""
revision = 'abc'
down_revision = None

def upgrade():
    pass`;
    const result = parseAlembicMigration(source);
    expect(result.revision).toBe('abc');
    // Description extraction is best-effort
  });
});
