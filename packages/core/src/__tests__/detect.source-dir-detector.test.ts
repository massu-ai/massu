// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectSourceDirs } from '../detect/source-dir-detector.ts';

function touch(root: string, rel: string, contents = '// empty'): void {
  const path = join(root, rel);
  const parts = rel.split('/');
  if (parts.length > 1) {
    mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(path, contents);
}

describe('detect/source-dir-detector', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'massu-src-det-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns top-segment source_dirs for TS repo', () => {
    touch(root, 'src/index.ts');
    touch(root, 'src/lib/util.ts');
    touch(root, 'src/lib/foo.ts');
    const map = detectSourceDirs(root, ['typescript']);
    expect(map.typescript).toBeDefined();
    expect(map.typescript?.source_dirs).toEqual(['src']);
    expect(map.typescript?.file_count).toBe(3);
  });

  it('detects colocated tests (src/**/*.test.ts) without dedicated tests dir', () => {
    touch(root, 'src/a.ts');
    touch(root, 'src/b.ts');
    touch(root, 'src/c.ts');
    touch(root, 'src/a.test.ts');
    const map = detectSourceDirs(root, ['typescript']);
    expect(map.typescript?.colocated).toBe(true);
    expect(map.typescript?.test_dirs).toContain('src');
  });

  it('honors top-level tests/ dir as test_dir', () => {
    touch(root, 'app/main.py');
    touch(root, 'app/util.py');
    touch(root, 'tests/test_main.py');
    const map = detectSourceDirs(root, ['python']);
    expect(map.python?.source_dirs).toEqual(expect.arrayContaining(['app']));
    expect(map.python?.test_dirs).toEqual(expect.arrayContaining(['tests']));
    expect(map.python?.colocated).toBe(false);
  });

  it('handles monorepo apps/* with per-package Python dirs', () => {
    touch(root, 'apps/ai-service/pyproject.toml', '[project]\nname = "ai"');
    touch(root, 'apps/ai-service/main.py');
    touch(root, 'apps/ai-service/util.py');
    touch(root, 'apps/data/main.py');
    const map = detectSourceDirs(root, ['python']);
    // Both python subtrees share top-level 'apps' segment
    expect(map.python?.source_dirs).toEqual(expect.arrayContaining(['apps']));
    expect(map.python?.file_count).toBe(3);
  });

  it('excludes node_modules/.venv/dist from scan', () => {
    touch(root, 'src/a.ts');
    touch(root, 'node_modules/foo/index.ts');
    touch(root, '.venv/lib/foo.py');
    touch(root, 'dist/bundle.ts');
    const ts = detectSourceDirs(root, ['typescript']);
    expect(ts.typescript?.file_count).toBe(1);
    const py = detectSourceDirs(root, ['python']);
    expect(py.python).toBeUndefined();
  });

  it('does not read .env or *.key files (even as filename match)', () => {
    // Plant secret-ish files that end with "key" or ".env" — should NOT count
    touch(root, 'src/a.ts');
    touch(root, '.env', 'DO_NOT_READ=1');
    touch(root, 'secrets.key', 'shhh');
    const map = detectSourceDirs(root, ['typescript']);
    // file_count still 1 (only a.ts); secret files aren't .ts anyway but
    // we verify the globber doesn't crash on them
    expect(map.typescript?.file_count).toBe(1);
  });

  it('returns empty map when language has no source files', () => {
    touch(root, 'README.md');
    const map = detectSourceDirs(root, ['python', 'rust']);
    expect(map.python).toBeUndefined();
    expect(map.rust).toBeUndefined();
  });

  it('rejects symlinks escaping projectRoot', () => {
    // Create a file outside root
    const outside = mkdtempSync(join(tmpdir(), 'massu-outside-'));
    try {
      touch(outside, 'secret.ts');
      // symlink inside root pointing to outside
      symlinkSync(outside, join(root, 'evil'));
      touch(root, 'src/a.ts');
      const map = detectSourceDirs(root, ['typescript']);
      // Our own file is counted; symlinked external file is not.
      expect(map.typescript?.source_dirs).toEqual(
        expect.arrayContaining(['src'])
      );
      // None of the reported source_dirs should include "evil"
      expect(map.typescript?.source_dirs).not.toContain('evil');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('detects Rust source under src/', () => {
    touch(root, 'src/main.rs');
    touch(root, 'src/lib.rs');
    touch(root, 'tests/integration.rs');
    const map = detectSourceDirs(root, ['rust']);
    expect(map.rust?.source_dirs).toEqual(expect.arrayContaining(['src']));
    expect(map.rust?.test_dirs).toEqual(expect.arrayContaining(['tests']));
  });

  it('detects Go sources and foo_test.go test pattern', () => {
    touch(root, 'cmd/app/main.go');
    touch(root, 'cmd/app/main_test.go');
    touch(root, 'internal/util/lib.go');
    const map = detectSourceDirs(root, ['go']);
    expect(map.go?.file_count).toBe(3);
    // At least one of cmd or internal is present
    expect(map.go?.source_dirs.length).toBeGreaterThan(0);
  });

  // P1-001: fallbackTsForJs flag — plain-JS manifest repo with .tsx files
  // under apps/ surfaces those files via the javascript glob only when the
  // flag is on (no typescript manifest present to take them).
  it('P1-001: fallbackTsForJs=true surfaces .tsx files for js-manifest repo', () => {
    touch(root, 'apps/web/page.tsx');
    touch(root, 'apps/api/server.js');
    const map = detectSourceDirs(root, ['javascript'], { fallbackTsForJs: true });
    expect(map.javascript?.source_dirs).toEqual(['apps']);
    expect(map.javascript?.file_count).toBe(2);
  });

  it('P1-001: fallbackTsForJs=false retains strict js-only behavior', () => {
    touch(root, 'apps/web/page.tsx');
    touch(root, 'apps/api/server.js');
    const map = detectSourceDirs(root, ['javascript']);
    // .tsx is NOT picked up; only the .js file is.
    expect(map.javascript?.source_dirs).toEqual(['apps']);
    expect(map.javascript?.file_count).toBe(1);
  });

  it('P1-001: fallbackTsForJs does NOT affect typescript language slot', () => {
    touch(root, 'src/index.ts');
    const map = detectSourceDirs(root, ['typescript'], { fallbackTsForJs: true });
    // Typescript glob unaffected — .ts files are picked up by typescript as usual.
    expect(map.typescript?.source_dirs).toEqual(['src']);
    expect(map.typescript?.file_count).toBe(1);
  });

  // P4.8-001: the fallback glob must NOT exfiltrate secrets. Even with
  // fallbackTsForJs=true and secret-ish files planted under apps/, only real
  // source files should surface. Regression gate for IGNORE_PATTERNS.
  it('P4.8-001: fallbackTsForJs still excludes .env / .ssh / credentials files', () => {
    touch(root, 'apps/web/page.tsx', 'export default () => null');
    touch(root, 'apps/.env.secret', 'SECRET=leaked');
    touch(root, 'apps/.env.production', 'PROD=leaked');
    mkdirSync(join(root, 'apps/.ssh'), { recursive: true });
    writeFileSync(join(root, 'apps/.ssh/id_rsa'), 'FAKE_KEY');
    touch(root, 'apps/web/credentials.json', '{"key":"fake"}');
    touch(root, 'apps/web/private.pem', '-----BEGIN PRIVATE KEY-----');
    touch(root, 'apps/web/code.p12', 'binary');
    const map = detectSourceDirs(root, ['javascript'], { fallbackTsForJs: true });
    // Only apps/web/page.tsx should surface — everything secret-ish filtered.
    expect(map.javascript?.file_count).toBe(1);
    expect(map.javascript?.source_dirs).toEqual(['apps']);
  });

  // P4.8-002: symlinks that escape the project root must be rejected by the
  // realpath-based isInsideRoot gate (source-dir-detector.ts:132-140). The
  // P1-001 change only affects glob extensions, not the post-filter.
  it('P4.8-002: symlink escaping projectRoot is rejected (isInsideRoot realpath)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'massu-outside-'));
    try {
      touch(outside, 'secret.tsx', 'export const x = 1');
      // Plant a harmless local file too so the glob has SOMETHING to match.
      touch(root, 'apps/web/page.tsx', 'export default () => null');
      // Create a symlink inside projectRoot pointing OUT of it.
      symlinkSync(join(outside, 'secret.tsx'), join(root, 'apps/leaked.tsx'));
      const map = detectSourceDirs(root, ['javascript'], { fallbackTsForJs: true });
      // Local file is counted; escaped symlink is not.
      expect(map.javascript?.source_dirs).toEqual(['apps']);
      // The leaked.tsx file must not be included (realpath escape rejected).
      // We can't directly inspect filenames, but the count should be 1 (only page.tsx).
      expect(map.javascript?.file_count).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
