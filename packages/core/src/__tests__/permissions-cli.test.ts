// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * VPC-01..08 — `massu permissions <sub>` CLI dispatcher tests.
 *
 * Directly exercises `handlePermissionsSubcommand(args)` per VPC test plan in
 * docs/plans/2026-05-14-1.8.0-mcp-permission-seeding.md Phase D.
 *
 * Spawning the built CLI binary is exercised by cli-dispatcher.test.ts; here
 * we focus on the dispatch + exit-code + stderr-diagnostic contract.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { handlePermissionsSubcommand } from '../commands/permissions.ts';
import { resetConfig } from '../config.ts';

const createdDirs: string[] = [];

function mkTmpProject(prefix: string): string {
  const projectRoot = mkdtempSync(join(tmpdir(), `massu-perm-cli-${prefix}-`));
  createdDirs.push(projectRoot);
  writeFileSync(
    resolve(projectRoot, 'massu.config.yaml'),
    [
      'schema_version: 2',
      'project:',
      `  name: ${prefix}`,
      '  root: auto',
      'framework:',
      '  type: typescript',
      '  primary: typescript',
      '  router: none',
      '  orm: none',
      '  ui: none',
    ].join('\n'),
  );
  mkdirSync(resolve(projectRoot, '.claude'), { recursive: true });
  return projectRoot;
}

function settingsLocalPath(projectRoot: string): string {
  return resolve(projectRoot, '.claude', 'settings.local.json');
}

function cleanupAll(): void {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function withCwd<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  resetConfig();
  return Promise.resolve(fn()).finally(() => {
    try { process.chdir(prev); } catch { /* ignore */ }
    resetConfig();
  });
}

function captureStreams(): {
  restore: () => void;
  stdout: () => string;
  stderr: () => string;
} {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: string | Uint8Array): boolean => {
      outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as never);
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: string | Uint8Array): boolean => {
      errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as never);
  return {
    restore: () => { outSpy.mockRestore(); errSpy.mockRestore(); },
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
  };
}

afterEach(cleanupAll);

describe('permissions <sub> CLI — VPC-01..08', () => {
  it('VPC-01: `permissions install` in fresh tmp dir writes entry + exit 0', async () => {
    const projectRoot = mkTmpProject('vpc-01');
    await withCwd(projectRoot, async () => {
      const streams = captureStreams();
      try {
        const r = await handlePermissionsSubcommand(['install']);
        expect(r.exitCode).toBe(0);
      } finally {
        streams.restore();
      }
      const settings = JSON.parse(readFileSync(settingsLocalPath(projectRoot), 'utf-8'));
      expect(settings.permissions.allow).toContain('mcp__massu__*');
    });
  });

  it('VPC-02: second `permissions install` call exits 0 with already-in-sync', async () => {
    const projectRoot = mkTmpProject('vpc-02');
    await withCwd(projectRoot, async () => {
      const streams = captureStreams();
      try {
        const r1 = await handlePermissionsSubcommand(['install']);
        expect(r1.exitCode).toBe(0);
        const r2 = await handlePermissionsSubcommand(['install']);
        expect(r2.exitCode).toBe(0);
        // Second call's stdout should mention "already in sync"
        expect(streams.stdout()).toMatch(/already in sync|No permission drift/);
      } finally {
        streams.restore();
      }
    });
  });

  it('VPC-03: `permissions verify` after seed exits 0', async () => {
    const projectRoot = mkTmpProject('vpc-03');
    await withCwd(projectRoot, async () => {
      const streams = captureStreams();
      try {
        await handlePermissionsSubcommand(['install']);
        const r = await handlePermissionsSubcommand(['verify']);
        expect(r.exitCode).toBe(0);
        expect(streams.stdout()).toMatch(/All MCP allowlist entries present/);
      } finally {
        streams.restore();
      }
    });
  });

  it('VPC-04: `permissions verify` without seed exits 1 + stderr missing: mcp__massu__*', async () => {
    const projectRoot = mkTmpProject('vpc-04');
    await withCwd(projectRoot, async () => {
      const streams = captureStreams();
      try {
        const r = await handlePermissionsSubcommand(['verify']);
        expect(r.exitCode).toBe(1);
        expect(streams.stderr()).toMatch(/missing: mcp__massu__\*/);
      } finally {
        streams.restore();
      }
    });
  });

  it('VPC-05: `permissions check-drift` clean state exits 0', async () => {
    const projectRoot = mkTmpProject('vpc-05');
    // Override HOME to an empty dir so readGlobalSettings returns {} —
    // otherwise the test would inherit the developer's real ~/.claude/settings.json
    // and falsely fail when that global has e.g. defaultMode:"auto".
    const mockHome = mkdtempSync(join(tmpdir(), 'massu-perm-cli-home-empty-'));
    createdDirs.push(mockHome);
    const prevHome = process.env.HOME;
    process.env.HOME = mockHome;
    try {
      await withCwd(projectRoot, async () => {
        const streams = captureStreams();
        try {
          await handlePermissionsSubcommand(['install']);
          const r = await handlePermissionsSubcommand(['check-drift']);
          expect(r.exitCode).toBe(0);
          expect(streams.stdout()).toMatch(/No permission drift detected/);
        } finally {
          streams.restore();
        }
      });
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
    }
  });

  it('VPC-06: `permissions check-drift` with invalid defaultMode exits 2 + diagnostic', async () => {
    const projectRoot = mkTmpProject('vpc-06');
    await withCwd(projectRoot, async () => {
      // Pre-seed local with invalid defaultMode
      writeFileSync(
        settingsLocalPath(projectRoot),
        JSON.stringify({
          permissions: {
            allow: ['mcp__massu__*'],
            defaultMode: 'bypassPermissions',
          },
        }),
        'utf-8',
      );
      const streams = captureStreams();
      try {
        const r = await handlePermissionsSubcommand(['check-drift']);
        expect(r.exitCode).toBe(2);
        expect(streams.stderr()).toMatch(/drift\[invalid-default-mode\]/);
      } finally {
        streams.restore();
      }
    });
  });

  it('VPC-07: `permissions check-drift` with strips-global-defaultmode exits 4', async () => {
    const projectRoot = mkTmpProject('vpc-07');
    // Stage a mock HOME with global settings.json containing defaultMode:auto
    const mockHome = mkdtempSync(join(tmpdir(), 'massu-perm-cli-home-'));
    createdDirs.push(mockHome);
    mkdirSync(resolve(mockHome, '.claude'), { recursive: true });
    writeFileSync(
      resolve(mockHome, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'auto' } }),
      'utf-8',
    );
    // Local has permissions object WITHOUT defaultMode (the F15+F16 trap)
    writeFileSync(
      settingsLocalPath(projectRoot),
      JSON.stringify({
        permissions: { allow: ['mcp__massu__*'] },
      }),
      'utf-8',
    );

    const prevHome = process.env.HOME;
    process.env.HOME = mockHome;
    try {
      await withCwd(projectRoot, async () => {
        const streams = captureStreams();
        try {
          const r = await handlePermissionsSubcommand(['check-drift']);
          expect(r.exitCode).toBe(4);
          expect(streams.stderr()).toMatch(/drift\[strips-global-defaultmode\]/);
        } finally {
          streams.restore();
        }
      });
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
    }
  });

  it('VPC-08: `permissions install` fail-loud assertion class exists and is throwable', async () => {
    // Direct unit-style check that InstallPermissionsAssertionError is exported.
    // The class is throwable by installPermissions when disk state diverges
    // from expected merged state after the atomic write. Full reproduction
    // requires a filesystem race that's impractical to simulate deterministically;
    // PERM-DRIFT-16 in permissions.test.ts asserts the class shape.
    const { InstallPermissionsAssertionError } = await import('../permissions.ts');
    expect(InstallPermissionsAssertionError).toBeDefined();
    const err = new InstallPermissionsAssertionError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InstallPermissionsAssertionError');
  });
});

describe('permissions <sub> CLI — help + unknown', () => {
  it('VPC-help: --help prints subcommand list', async () => {
    const projectRoot = mkTmpProject('vpc-help');
    await withCwd(projectRoot, async () => {
      const streams = captureStreams();
      try {
        const r = await handlePermissionsSubcommand(['--help']);
        expect(r.exitCode).toBe(0);
        expect(streams.stdout()).toMatch(/install\s*Seed/);
        expect(streams.stdout()).toMatch(/verify\s*Read-only/);
        expect(streams.stdout()).toMatch(/check-drift/);
      } finally {
        streams.restore();
      }
    });
  });

  it('VPC-unknown: unknown subcommand exits 1', async () => {
    const projectRoot = mkTmpProject('vpc-unknown');
    await withCwd(projectRoot, async () => {
      const streams = captureStreams();
      try {
        const r = await handlePermissionsSubcommand(['not-a-real-subcommand']);
        expect(r.exitCode).toBe(1);
        expect(streams.stderr()).toMatch(/unknown permissions subcommand/);
      } finally {
        streams.restore();
      }
    });
  });
});

// Suppress unused-variable lint: existsSync imported for future use
void existsSync;
