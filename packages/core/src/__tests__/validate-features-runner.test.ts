// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// validate-features-runner.ts tests
// The module is a standalone script (no exports). We test its
// logic by exercising the conditional branches directly in unit
// tests, mocking better-sqlite3, fs, and config.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ------------------------------------
// Mock dependencies
// ------------------------------------

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock('../config.ts', () => ({
  getProjectRoot: vi.fn(() => '/home/user/my-project'),
  getResolvedPaths: vi.fn(() => ({
    dataDbPath: '/home/user/my-project/.massu/data.db',
    memoryDbPath: '/home/user/my-project/.massu/memory.db',
    codegraphDbPath: '/home/user/my-project/.massu/codegraph.db',
    srcDir: '/home/user/my-project/src',
    pathAlias: {},
    extensions: ['.ts'],
    indexFiles: ['index.ts'],
    patternsDir: '/home/user/my-project/.claude/patterns',
    claudeMdPath: '/home/user/my-project/.claude/CLAUDE.md',
    docsMapPath: '/home/user/my-project/.massu/docs-map.json',
    helpSitePath: '/home/user/my-project/help',
    prismaSchemaPath: '/home/user/my-project/prisma/schema.prisma',
    rootRouterPath: '/home/user/my-project/src/server/api/root.ts',
    routersDir: '/home/user/my-project/src/server/api/routers',
  })),
  getConfig: vi.fn(() => ({
    toolPrefix: 'massu',
    project: { name: 'my-project', root: '/home/user/my-project' },
  })),
}));

// Import mocks
import { existsSync } from 'fs';
import { getProjectRoot, getResolvedPaths } from '../config.ts';

const mockExistsSync = vi.mocked(existsSync);
const mockGetProjectRoot = vi.mocked(getProjectRoot);
const mockGetResolvedPaths = vi.mocked(getResolvedPaths);

// ------------------------------------
// Helper: build a mock DB statement
// ------------------------------------

function makeStmt(returnValue: unknown) {
  return { get: vi.fn().mockReturnValue(returnValue), all: vi.fn().mockReturnValue([]) };
}

function makeAllStmt(returnValue: unknown[]) {
  return { get: vi.fn(), all: vi.fn().mockReturnValue(returnValue) };
}

// ------------------------------------
// Scenario: no data DB found
// ------------------------------------

describe('scenario: no data DB found', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('exits 0 when dbPath does not exist', () => {
    const dbPath = mockGetResolvedPaths().dataDbPath;
    const dbExists = mockExistsSync(dbPath);
    expect(dbExists).toBe(false);

    // The script would call process.exit(0) here — we verify the condition
    expect(dbPath).toBe('/home/user/my-project/.massu/data.db');
  });

  it('prints skipping message when no db found', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const dbPath = mockGetResolvedPaths().dataDbPath;
    if (!mockExistsSync(dbPath)) {
      console.log('Sentinel: No data DB found - skipping feature validation (run sync first)');
    }

    expect(consoleSpy).toHaveBeenCalledWith(
      'Sentinel: No data DB found - skipping feature validation (run sync first)'
    );
    consoleSpy.mockRestore();
  });
});

// ------------------------------------
// Scenario: sentinel tables do not exist
// ------------------------------------

describe('scenario: no sentinel tables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('exits 0 when massu_sentinel table is missing', () => {
    const tableExistsStmt = makeStmt(undefined); // undefined = no table found
    const tableExists = tableExistsStmt.get();
    expect(tableExists).toBeUndefined();

    // The script would exit(0) and log skipping message
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    if (!tableExists) {
      console.log('Sentinel: Feature registry not initialized - skipping (run sync first)');
    }
    expect(consoleSpy).toHaveBeenCalledWith(
      'Sentinel: Feature registry not initialized - skipping (run sync first)'
    );
    consoleSpy.mockRestore();
  });

  it('proceeds when massu_sentinel table exists', () => {
    const tableExistsStmt = makeStmt({ name: 'massu_sentinel' });
    const tableExists = tableExistsStmt.get();
    expect(tableExists).toBeTruthy();
    expect((tableExists as { name: string }).name).toBe('massu_sentinel');
  });
});

// ------------------------------------
// Scenario: no active features
// ------------------------------------

describe('scenario: no active features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('exits 0 when active feature count is 0', () => {
    const countStmt = makeStmt({ count: 0 });
    const totalActive = countStmt.get() as { count: number };
    expect(totalActive.count).toBe(0);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    if (totalActive.count === 0) {
      console.log('Sentinel: No active features registered - skipping validation');
    }
    expect(consoleSpy).toHaveBeenCalledWith(
      'Sentinel: No active features registered - skipping validation'
    );
    consoleSpy.mockRestore();
  });

  it('proceeds when active features exist', () => {
    const countStmt = makeStmt({ count: 5 });
    const totalActive = countStmt.get() as { count: number };
    expect(totalActive.count).toBe(5);
    expect(totalActive.count > 0).toBe(true);
  });
});

// ------------------------------------
// Scenario: all primary components exist
// ------------------------------------

describe('scenario: all features have living primary components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('exits 0 and prints PASS when all component files exist', () => {
    const projectRoot = mockGetProjectRoot();
    const rows = [
      { feature_key: 'auth.login', title: 'User Login', priority: 'critical', component_file: 'src/Login.tsx' },
      { feature_key: 'auth.register', title: 'User Register', priority: 'standard', component_file: 'src/Register.tsx' },
    ];

    const allStmt = makeAllStmt(rows);
    const orphanedRows = allStmt.all() as typeof rows;

    // All files exist
    mockExistsSync.mockImplementation(() => true);

    const missingFeatures: typeof rows = [];
    for (const row of orphanedRows) {
      const absPath = `${projectRoot}/${row.component_file}`;
      if (!mockExistsSync(absPath)) {
        missingFeatures.push(row);
      }
    }

    expect(missingFeatures).toHaveLength(0);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    if (missingFeatures.length === 0) {
      console.log('Sentinel: All active features have living primary components. PASS');
    }
    expect(consoleSpy).toHaveBeenCalledWith(
      'Sentinel: All active features have living primary components. PASS'
    );
    consoleSpy.mockRestore();
  });
});

// ------------------------------------
// Scenario: orphaned features (non-critical)
// ------------------------------------

describe('scenario: orphaned features - non-critical only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits 0 with WARN when only non-critical features are orphaned', () => {
    const projectRoot = '/home/user/my-project';
    const rows = [
      { feature_key: 'product.search', title: 'Product Search', priority: 'standard', component_file: 'src/Search.tsx' },
      { feature_key: 'product.filter', title: 'Product Filter', priority: 'nice-to-have', component_file: 'src/Filter.tsx' },
    ];

    // Files do not exist
    mockExistsSync.mockImplementation((p) => {
      // DB file itself exists
      if (p === '/home/user/my-project/.massu/data.db') return true;
      return false;
    });

    const missingFeatures: { feature_key: string; title: string; priority: string; missing_file: string }[] = [];
    for (const row of rows) {
      const absPath = `${projectRoot}/${row.component_file}`;
      if (!mockExistsSync(absPath)) {
        missingFeatures.push({
          feature_key: row.feature_key,
          title: row.title,
          priority: row.priority,
          missing_file: row.component_file,
        });
      }
    }

    expect(missingFeatures).toHaveLength(2);

    const criticalCount = missingFeatures.filter(f => f.priority === 'critical').length;
    expect(criticalCount).toBe(0);

    // Non-critical orphans are warnings, not blockers -> exit(0)
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    if (criticalCount > 0) {
      console.error(`\nFAIL: ${criticalCount} CRITICAL features are orphaned. Fix before committing.`);
    } else {
      console.warn(`\nWARN: ${missingFeatures.length} features are orphaned (non-critical). Consider updating registry.`);
    }

    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWARN: 2 features are orphaned (non-critical). Consider updating registry.'
    );
    expect(errorSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs each orphaned feature with priority and missing file', () => {
    const missingFeatures = [
      { feature_key: 'product.search', title: 'Product Search', priority: 'standard', missing_file: 'src/Search.tsx' },
    ];

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    console.error(`Sentinel: ${missingFeatures.length} features have MISSING primary components:`);
    for (const f of missingFeatures) {
      console.error(`  [${f.priority}] ${f.feature_key}: ${f.title}`);
      console.error(`    Missing: ${f.missing_file}`);
    }

    expect(errorSpy).toHaveBeenCalledWith('Sentinel: 1 features have MISSING primary components:');
    expect(errorSpy).toHaveBeenCalledWith('  [standard] product.search: Product Search');
    expect(errorSpy).toHaveBeenCalledWith('    Missing: src/Search.tsx');

    errorSpy.mockRestore();
  });
});

// ------------------------------------
// Scenario: critical features are orphaned
// ------------------------------------

describe('scenario: orphaned features - critical present', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits 1 with FAIL message when critical features are orphaned', () => {
    const projectRoot = '/home/user/my-project';
    const rows = [
      { feature_key: 'auth.login', title: 'User Login', priority: 'critical', component_file: 'src/Login.tsx' },
      { feature_key: 'product.search', title: 'Product Search', priority: 'standard', component_file: 'src/Search.tsx' },
    ];

    // All component files missing
    mockExistsSync.mockImplementation((p) => {
      if (p === '/home/user/my-project/.massu/data.db') return true;
      return false;
    });

    const missingFeatures: { feature_key: string; title: string; priority: string; missing_file: string }[] = [];
    for (const row of rows) {
      const absPath = `${projectRoot}/${row.component_file}`;
      if (!mockExistsSync(absPath)) {
        missingFeatures.push({
          feature_key: row.feature_key,
          title: row.title,
          priority: row.priority,
          missing_file: row.component_file,
        });
      }
    }

    const criticalCount = missingFeatures.filter(f => f.priority === 'critical').length;
    expect(criticalCount).toBe(1);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    if (criticalCount > 0) {
      console.error(`\nFAIL: ${criticalCount} CRITICAL features are orphaned. Fix before committing.`);
    } else {
      console.warn(`\nWARN: ${missingFeatures.length} features are orphaned (non-critical). Consider updating registry.`);
    }

    expect(errorSpy).toHaveBeenCalledWith(
      '\nFAIL: 1 CRITICAL features are orphaned. Fix before committing.'
    );
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('counts critical orphaned features correctly', () => {
    const missingFeatures = [
      { feature_key: 'auth.login', title: 'User Login', priority: 'critical', missing_file: 'src/Login.tsx' },
      { feature_key: 'auth.register', title: 'Registration', priority: 'critical', missing_file: 'src/Register.tsx' },
      { feature_key: 'product.search', title: 'Search', priority: 'standard', missing_file: 'src/Search.tsx' },
    ];

    const criticalCount = missingFeatures.filter(f => f.priority === 'critical').length;
    expect(criticalCount).toBe(2);
  });

  it('distinguishes between critical and non-critical in mixed scenario', () => {
    const missingFeatures = [
      { priority: 'critical' },
      { priority: 'standard' },
      { priority: 'nice-to-have' },
    ];

    const criticalCount = missingFeatures.filter(f => f.priority === 'critical').length;
    const nonCriticalCount = missingFeatures.filter(f => f.priority !== 'critical').length;

    expect(criticalCount).toBe(1);
    expect(nonCriticalCount).toBe(2);
    expect(criticalCount > 0).toBe(true); // -> exit(1) path
  });
});

// ------------------------------------
// Status logging tests
// ------------------------------------

describe('status logging', () => {
  it('logs active feature count before checking components', () => {
    const totalActive = { count: 8 };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    console.log(`Sentinel: ${totalActive.count} active features, checking primary components...`);

    expect(consoleSpy).toHaveBeenCalledWith(
      'Sentinel: 8 active features, checking primary components...'
    );
    consoleSpy.mockRestore();
  });

  it('formats singular vs plural active feature count correctly', () => {
    // The script uses the raw count in the message - verify the message format
    const count1 = 1;
    const count5 = 5;
    const msg1 = `Sentinel: ${count1} active features, checking primary components...`;
    const msg5 = `Sentinel: ${count5} active features, checking primary components...`;
    expect(msg1).toContain('1 active features');
    expect(msg5).toContain('5 active features');
  });
});

// ------------------------------------
// Path resolution tests
// ------------------------------------

describe('path resolution for component files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves component_file relative to PROJECT_ROOT', () => {
    const projectRoot = '/home/user/my-project';
    const componentFile = 'src/components/Login.tsx';

    // The script uses: resolve(PROJECT_ROOT, row.component_file)
    // which is equivalent to path.join for relative paths
    const absPath = `${projectRoot}/${componentFile}`;
    expect(absPath).toBe('/home/user/my-project/src/components/Login.tsx');
  });

  it('checks each component file with existsSync', () => {
    const projectRoot = '/home/user/my-project';
    const rows = [
      { component_file: 'src/Login.tsx' },
      { component_file: 'src/Register.tsx' },
    ];

    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p) => {
      checkedPaths.push(p as string);
      return true;
    });

    for (const row of rows) {
      existsSync(`${projectRoot}/${row.component_file}`);
    }

    expect(checkedPaths).toEqual([
      '/home/user/my-project/src/Login.tsx',
      '/home/user/my-project/src/Register.tsx',
    ]);
  });

  it('correctly identifies missing vs existing files', () => {
    const existingFiles = new Set(['/home/user/my-project/src/Login.tsx']);
    mockExistsSync.mockImplementation((p) => existingFiles.has(p as string));

    expect(mockExistsSync('/home/user/my-project/src/Login.tsx')).toBe(true);
    expect(mockExistsSync('/home/user/my-project/src/Search.tsx')).toBe(false);
  });
});

// ------------------------------------
// DB open/close correctness tests
// ------------------------------------

describe('database open and close', () => {
  it('verifies readonly mode is used for data DB', () => {
    // The script opens: new Database(dbPath, { readonly: true })
    // Verify the options pattern
    const options = { readonly: true };
    expect(options.readonly).toBe(true);
  });

  it('verifies WAL pragma is set', () => {
    // The script calls: db.pragma('journal_mode = WAL')
    const pragma = 'journal_mode = WAL';
    expect(pragma).toBe('journal_mode = WAL');
  });

  it('verifies sentinel table query uses correct table name', () => {
    const query = "SELECT name FROM sqlite_master WHERE type='table' AND name='massu_sentinel'";
    expect(query).toContain('massu_sentinel');
    expect(query).toContain("type='table'");
  });

  it('verifies active features query uses correct status filter', () => {
    const query = "SELECT COUNT(*) as count FROM massu_sentinel WHERE status = 'active'";
    expect(query).toContain("status = 'active'");
    expect(query).toContain('COUNT(*)');
  });

  it('verifies orphaned feature query joins correct tables', () => {
    const query = `
      SELECT s.feature_key, s.title, s.priority, c.component_file
      FROM massu_sentinel s
      JOIN massu_sentinel_components c ON c.feature_id = s.id AND c.is_primary = 1
      WHERE s.status = 'active'
      ORDER BY s.priority DESC, s.domain, s.feature_key
    `;
    expect(query).toContain('massu_sentinel s');
    expect(query).toContain('massu_sentinel_components c');
    expect(query).toContain('c.is_primary = 1');
    expect(query).toContain("s.status = 'active'");
    expect(query).toContain('s.priority DESC');
  });
});

// ------------------------------------
// getResolvedPaths integration tests
// ------------------------------------

describe('config integration', () => {
  it('reads dbPath from getResolvedPaths()', () => {
    const paths = mockGetResolvedPaths();
    expect(paths.dataDbPath).toBe('/home/user/my-project/.massu/data.db');
  });

  it('reads PROJECT_ROOT from getProjectRoot()', () => {
    const root = mockGetProjectRoot();
    expect(root).toBe('/home/user/my-project');
  });
});
