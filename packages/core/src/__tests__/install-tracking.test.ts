/**
 * Tests for install-tracking sidecar (Plan 3c gap-37).
 *
 * Coverage:
 * - sha256OfDir is content-addressed + machine-stable (sorted file paths,
 *   no metadata)
 * - sha256OfDir excludes .git/ + node_modules/ + .cache/
 * - sha256OfDir caps file size at maxFileBytes
 * - readInstalledManifest returns {} on absent / corrupt / wrong-shape
 * - writeInstalledManifestEntry atomic + 0o600 file mode
 * - removeInstalledManifestEntry is a no-op when key absent
 * - verifyInstalledIntegrity returns ok/no-entry/drift correctly
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sha256OfDir,
  readInstalledManifest,
  writeInstalledManifestEntry,
  removeInstalledManifestEntry,
  verifyInstalledIntegrity,
} from '../security/install-tracking.js';

let workdir: string;
let sidecarPath: string;
let pkgDir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'massu-install-tracking-'));
  sidecarPath = join(workdir, 'adapter-manifest-installed.json');
  pkgDir = join(workdir, 'pkg');
  mkdirSync(pkgDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workdir)) {
    rmSync(workdir, { recursive: true, force: true });
  }
});

describe('sha256OfDir', () => {
  it('produces a 64-hex-char output', () => {
    writeFileSync(join(pkgDir, 'index.js'), 'console.log(1);', 'utf-8');
    const hash = sha256OfDir(pkgDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different file content → different hash', () => {
    writeFileSync(join(pkgDir, 'a.js'), 'a', 'utf-8');
    const h1 = sha256OfDir(pkgDir);
    writeFileSync(join(pkgDir, 'a.js'), 'b', 'utf-8');
    const h2 = sha256OfDir(pkgDir);
    expect(h1).not.toBe(h2);
  });

  it('different file count → different hash', () => {
    writeFileSync(join(pkgDir, 'a.js'), 'a', 'utf-8');
    const h1 = sha256OfDir(pkgDir);
    writeFileSync(join(pkgDir, 'b.js'), 'b', 'utf-8');
    const h2 = sha256OfDir(pkgDir);
    expect(h1).not.toBe(h2);
  });

  it('reordering files does not change hash (sorted internally)', () => {
    writeFileSync(join(pkgDir, 'a.js'), 'a', 'utf-8');
    writeFileSync(join(pkgDir, 'b.js'), 'b', 'utf-8');
    const h1 = sha256OfDir(pkgDir);
    // Re-create in different order — same content, same hash.
    rmSync(pkgDir, { recursive: true });
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'b.js'), 'b', 'utf-8');
    writeFileSync(join(pkgDir, 'a.js'), 'a', 'utf-8');
    const h2 = sha256OfDir(pkgDir);
    expect(h1).toBe(h2);
  });

  it('excludes .git/ + node_modules/ + .cache/', () => {
    writeFileSync(join(pkgDir, 'index.js'), 'real', 'utf-8');
    const baseHash = sha256OfDir(pkgDir);

    // Add excluded subdirs with garbage content — must NOT affect hash.
    mkdirSync(join(pkgDir, '.git'), { recursive: true });
    writeFileSync(join(pkgDir, '.git', 'config'), 'random git data', 'utf-8');
    mkdirSync(join(pkgDir, 'node_modules', 'somedep'), { recursive: true });
    writeFileSync(join(pkgDir, 'node_modules', 'somedep', 'index.js'), 'transitive', 'utf-8');
    mkdirSync(join(pkgDir, '.cache'), { recursive: true });
    writeFileSync(join(pkgDir, '.cache', 'foo'), 'cache data', 'utf-8');

    expect(sha256OfDir(pkgDir)).toBe(baseHash);
  });

  it('throws on file exceeding maxFileBytes', () => {
    // 100 bytes file with 50-byte cap → throws.
    writeFileSync(join(pkgDir, 'big.bin'), Buffer.alloc(100), 'utf-8');
    expect(() => sha256OfDir(pkgDir, { maxFileBytes: 50 })).toThrow(/exceeds maxFileBytes/i);
  });

  it('handles nested directories', () => {
    mkdirSync(join(pkgDir, 'src', 'lib'), { recursive: true });
    writeFileSync(join(pkgDir, 'src', 'lib', 'a.js'), 'a', 'utf-8');
    const hash = sha256OfDir(pkgDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('readInstalledManifest', () => {
  it('returns {} when file does not exist', () => {
    expect(readInstalledManifest(sidecarPath)).toEqual({});
  });

  it('returns {} on corrupt JSON', () => {
    writeFileSync(sidecarPath, 'not-json{', 'utf-8');
    expect(readInstalledManifest(sidecarPath)).toEqual({});
  });

  it('returns {} on wrong shape', () => {
    writeFileSync(sidecarPath, JSON.stringify({ '@massu/adapter-rails': 'wrong-type' }), 'utf-8');
    expect(readInstalledManifest(sidecarPath)).toEqual({});
  });

  it('returns parsed entries on valid file', () => {
    writeInstalledManifestEntry(
      '@massu/adapter-rails',
      {
        version: '0.1.0',
        installed_sha256: 'a'.repeat(64),
        manifest_sha256: 'a'.repeat(64),
        ts: '2026-05-07T00:00:00Z',
      },
      sidecarPath,
    );
    const result = readInstalledManifest(sidecarPath);
    expect(result['@massu/adapter-rails']?.version).toBe('0.1.0');
  });
});

describe('writeInstalledManifestEntry', () => {
  it('writes file with mode 0o600', () => {
    writeInstalledManifestEntry(
      '@massu/adapter-rails',
      {
        version: '0.1.0',
        installed_sha256: 'a'.repeat(64),
        manifest_sha256: 'a'.repeat(64),
        ts: '2026-05-07T00:00:00Z',
      },
      sidecarPath,
    );
    expect(existsSync(sidecarPath)).toBe(true);
    expect(statSync(sidecarPath).mode & 0o777).toBe(0o600);
  });

  it('additive: subsequent writes preserve other entries', () => {
    writeInstalledManifestEntry('@massu/adapter-a', {
      version: '0.1.0', installed_sha256: 'a'.repeat(64), manifest_sha256: 'a'.repeat(64), ts: '2026-05-07T00:00:00Z',
    }, sidecarPath);
    writeInstalledManifestEntry('@massu/adapter-b', {
      version: '0.2.0', installed_sha256: 'b'.repeat(64), manifest_sha256: 'b'.repeat(64), ts: '2026-05-07T00:00:01Z',
    }, sidecarPath);
    const result = readInstalledManifest(sidecarPath);
    expect(Object.keys(result).sort()).toEqual(['@massu/adapter-a', '@massu/adapter-b']);
  });
});

describe('removeInstalledManifestEntry', () => {
  it('removes a present entry', () => {
    writeInstalledManifestEntry('@massu/adapter-a', {
      version: '0.1.0', installed_sha256: 'a'.repeat(64), manifest_sha256: 'a'.repeat(64), ts: '2026-05-07T00:00:00Z',
    }, sidecarPath);
    removeInstalledManifestEntry('@massu/adapter-a', sidecarPath);
    expect(readInstalledManifest(sidecarPath)).toEqual({});
  });

  it('no-op when key absent', () => {
    const result = removeInstalledManifestEntry('@massu/never-installed', sidecarPath);
    expect(result.written).toBe(true);
  });
});

describe('verifyInstalledIntegrity', () => {
  it('ok when sha matches recorded entry', () => {
    writeFileSync(join(pkgDir, 'index.js'), 'real', 'utf-8');
    const sha = sha256OfDir(pkgDir);
    writeInstalledManifestEntry('@massu/adapter-rails', {
      version: '0.1.0',
      installed_sha256: sha,
      manifest_sha256: sha,
      ts: '2026-05-07T00:00:00Z',
    }, sidecarPath);
    const result = verifyInstalledIntegrity('@massu/adapter-rails', pkgDir, sidecarPath);
    expect(result.kind).toBe('ok');
  });

  it('no-entry when package not in sidecar', () => {
    writeFileSync(join(pkgDir, 'index.js'), 'real', 'utf-8');
    const result = verifyInstalledIntegrity('@massu/adapter-unknown', pkgDir, sidecarPath);
    expect(result.kind).toBe('no-entry');
    if (result.kind === 'no-entry') {
      expect(result.reason).toMatch(/run.*adapters install/i);
    }
  });

  it('drift when contents change after install', () => {
    writeFileSync(join(pkgDir, 'index.js'), 'real', 'utf-8');
    const sha = sha256OfDir(pkgDir);
    writeInstalledManifestEntry('@massu/adapter-rails', {
      version: '0.1.0',
      installed_sha256: sha,
      manifest_sha256: sha,
      ts: '2026-05-07T00:00:00Z',
    }, sidecarPath);
    // Tamper with the package after install.
    writeFileSync(join(pkgDir, 'index.js'), 'tampered', 'utf-8');
    const result = verifyInstalledIntegrity('@massu/adapter-rails', pkgDir, sidecarPath);
    expect(result.kind).toBe('drift');
    if (result.kind === 'drift') {
      expect(result.reason).toMatch(/contents changed after install/i);
      expect(result.reason).toMatch(/npm uninstall|npm install/);
    }
  });
});
