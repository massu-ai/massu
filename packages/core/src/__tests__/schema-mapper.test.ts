// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { parsePrismaSchema } from '../schema-mapper.ts';
import { getResolvedPaths } from '../config.ts';

const schemaExists = existsSync(getResolvedPaths().prismaSchemaPath);

describe('parsePrismaSchema', () => {
  // G-1 (plan-2026-07-26-anti-vacuity-9-unproven-gates): BOTH branches assert, so this is a genuine two-branch test, not a skip.
  // The early `return` was indistinguishable from a silent skip; if/else says so.
  it('parses the Prisma schema file', () => {
    if (!schemaExists) {
      // No schema in this project - verify it throws gracefully
      expect(() => parsePrismaSchema()).toThrow('Prisma schema not found');
    } else {
      const models = parsePrismaSchema();
      expect(models.length).toBeGreaterThan(0);
    }
  });

  // ADJUDICATED environment-conditional: no Prisma schema in this project -> SKIPPED.
  it.skipIf(!schemaExists)('finds models with fields', () => {
    const models = parsePrismaSchema();
    for (const model of models) {
      expect(model.fields.length).toBeGreaterThan(0);
    }
  });
});
