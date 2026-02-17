// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { parsePrismaSchema } from '../schema-mapper.ts';
import { getResolvedPaths } from '../config.ts';

const schemaExists = existsSync(getResolvedPaths().prismaSchemaPath);

describe('parsePrismaSchema', () => {
  it('parses the Prisma schema file', () => {
    if (!schemaExists) {
      // No schema in this project - verify it throws gracefully
      expect(() => parsePrismaSchema()).toThrow('Prisma schema not found');
      return;
    }
    const models = parsePrismaSchema();
    expect(models.length).toBeGreaterThan(0);
  });

  it('finds models with fields', () => {
    if (!schemaExists) return;
    const models = parsePrismaSchema();
    for (const model of models) {
      expect(model.fields.length).toBeGreaterThan(0);
    }
  });
});
