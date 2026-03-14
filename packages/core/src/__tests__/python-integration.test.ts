// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'path';
import Database from 'better-sqlite3';
import { parsePythonImports } from '../python/import-parser.ts';
import { parsePythonRoutes } from '../python/route-parser.ts';
import { parsePythonModels } from '../python/model-parser.ts';
import { parseAlembicMigration } from '../python/migration-parser.ts';
import { readFileSync } from 'fs';

const FIXTURES_DIR = resolve(__dirname, 'fixtures/sample-fastapi');

describe('python-integration', () => {
  describe('import parsing', () => {
    it('parses imports from app/main.py', () => {
      const source = readFileSync(resolve(FIXTURES_DIR, 'app/main.py'), 'utf-8');
      const imports = parsePythonImports(source);
      expect(imports.length).toBeGreaterThanOrEqual(2);
      // Should find FastAPI, Depends, router, get_db imports
      const modules = imports.map(i => i.module);
      expect(modules).toContain('fastapi');
    });

    it('parses imports from app/api/routes.py', () => {
      const source = readFileSync(resolve(FIXTURES_DIR, 'app/api/routes.py'), 'utf-8');
      const imports = parsePythonImports(source);
      expect(imports.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('route detection', () => {
    it('detects routes from app/main.py', () => {
      const source = readFileSync(resolve(FIXTURES_DIR, 'app/main.py'), 'utf-8');
      const routes = parsePythonRoutes(source);
      expect(routes.length).toBeGreaterThanOrEqual(1);
      expect(routes[0].path).toBe('/health');
    });

    it('detects routes from app/api/routes.py', () => {
      const source = readFileSync(resolve(FIXTURES_DIR, 'app/api/routes.py'), 'utf-8');
      const routes = parsePythonRoutes(source);
      expect(routes.length).toBeGreaterThanOrEqual(3);

      const methods = routes.map(r => r.method);
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
      expect(methods).toContain('DELETE');

      // Check auth detection
      const createUser = routes.find(r => r.functionName === 'create_user');
      expect(createUser?.isAuthenticated).toBe(true);
    });
  });

  describe('model detection', () => {
    it('detects SQLAlchemy models from app/models.py', () => {
      const source = readFileSync(resolve(FIXTURES_DIR, 'app/models.py'), 'utf-8');
      const models = parsePythonModels(source);
      // Should find User and Post (not Base)
      const classNames = models.map(m => m.className);
      expect(classNames).toContain('User');
      expect(classNames).toContain('Post');

      // Check User model details
      const user = models.find(m => m.className === 'User');
      expect(user?.tableName).toBe('users');
      expect(user?.relationships.length).toBeGreaterThanOrEqual(1);
      expect(user?.relationships[0].target).toBe('Post');

      // Check Post model foreign keys
      const post = models.find(m => m.className === 'Post');
      expect(post?.foreignKeys.length).toBeGreaterThanOrEqual(1);
      expect(post?.foreignKeys[0].target).toBe('users.id');
    });
  });

  describe('migration parsing', () => {
    it('parses Alembic migration', () => {
      const source = readFileSync(resolve(FIXTURES_DIR, 'migrations/versions/001_initial.py'), 'utf-8');
      const migration = parseAlembicMigration(source);

      expect(migration.revision).toBe('001abc');
      expect(migration.downRevision).toBeNull();
      expect(migration.operations.length).toBeGreaterThanOrEqual(1);

      const createUsers = migration.operations.find(o => o.type === 'create_table' && o.table === 'users');
      expect(createUsers).toBeDefined();
    });
  });
});
