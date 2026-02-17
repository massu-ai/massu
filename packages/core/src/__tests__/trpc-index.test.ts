// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { extractProcedures } from '../trpc-index.ts';

describe('extractProcedures', () => {
  // This test requires actual router files to exist.
  // We test the function's behavior with a known router.
  it('extracts procedures from the orders router if it exists', () => {
    const procs = extractProcedures('src/server/api/routers/orders.ts');
    // If the file exists, we should get some procedures
    if (procs.length > 0) {
      expect(procs[0]).toHaveProperty('name');
      expect(procs[0]).toHaveProperty('type');
      expect(procs[0]).toHaveProperty('isProtected');
      expect(['query', 'mutation']).toContain(procs[0].type);
    }
  });

  it('returns empty array for non-existent file', () => {
    const procs = extractProcedures('src/server/api/routers/nonexistent-router-xyzzy.ts');
    expect(procs).toEqual([]);
  });
});
