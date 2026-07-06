// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { resetConfig } from '../config.ts';
import {
  parsePrismaSchema,
  findColumnUsageInRouters,
  detectMismatches,
} from '../schema-mapper.ts';

const TEST_DIR = resolve(__dirname, '../test-schema-mapper-tmp');

function write(path: string, content: string) {
  const dir = resolve(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

const SCHEMA = `
generator client {
  provider = "prisma-client-js"
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  age       Int
  isActive  Boolean
  createdAt DateTime @default(now())
  tags      String[]
  posts     Post[]
  profile   Profile? @relation(fields: [profileId], references: [id])
  profileId String?

  @@map("users")
}

model Post {
  id     String @id
  title  String
  author User   @relation(fields: [authorId], references: [id])
  authorId String
}
`;

describe('schema-mapper (module functions)', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    write(resolve(TEST_DIR, 'massu.config.yaml'), 'project:\n  name: app\npaths:\n  source: src\n');
    process.chdir(TEST_DIR);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    resetConfig();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('parsePrismaSchema', () => {
    it('throws when the schema file is missing', () => {
      expect(() => parsePrismaSchema()).toThrow(/Prisma schema not found/);
    });

    it('parses models, fields, nullability, relations and @@map table names', () => {
      write(resolve(TEST_DIR, 'prisma/schema.prisma'), SCHEMA);
      const models = parsePrismaSchema();

      const user = models.find(m => m.name === 'User')!;
      expect(user).toBeDefined();
      // @@map override
      expect(user.tableName).toBe('users');

      const byName = Object.fromEntries(user.fields.map(f => [f.name, f]));
      // scalar non-nullable
      expect(byName.email.nullable).toBe(false);
      expect(byName.email.isRelation).toBe(false);
      // nullable scalar
      expect(byName.name.nullable).toBe(true);
      expect(byName.name.type).toContain('?');
      // scalar Int / Boolean recognized as non-relation
      expect(byName.age.isRelation).toBe(false);
      expect(byName.isActive.isRelation).toBe(false);
      // array field type carries []
      expect(byName.tags.type).toContain('[]');
      // relation (model-typed) field flagged as relation
      expect(byName.posts.isRelation).toBe(true);
      // explicit @relation annotation flagged
      expect(byName.profile.isRelation).toBe(true);

      // Post has no @@map -> snake_case derivation from model name
      const post = models.find(m => m.name === 'Post')!;
      expect(post.tableName).toBe('post');
      expect(post.fields.find(f => f.name === 'author')!.isRelation).toBe(true);
    });

    it('skips comment and block-attribute lines', () => {
      write(
        resolve(TEST_DIR, 'prisma/schema.prisma'),
        'model Thing {\n  // a comment\n  id String @id\n  @@index([id])\n  name String\n}\n'
      );
      const models = parsePrismaSchema();
      const thing = models.find(m => m.name === 'Thing')!;
      const names = thing.fields.map(f => f.name);
      expect(names).toContain('id');
      expect(names).toContain('name');
      // comment / @@index lines must not become fields
      expect(names).not.toContain('a');
    });
  });

  describe('findColumnUsageInRouters', () => {
    it('returns an empty map when the routers dir does not exist', () => {
      write(resolve(TEST_DIR, 'prisma/schema.prisma'), SCHEMA);
      const usage = findColumnUsageInRouters('users');
      expect(usage.size).toBe(0);
    });

    it('collects column usages from router files that reference the table', () => {
      write(
        resolve(TEST_DIR, 'src/server/api/routers/user.ts'),
        [
          "import { router } from '../trpc';",
          'export const userRouter = router({',
          '  list: protectedProcedure.query(async ({ ctx }) => {',
          '    return ctx.db.users.findMany({ where: { email: input.email, isActive: true } });',
          '  }),',
          '});',
        ].join('\n')
      );
      // nested router file to exercise the recursive directory scan
      write(
        resolve(TEST_DIR, 'src/server/api/routers/admin/audit.ts'),
        'export const x = ctx.db.users.findFirst({ where: { name: input.name } });'
      );
      // unrelated file with no table reference -> short-circuit return
      write(
        resolve(TEST_DIR, 'src/server/api/routers/unrelated.ts'),
        'export const noop = () => 1;'
      );
      const usage = findColumnUsageInRouters('users');
      expect(usage.size).toBeGreaterThan(0);
      expect(usage.has('email')).toBe(true);
      expect(usage.has('name')).toBe(true);
      // reserved keywords must be filtered out
      expect(usage.has('where')).toBe(false);
      expect(usage.has('return')).toBe(false);
      const emailHits = usage.get('email')!;
      expect(emailHits[0]).toHaveProperty('file');
      expect(emailHits[0]).toHaveProperty('line');
      expect(emailHits[0].line).toBeGreaterThan(0);
    });
  });

  describe('detectMismatches', () => {
    it('returns no mismatches when knownMismatches config is empty', () => {
      write(resolve(TEST_DIR, 'prisma/schema.prisma'), SCHEMA);
      const models = parsePrismaSchema();
      expect(detectMismatches(models)).toEqual([]);
    });

    it('flags a CRITICAL mismatch when a wrong column appears alongside the table', () => {
      write(
        resolve(TEST_DIR, 'massu.config.yaml'),
        [
          'project:',
          '  name: app',
          'paths:',
          '  source: src',
          'knownMismatches:',
          '  users:',
          '    user_email: email',
        ].join('\n') + '\n'
      );
      resetConfig();
      write(resolve(TEST_DIR, 'prisma/schema.prisma'), SCHEMA);
      // router file that references both the table and the wrong column
      write(
        resolve(TEST_DIR, 'src/server/api/routers/user.ts'),
        'export const r = ctx.db.users.findMany({ select: { user_email: true } });'
      );
      const models = parsePrismaSchema();
      const mismatches = detectMismatches(models);
      expect(mismatches.length).toBe(1);
      expect(mismatches[0].table).toBe('users');
      expect(mismatches[0].codeColumn).toBe('user_email');
      expect(mismatches[0].severity).toBe('CRITICAL');
      expect(mismatches[0].actualColumns).toContain('email');
      expect(mismatches[0].files.length).toBeGreaterThan(0);
    });

    it('skips a knownMismatch table that is absent from the schema', () => {
      write(
        resolve(TEST_DIR, 'massu.config.yaml'),
        [
          'project:',
          '  name: app',
          'paths:',
          '  source: src',
          'knownMismatches:',
          '  nonexistent_table:',
          '    foo: bar',
        ].join('\n') + '\n'
      );
      resetConfig();
      write(resolve(TEST_DIR, 'prisma/schema.prisma'), SCHEMA);
      const models = parsePrismaSchema();
      expect(detectMismatches(models)).toEqual([]);
    });

    it('reports no mismatch when the wrong column never appears in code', () => {
      write(
        resolve(TEST_DIR, 'massu.config.yaml'),
        [
          'project:',
          '  name: app',
          'paths:',
          '  source: src',
          'knownMismatches:',
          '  users:',
          '    user_email: email',
        ].join('\n') + '\n'
      );
      resetConfig();
      write(resolve(TEST_DIR, 'prisma/schema.prisma'), SCHEMA);
      // routers dir exists but no file uses the wrong column
      write(
        resolve(TEST_DIR, 'src/server/api/routers/user.ts'),
        'export const r = ctx.db.users.findMany();'
      );
      const models = parsePrismaSchema();
      expect(detectMismatches(models)).toEqual([]);
    });
  });
});
