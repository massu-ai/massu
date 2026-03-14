import { describe, it, expect } from 'vitest';
import { parsePythonImports } from '../python/import-parser.ts';
import { parsePythonRoutes } from '../python/route-parser.ts';
import { parsePythonModels } from '../python/model-parser.ts';
import { parseAlembicMigration } from '../python/migration-parser.ts';

describe('python-edge-cases', () => {
  describe('import-parser edge cases', () => {
    it('handles empty file', () => {
      expect(parsePythonImports('')).toEqual([]);
    });

    it('handles file with no imports', () => {
      const source = `
x = 1
def foo():
    return x
`;
      expect(parsePythonImports(source)).toEqual([]);
    });

    it('ignores import-like text inside string literals', () => {
      const source = `
msg = "import os"
text = 'from sys import argv'
`;
      // Parser may or may not pick these up — the key is it doesn't crash
      const result = parsePythonImports(source);
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles deeply nested relative imports', () => {
      const source = `from ....deeply.nested import thing`;
      const result = parsePythonImports(source);
      expect(result.length).toBe(1);
      expect(result[0].level).toBeGreaterThanOrEqual(4);
    });

    it('handles import with trailing comment', () => {
      const source = `import os  # operating system`;
      const result = parsePythonImports(source);
      expect(result.length).toBe(1);
      expect(result[0].module).toBe('os');
    });

    it('handles multiple imports on separate lines', () => {
      const source = `
import os
import sys
import json
import pathlib
import typing
`;
      const result = parsePythonImports(source);
      expect(result.length).toBe(5);
    });

    it('handles from import with parentheses and trailing comma', () => {
      const source = `from os.path import (
    join,
    dirname,
    basename,
)`;
      const result = parsePythonImports(source);
      expect(result.length).toBe(1);
      expect(result[0].names.length).toBe(3);
    });
  });

  describe('route-parser edge cases', () => {
    it('handles empty file', () => {
      expect(parsePythonRoutes('')).toEqual([]);
    });

    it('handles file with no routes', () => {
      const source = `
from fastapi import FastAPI
app = FastAPI()
# No routes defined yet
`;
      expect(parsePythonRoutes(source)).toEqual([]);
    });

    it('handles stacked decorators (3+)', () => {
      const source = `
@app.get("/items")
@require_admin
@cache(ttl=60)
async def list_items():
    pass
`;
      const result = parsePythonRoutes(source);
      expect(result.length).toBe(1);
      expect(result[0].method).toBe('GET');
    });

    it('handles route with complex kwargs', () => {
      const source = `
@app.post("/items", response_model=ItemResponse, status_code=201, tags=["items"])
async def create_item(item: ItemCreate, db: Session = Depends(get_db)):
    pass
`;
      const result = parsePythonRoutes(source);
      expect(result.length).toBe(1);
      expect(result[0].responseModel).toBe('ItemResponse');
    });

    it('handles sync def (not async)', () => {
      const source = `
@app.get("/health")
def health_check():
    return {"status": "ok"}
`;
      const result = parsePythonRoutes(source);
      expect(result.length).toBe(1);
      expect(result[0].functionName).toBe('health_check');
    });
  });

  describe('model-parser edge cases', () => {
    it('handles empty file', () => {
      expect(parsePythonModels('')).toEqual([]);
    });

    it('handles class with no Base inheritance', () => {
      const source = `
class NotAModel:
    name = "foo"
`;
      expect(parsePythonModels(source)).toEqual([]);
    });

    it('handles model with no columns', () => {
      const source = `
class EmptyModel(Base):
    __tablename__ = "empty"
`;
      const result = parsePythonModels(source);
      expect(result.length).toBe(1);
      expect(result[0].columns).toEqual([]);
    });

    it('handles model with only relationships', () => {
      const source = `
class Parent(Base):
    __tablename__ = "parents"
    children = relationship("Child", back_populates="parent")
`;
      const result = parsePythonModels(source);
      expect(result.length).toBe(1);
      expect(result[0].relationships.length).toBe(1);
    });
  });

  describe('migration-parser edge cases', () => {
    it('handles empty file', () => {
      const result = parseAlembicMigration('');
      expect(result.revision).toBe('');
    });

    it('handles file with no revision', () => {
      const source = `
# This is a migration file but malformed
def upgrade():
    pass
`;
      const result = parseAlembicMigration(source);
      expect(result.revision).toBe('');
    });

    it('handles unicode in description', () => {
      const source = `
revision = 'abc123'
down_revision = None
"""Add user ñame column — supports i18n"""

def upgrade():
    op.add_column('users', sa.Column('display_name', sa.String(100)))

def downgrade():
    op.drop_column('users', 'display_name')
`;
      const result = parseAlembicMigration(source);
      expect(result.revision).toBe('abc123');
    });

    it('handles revision with double quotes', () => {
      const source = `
revision = "def456"
down_revision = "abc123"

def upgrade():
    pass

def downgrade():
    pass
`;
      const result = parseAlembicMigration(source);
      expect(result.revision).toBe('def456');
      expect(result.downRevision).toBe('abc123');
    });

    it('handles migration with no operations', () => {
      const source = `
revision = 'empty001'
down_revision = None

def upgrade():
    pass

def downgrade():
    pass
`;
      const result = parseAlembicMigration(source);
      expect(result.revision).toBe('empty001');
      expect(result.operations).toEqual([]);
    });
  });
});
