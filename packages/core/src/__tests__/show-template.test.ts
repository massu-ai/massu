// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Phase 2 / P2-005 — show-template SHOW-01..03.
 *
 * `runShowTemplate` resolves a bundled template through `pickVariant` against
 * the consumer's `massu.config.yaml`, prints it to stdout, and exits 1 on
 * unknown names.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import { resetConfig } from '../config.ts';

const createdDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `massu-show-template-test-${prefix}-`));
  createdDirs.push(d);
  return d;
}

function cleanupAll(): void {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

afterEach(() => {
  cleanupAll();
  resetConfig();
});

/**
 * Stage a self-contained @massu/core install layout under `consumerRoot`:
 *   <consumerRoot>/node_modules/@massu/core/commands/<files...>
 *   <consumerRoot>/massu.config.yaml
 *
 * resolveAssetDir() walks node_modules first, so writing the bundled commands
 * there lets us bypass the dist/src lookup paths that depend on package layout.
 */
function stageConsumer(opts: {
  prefix: string;
  yaml: string;
  bundledFiles: Record<string, string>;
}): { root: string } {
  const root = mkTmp(opts.prefix);
  writeFileSync(resolve(root, 'massu.config.yaml'), opts.yaml);

  const bundleDir = resolve(root, 'node_modules', '@massu', 'core', 'commands');
  mkdirSync(bundleDir, { recursive: true });
  for (const [name, content] of Object.entries(opts.bundledFiles)) {
    writeFileSync(resolve(bundleDir, name), content);
  }
  return { root };
}

describe('runShowTemplate — SHOW-01..03', () => {
  it('SHOW-01: TS-only fixture prints the contents of `massu-scaffold-router.md`', async () => {
    const { root } = stageConsumer({
      prefix: 'show01',
      yaml: [
        'schema_version: 2',
        'project: { name: show01, root: auto }',
        'framework:',
        '  type: typescript',
        '  primary: typescript',
      ].join('\n'),
      bundledFiles: {
        'massu-scaffold-router.md': '# tRPC default content',
      },
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      resetConfig();
      const { runShowTemplate } = await import('../commands/show-template.ts');
      await runShowTemplate(['massu-scaffold-router']);

      expect(exitSpy).not.toHaveBeenCalled();
      const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stdoutText).toBe('# tRPC default content');
    } finally {
      try { process.chdir(prevCwd); } catch { /* ignore */ }
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('SHOW-02: python-declared fixture with `.python.md` shipped → prints the python variant', async () => {
    const { root } = stageConsumer({
      prefix: 'show02',
      yaml: [
        'schema_version: 2',
        'project: { name: show02, root: auto }',
        'framework:',
        '  type: multi',
        '  primary: typescript',
        '  languages:',
        '    python:',
        '      framework: fastapi',
      ].join('\n'),
      bundledFiles: {
        'massu-scaffold-router.md': '# tRPC default',
        'massu-scaffold-router.python.md': '# FastAPI variant content',
      },
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      resetConfig();
      const { runShowTemplate } = await import('../commands/show-template.ts');
      // Accept the `.md`-suffixed form too.
      await runShowTemplate(['massu-scaffold-router.md']);

      expect(exitSpy).not.toHaveBeenCalled();
      const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stdoutText).toBe('# FastAPI variant content');
    } finally {
      try { process.chdir(prevCwd); } catch { /* ignore */ }
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('SHOW-03: unknown template name → exits 1 and stderr contains "no template named"', async () => {
    const { root } = stageConsumer({
      prefix: 'show03',
      yaml: [
        'schema_version: 2',
        'project: { name: show03, root: auto }',
        'framework:',
        '  type: typescript',
      ].join('\n'),
      bundledFiles: {
        'massu-scaffold-router.md': '# something',
      },
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      resetConfig();
      const { runShowTemplate } = await import('../commands/show-template.ts');

      await expect(runShowTemplate(['nope-not-a-real-template'])).rejects.toThrow(
        'process.exit called',
      );

      expect(exitSpy).toHaveBeenCalledWith(1);
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrText).toMatch(/no template named/);
    } finally {
      try { process.chdir(prevCwd); } catch { /* ignore */ }
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
