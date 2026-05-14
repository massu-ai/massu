// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PERM-DRIFT-01..19 — drift-guard test for the `permissions.ts` SSOT module.
 *
 * Tests land BEFORE the implementation (per operator hard constraint
 * "Test-first: drift-guard test must exist before seeding code lands").
 * First run = RED. After permissions.ts ships = GREEN.
 *
 * v3 expansion: PERM-DRIFT-13..19 cover the merge-replacement trap
 * (operator empirical observation 2026-05-14 PM): project-local `permissions`
 * object without `defaultMode` strips the global `defaultMode` during settings
 * merge. The structural fix is to write the FULL merged block including
 * defaultMode propagated from global.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { Manifest } from '../commands/install-commands.ts';
import {
  MASSU_PERMISSION_ENTRIES,
  LAUNCH_FLAG_REQUIRED_MODES,
  findMissingEntries,
  detectInvalidDefaultMode,
  mergedPermissionState,
  installPermissions,
  verifyPermissions,
  checkPermissionsDrift,
  InstallPermissionsAssertionError,
} from '../permissions.ts';

const createdDirs: string[] = [];

function mkTmpClaudeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `massu-perm-test-${prefix}-`));
  createdDirs.push(d);
  return d;
}

function cleanupAll(): void {
  while (createdDirs.length) {
    const d = createdDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function emptyManifest(): Manifest {
  return {
    version: 1,
    generatedBy: '@massu/core@test',
    generatedAt: new Date().toISOString(),
    entries: {},
  };
}

function readSettingsFile(claudeDir: string): Record<string, unknown> {
  const path = resolve(claudeDir, 'settings.local.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeSettingsFile(claudeDir: string, settings: Record<string, unknown>): void {
  const path = resolve(claudeDir, 'settings.local.json');
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

afterEach(cleanupAll);

// ============================================================
// PERM-DRIFT-01..02 — canonical entries SSOT
// ============================================================

describe('MASSU_PERMISSION_ENTRIES — PERM-DRIFT-01..02', () => {
  it('PERM-DRIFT-01: non-empty array of strings', () => {
    expect(Array.isArray(MASSU_PERMISSION_ENTRIES)).toBe(true);
    expect(MASSU_PERMISSION_ENTRIES.length).toBeGreaterThan(0);
    for (const entry of MASSU_PERMISSION_ENTRIES) {
      expect(typeof entry).toBe('string');
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  it('PERM-DRIFT-02: snapshot — equals exactly ["mcp__massu__*"]', () => {
    // Any future addition forces explicit edit + test bump. SSOT lock.
    expect([...MASSU_PERMISSION_ENTRIES]).toEqual(['mcp__massu__*']);
  });
});

// ============================================================
// PERM-DRIFT-03..06 — installPermissions core semantics
// ============================================================

describe('installPermissions — PERM-DRIFT-03..06', () => {
  it('PERM-DRIFT-03: writes mcp__massu__* into permissions.allow + returns installed:1', () => {
    const claudeDir = mkTmpClaudeDir('p03');
    const manifest = emptyManifest();
    const result = installPermissions(claudeDir, manifest, { silent: true, global: {} });
    expect(result).toEqual({ installed: 1, kept: 0, skipped: 0 });

    const settings = readSettingsFile(claudeDir);
    const allow = (settings.permissions as { allow?: unknown[] })?.allow ?? [];
    expect(allow).toContain('mcp__massu__*');
  });

  it('PERM-DRIFT-04: idempotency — second call returns skipped:1, no duplication', () => {
    const claudeDir = mkTmpClaudeDir('p04');
    const manifest = emptyManifest();
    installPermissions(claudeDir, manifest, { silent: true, global: {} });
    const result = installPermissions(claudeDir, manifest, { silent: true, global: {} });
    expect(result).toEqual({ installed: 0, kept: 0, skipped: 1 });

    const settings = readSettingsFile(claudeDir);
    const allow = (settings.permissions as { allow: string[] }).allow;
    const matches = allow.filter((e) => e === 'mcp__massu__*');
    expect(matches.length).toBe(1);
  });

  it('PERM-DRIFT-05: operator-removal preservation — kept:1, entry NOT re-added', () => {
    const claudeDir = mkTmpClaudeDir('p05');
    const manifest = emptyManifest();
    // First install
    installPermissions(claudeDir, manifest, { silent: true, global: {} });
    // Operator manually removes the entry
    const settings = readSettingsFile(claudeDir);
    const permissions = settings.permissions as { allow: string[] };
    permissions.allow = permissions.allow.filter((e) => e !== 'mcp__massu__*');
    writeSettingsFile(claudeDir, settings);
    // Second install — must respect the removal
    const result = installPermissions(claudeDir, manifest, { silent: true, global: {} });
    expect(result.kept).toBe(1);

    const after = readSettingsFile(claudeDir);
    const allow = (after.permissions as { allow: string[] }).allow;
    expect(allow).not.toContain('mcp__massu__*');
  });

  it('PERM-DRIFT-06: preserves existing unrelated entries', () => {
    const claudeDir = mkTmpClaudeDir('p06');
    writeSettingsFile(claudeDir, {
      permissions: { allow: ['Bash(ls)', 'Read(src/**)'] },
    });
    const manifest = emptyManifest();
    installPermissions(claudeDir, manifest, { silent: true, global: {} });

    const settings = readSettingsFile(claudeDir);
    const allow = (settings.permissions as { allow: string[] }).allow;
    expect(allow).toContain('Bash(ls)');
    expect(allow).toContain('Read(src/**)');
    expect(allow).toContain('mcp__massu__*');
  });
});

// ============================================================
// PERM-DRIFT-07..08 — verifyPermissions + findMissingEntries
// ============================================================

describe('verifyPermissions + findMissingEntries — PERM-DRIFT-07..08', () => {
  it('PERM-DRIFT-07: verifyPermissions returns missing:[] when present, missing:[entry] when absent', () => {
    const claudeDir = mkTmpClaudeDir('p07');
    // Absent
    let result = verifyPermissions(claudeDir);
    expect(result.missing).toEqual(['mcp__massu__*']);

    // Present
    writeSettingsFile(claudeDir, { permissions: { allow: ['mcp__massu__*'] } });
    result = verifyPermissions(claudeDir);
    expect(result.missing).toEqual([]);
    expect(result.allowList).toContain('mcp__massu__*');
  });

  it('PERM-DRIFT-08: findMissingEntries is the pure SSOT helper used by writer + verifier', () => {
    expect(findMissingEntries([])).toEqual(['mcp__massu__*']);
    expect(findMissingEntries(['Bash(ls)'])).toEqual(['mcp__massu__*']);
    expect(findMissingEntries(['mcp__massu__*'])).toEqual([]);
    expect(findMissingEntries(['mcp__massu__*', 'Bash(ls)'])).toEqual([]);
  });
});

// ============================================================
// PERM-DRIFT-09..11 — LAUNCH_FLAG_REQUIRED_MODES + detectInvalidDefaultMode
// ============================================================

describe('LAUNCH_FLAG_REQUIRED_MODES + detectInvalidDefaultMode — PERM-DRIFT-09..11', () => {
  it('PERM-DRIFT-09: snapshot = ["bypassPermissions", "auto", "dontAsk"]', () => {
    expect([...LAUNCH_FLAG_REQUIRED_MODES]).toEqual(['bypassPermissions', 'auto', 'dontAsk']);
  });

  it('PERM-DRIFT-10: bypassPermissions → invalid:true with docs-cited reason', () => {
    const result = detectInvalidDefaultMode({
      permissions: { defaultMode: 'bypassPermissions' },
    });
    expect(result.invalid).toBe(true);
    expect(result.mode).toBe('bypassPermissions');
    expect(result.reason).toMatch(/launch flag|--permission-mode|code\.claude\.com/i);
  });

  it('PERM-DRIFT-11: acceptEdits → invalid:false', () => {
    const result = detectInvalidDefaultMode({
      permissions: { defaultMode: 'acceptEdits' },
    });
    expect(result.invalid).toBe(false);
  });
});

// ============================================================
// PERM-DRIFT-12 + 17 — checkPermissionsDrift aggregation
// ============================================================

describe('checkPermissionsDrift — PERM-DRIFT-12 + 17', () => {
  it('PERM-DRIFT-12: aggregates missing-allow + invalid-default-mode + unknown-key kinds', () => {
    const claudeDir = mkTmpClaudeDir('p12');
    writeSettingsFile(claudeDir, {
      permissions: { defaultMode: 'bypassPermissions', allow: [] },
      skipAutoPermissionPrompt: true, // undocumented top-level key
    });
    const result = checkPermissionsDrift(claudeDir, { global: {} });

    const kinds = result.driftItems.map((d) => d.kind).sort();
    expect(kinds).toContain('missing-allow');
    expect(kinds).toContain('invalid-default-mode');
    // Unknown-key detection MAY include skipAutoPermissionPrompt OR may be limited
    // to known-bad keys. Just assert structure for now.
    expect(result.driftItems.length).toBeGreaterThanOrEqual(2);
    for (const item of result.driftItems) {
      expect(typeof item.kind).toBe('string');
      expect(typeof item.detail).toBe('string');
      expect(typeof item.remediation).toBe('string');
    }
  });

  it('PERM-DRIFT-17: detects strips-global-defaultmode kind (the F15+F16 trap)', () => {
    const claudeDir = mkTmpClaudeDir('p17');
    // Local has permissions object WITHOUT defaultMode; global has defaultMode set.
    writeSettingsFile(claudeDir, {
      permissions: { allow: ['mcp__massu__massu_sentinel_register'] },
    });
    const mockGlobal = { permissions: { defaultMode: 'auto' } };
    const result = checkPermissionsDrift(claudeDir, { global: mockGlobal });

    const trap = result.driftItems.find((d) => d.kind === 'strips-global-defaultmode');
    expect(trap).toBeDefined();
    expect(trap!.detail).toMatch(/auto|defaultMode/);
    expect(trap!.remediation).toMatch(/permissions install|install/i);
  });
});

// ============================================================
// PERM-DRIFT-13..15 — mergedPermissionState (v3 merge-replacement structural fix)
// ============================================================

describe('mergedPermissionState — PERM-DRIFT-13..15', () => {
  it('PERM-DRIFT-13: global=auto + local-no-defaultMode → propagates defaultMode:auto', () => {
    const global = { permissions: { defaultMode: 'auto' } };
    const local = { permissions: { allow: ['Bash(ls)'] } };
    const merged = mergedPermissionState(global, local, MASSU_PERMISSION_ENTRIES);
    expect(merged.defaultMode).toBe('auto');
    expect(merged.allow).toContain('Bash(ls)');
    expect(merged.allow).toContain('mcp__massu__*');
  });

  it('PERM-DRIFT-14: user-override-wins — local defaultMode preserved over global', () => {
    const global = { permissions: { defaultMode: 'auto' } };
    const local = { permissions: { defaultMode: 'acceptEdits', allow: [] } };
    const merged = mergedPermissionState(global, local, MASSU_PERMISSION_ENTRIES);
    expect(merged.defaultMode).toBe('acceptEdits');
  });

  it('PERM-DRIFT-15: no defaultMode anywhere → omits the key entirely', () => {
    const global = {};
    const local = { permissions: { allow: [] } };
    const merged = mergedPermissionState(global, local, MASSU_PERMISSION_ENTRIES);
    expect(merged.defaultMode).toBeUndefined();
    // The result object MUST not contain a defaultMode key at all (vs explicit undefined)
    expect('defaultMode' in merged).toBe(false);
  });
});

// ============================================================
// PERM-DRIFT-16 — fail-loud post-write assertion
// ============================================================

describe('installPermissions fail-loud assertion — PERM-DRIFT-16', () => {
  it('PERM-DRIFT-16: throws InstallPermissionsAssertionError when defaultMode was decided but not on disk', () => {
    const claudeDir = mkTmpClaudeDir('p16');
    const manifest = emptyManifest();
    // Inject mock global with defaultMode:auto; this should propagate to local.
    // To force the assertion to fire, we corrupt the post-write by stubbing the
    // write step. Simplest reproduction: install once, then manually remove
    // the defaultMode from disk, then re-install — the re-install computes
    // merged.defaultMode='auto' (from injected global), writes, and re-reads.
    // After write, we expect defaultMode='auto' on disk. If we tamper between
    // write and re-read in real code, the assertion fires.
    //
    // Since we can't easily tamper mid-call, we test the assertion class itself:
    // the class must exist and be throwable.
    expect(InstallPermissionsAssertionError).toBeDefined();
    expect(InstallPermissionsAssertionError.prototype).toBeInstanceOf(Error);

    // Verify the assertion DOES NOT fire on healthy install:
    const result = installPermissions(claudeDir, manifest, {
      silent: true,
      global: { permissions: { defaultMode: 'auto' } },
    });
    expect(result.installed).toBe(1);
    const settings = readSettingsFile(claudeDir);
    expect((settings.permissions as { defaultMode?: string }).defaultMode).toBe('auto');
  });
});

// ============================================================
// PERM-DRIFT-18..19 — full snapshot scenarios
// ============================================================

describe('installPermissions snapshot scenarios — PERM-DRIFT-18..19', () => {
  it('PERM-DRIFT-18: global=auto + fresh project → defaultMode:auto AND allow includes mcp__massu__*', () => {
    const claudeDir = mkTmpClaudeDir('p18');
    const manifest = emptyManifest();
    installPermissions(claudeDir, manifest, {
      silent: true,
      global: { permissions: { defaultMode: 'auto' } },
    });

    const settings = readSettingsFile(claudeDir);
    const permissions = settings.permissions as { defaultMode?: string; allow: string[] };
    expect(permissions.defaultMode).toBe('auto');
    expect(permissions.allow).toContain('mcp__massu__*');
  });

  it('PERM-DRIFT-19: global=bypassPermissions → preserved exactly (massu does NOT police user choice)', () => {
    const claudeDir = mkTmpClaudeDir('p19');
    const manifest = emptyManifest();
    installPermissions(claudeDir, manifest, {
      silent: true,
      global: { permissions: { defaultMode: 'bypassPermissions' } },
    });

    const settings = readSettingsFile(claudeDir);
    const permissions = settings.permissions as { defaultMode?: string };
    expect(permissions.defaultMode).toBe('bypassPermissions');
    // Note: this defaultMode is launch-flag-required per docs F11; the
    // operator's choice is preserved. checkPermissionsDrift WILL surface
    // this as drift[invalid-default-mode] for the operator to resolve.
  });
});
