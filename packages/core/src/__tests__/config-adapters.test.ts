/**
 * Tests for the Plan 3c config schema extension (gap-21 / VR-CONFIG-SCHEMA-EXTENSION + gap-58).
 *
 * Coverage:
 * - AdaptersConfigSchema defaults (enabled=false, allow_unsigned=false, local=[])
 * - AdaptersConfigSchema is optional at the top level
 * - AdaptersConfigSchema.passthrough() preserves unknown keys
 * - TelemetryConfigSchema defaults (adapters=false)
 * - AdapterLocalPathSchema rejects absolute Unix paths (/etc/passwd)
 * - AdapterLocalPathSchema rejects absolute Windows paths (C:\)
 * - AdapterLocalPathSchema rejects ../ traversal
 * - AdapterLocalPathSchema normalizes Windows backslashes to POSIX forward slashes
 * - AdapterLocalPathSchema preserves clean POSIX paths
 * - Fingerprint stability — POSIX-form input and Windows-form input of the same
 *   logical path normalize to identical strings (ensures sha256 stability)
 *
 * Note: AdapterLocalPathSchema, AdaptersConfigSchema, TelemetryConfigSchema are
 * private const symbols inside config.ts. We test them indirectly via their
 * placement inside RawConfigSchema's adapters/telemetry fields, exercising the
 * full safeParse path that getConfig() uses in production.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import { getConfig, resetConfig } from '../config.js';

interface MinimalConfig {
  adapters?: { enabled?: boolean; allow_unsigned?: boolean; local?: string[]; [k: string]: unknown };
  telemetry?: { adapters?: boolean; [k: string]: unknown };
}

function setupTempConfig(content: MinimalConfig): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'massu-config-test-'));
  writeFileSync(join(dir, 'massu.config.yaml'), yamlStringify(content), 'utf-8');
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function loadConfigFromDir(dir: string) {
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    resetConfig();
    return getConfig();
  } finally {
    process.chdir(prevCwd);
    resetConfig();
  }
}

beforeEach(() => {
  resetConfig();
});

describe('AdaptersConfigSchema (gap-21 / VR-CONFIG-SCHEMA-EXTENSION)', () => {
  it('omitting adapters block leaves cfg.adapters undefined (.optional() semantics)', () => {
    const { dir, cleanup } = setupTempConfig({});
    try {
      const cfg = loadConfigFromDir(dir);
      expect(cfg.adapters).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('explicit empty {adapters: {}} block applies all defaults', () => {
    const { dir, cleanup } = setupTempConfig({ adapters: {} });
    try {
      const cfg = loadConfigFromDir(dir);
      expect(cfg.adapters?.enabled).toBe(false);
      expect(cfg.adapters?.local).toEqual([]);
      // CR-9 audit C2 fix: allow_unsigned was REMOVED (it was parsed but
      // never consulted, creating a tripwire for future contributors).
      expect((cfg.adapters as Record<string, unknown> | undefined)?.allow_unsigned).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('user-set adapters.enabled=true is honored', () => {
    const { dir, cleanup } = setupTempConfig({ adapters: { enabled: true } });
    try {
      const cfg = loadConfigFromDir(dir);
      expect(cfg.adapters?.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('passthrough() preserves unknown keys (forward compat)', () => {
    const { dir, cleanup } = setupTempConfig({
      adapters: { enabled: true, future_field: 'unknown' },
    });
    try {
      const cfg = loadConfigFromDir(dir);
      expect((cfg.adapters as Record<string, unknown>)?.future_field).toBe('unknown');
    } finally {
      cleanup();
    }
  });
});

describe('TelemetryConfigSchema', () => {
  it('omitting telemetry block leaves cfg.telemetry undefined', () => {
    const { dir, cleanup } = setupTempConfig({});
    try {
      const cfg = loadConfigFromDir(dir);
      expect(cfg.telemetry).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('explicit empty {telemetry: {}} defaults adapters=false', () => {
    const { dir, cleanup } = setupTempConfig({ telemetry: {} });
    try {
      const cfg = loadConfigFromDir(dir);
      expect(cfg.telemetry?.adapters).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('user-set telemetry.adapters=true is honored', () => {
    const { dir, cleanup } = setupTempConfig({ telemetry: { adapters: true } });
    try {
      const cfg = loadConfigFromDir(dir);
      expect(cfg.telemetry?.adapters).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('AdapterLocalPathSchema (gap-58 — postinstall-poisoning + cross-platform)', () => {
  it('rejects absolute Unix paths', () => {
    const { dir, cleanup } = setupTempConfig({
      adapters: { local: ['/etc/passwd'] },
    });
    try {
      expect(() => loadConfigFromDir(dir)).toThrow(/absolute/i);
    } finally {
      cleanup();
    }
  });

  it('rejects absolute Windows paths (C:\\path)', () => {
    const { dir, cleanup } = setupTempConfig({
      adapters: { local: ['C:\\Windows\\System32'] },
    });
    try {
      expect(() => loadConfigFromDir(dir)).toThrow(/absolute/i);
    } finally {
      cleanup();
    }
  });

  it('rejects parent-directory traversal (../)', () => {
    const { dir, cleanup } = setupTempConfig({
      adapters: { local: ['../../home/user/.ssh/id_rsa'] },
    });
    try {
      expect(() => loadConfigFromDir(dir)).toThrow(/parent-directory traversal/i);
    } finally {
      cleanup();
    }
  });

  it('normalizes Windows backslash to POSIX forward slash', () => {
    const { dir, cleanup } = setupTempConfig({
      adapters: { local: ['adapters\\custom\\foo.js'] },
    });
    try {
      const cfg = loadConfigFromDir(dir);
      expect(cfg.adapters?.local).toEqual(['adapters/custom/foo.js']);
    } finally {
      cleanup();
    }
  });

  it('preserves clean POSIX paths unchanged', () => {
    const { dir, cleanup } = setupTempConfig({
      adapters: { local: ['adapters/custom/foo.js'] },
    });
    try {
      const cfg = loadConfigFromDir(dir);
      expect(cfg.adapters?.local).toEqual(['adapters/custom/foo.js']);
    } finally {
      cleanup();
    }
  });

  it('cross-platform fingerprint stability — backslash and forward-slash inputs normalize identically', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'massu-fp-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'massu-fp-b-'));
    try {
      writeFileSync(join(dirA, 'massu.config.yaml'), yamlStringify({
        adapters: { local: ['adapters\\foo.js', 'adapters\\bar.js'] },
      }), 'utf-8');
      writeFileSync(join(dirB, 'massu.config.yaml'), yamlStringify({
        adapters: { local: ['adapters/foo.js', 'adapters/bar.js'] },
      }), 'utf-8');

      const cfgA = loadConfigFromDir(dirA);
      const cfgB = loadConfigFromDir(dirB);
      expect(cfgA.adapters?.local).toEqual(cfgB.adapters?.local);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
