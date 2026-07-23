// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-001 — Windows Layer-2 bootstrap drift-guard (CR-70 Windows parity, Layer 2-W).
 *
 * The shipped 2.1.0 launcher auto-recovers a sub-floor Node ONLY on Unix. This suite locks the
 * win32 discovery branch added by P2-000..P2-004:
 *   (a) win32 allowlist = only absolute `…\node.exe` under install roots, NEVER read from PATH/Path
 *   (b) win32 acceptance = fully-qualified drive/UNC only; rejects relative / drive-relative / bare
 *   (c) `\`-separated Windows patterns expand (P2-003 separator generalization)
 *   (d) win32 trust gate = containment under an allowlist root (the POSIX-uid analogue)
 *   (e) win32 + none-found → loud fail, never a silent crash
 *   (f) UNIX-UNCHANGED SNAPSHOT: with `platform='linux'` the allowlist + acceptance are byte-
 *       identical to the pre-change POSIX behaviour (§3 U-1 regression proof)
 *
 * ALL cases are platform-injected via the P2-000 `platform` param + a synthetic `env`, so they run
 * on ANY host (POSIX local + the real windows-latest CI leg). The end-to-end POSITIVE discovery of
 * an installed Node is proven on the Windows CI leg (guarded case at the bottom) — a `C:\` path
 * cannot exist on a POSIX FS, so it is asserted where a real one does.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import {
  allowlistPatterns,
  isAcceptedCandidatePath,
  isWindowsTrusted,
  expandSingleStarGlob,
  discoverCompatibleNode,
  bootstrapNodeOrExit,
} from '../lib/node-bootstrap.ts';
import { MIN_NODE_MAJOR, MIN_NODE_MINOR } from '../preflight.ts';

const BELOW_FLOOR = `v${MIN_NODE_MAJOR - 1}.0.0`;

// A realistic synthetic Windows env (never touched: PATH/Path — see case (a)).
const WIN_ENV: NodeJS.ProcessEnv = {
  USERPROFILE: 'C:\\Users\\dev',
  NVM_HOME: 'C:\\Users\\dev\\AppData\\Roaming\\nvm',
  NVM_SYMLINK: 'C:\\Program Files\\nodejs',
  APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  VOLTA_HOME: 'C:\\Users\\dev\\AppData\\Local\\Volta',
  // Deliberately hostile PATH/Path — discovery MUST NOT read either.
  PATH: 'C:\\hostile-path\\bin',
  Path: 'C:\\hostile-Path\\bin',
};

describe('P4-001 Windows Layer-2 bootstrap (CR-70 Windows parity)', () => {
  it('(a) win32 allowlist: every pattern is an absolute `…\\node.exe`, none from PATH/Path', () => {
    const patterns = allowlistPatterns(WIN_ENV, 'win32');
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(p.toLowerCase().endsWith('node.exe')).toBe(true);
      // Absolute drive-letter root (patterns may carry a single `*` version segment).
      expect(/^[A-Za-z]:\\/.test(p)).toBe(true);
      // NEVER derived from the hostile PATH / Path.
      expect(p.includes('hostile')).toBe(false);
    }
    // System MSI / winget / choco all land here — must always be present.
    expect(patterns).toContain('C:\\Program Files\\nodejs\\node.exe');
    expect(patterns).toContain('C:\\Program Files (x86)\\nodejs\\node.exe');
    // nvm-windows + fnm(APPDATA fallback) + volta + scoop are emitted from their pointers.
    expect(patterns.some((p) => p.includes('\\nvm\\v*\\node.exe'))).toBe(true);
    expect(patterns.some((p) => p.includes('\\fnm\\node-versions\\v*\\installation\\node.exe'))).toBe(true);
    expect(patterns.some((p) => p.includes('\\Volta\\tools\\image\\node\\*\\node.exe'))).toBe(true);
    expect(patterns.some((p) => p.includes('\\scoop\\apps\\nodejs\\current\\node.exe'))).toBe(true);
  });

  it('(a2) win32 allowlist with an EMPTY env still emits the absolute system roots only', () => {
    const patterns = allowlistPatterns({}, 'win32');
    expect(patterns).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
    ]);
  });

  it('(a3) win32 allowlist NEVER reads env.PATH / env.Path (only a hostile PATH set)', () => {
    const patterns = allowlistPatterns(
      { PATH: 'C:\\evil\\a', Path: 'C:\\evil\\b' } as NodeJS.ProcessEnv,
      'win32',
    );
    for (const p of patterns) expect(p.includes('evil')).toBe(false);
  });

  it('(b) win32 acceptance: accepts drive-letter + UNC absolutes, rejects relative/drive-relative/bare', () => {
    // Accepted — fully-qualified.
    expect(isAcceptedCandidatePath('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(true);
    expect(isAcceptedCandidatePath('C:/Users/dev/node.exe', 'win32')).toBe(true); // fwd-slash join
    expect(isAcceptedCandidatePath('\\\\server\\share\\node.exe', 'win32')).toBe(true); // UNC
    // Rejected — not fully-qualified.
    expect(isAcceptedCandidatePath('node.exe', 'win32')).toBe(false); // bare (where.exe-style)
    expect(isAcceptedCandidatePath('.\\node.exe', 'win32')).toBe(false); // relative
    expect(isAcceptedCandidatePath('..\\node.exe', 'win32')).toBe(false); // relative
    expect(isAcceptedCandidatePath('C:node.exe', 'win32')).toBe(false); // drive-RELATIVE (W-8)
    // A POSIX-rooted path is NOT a valid win32 candidate.
    expect(isAcceptedCandidatePath('/usr/local/bin/node', 'win32')).toBe(false);
  });

  it('(c) glob expander handles `\\`-separated Windows patterns (P2-003)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'massu-win-glob-'));
    mkdirSync(resolve(dir, 'v18'));
    writeFileSync(resolve(dir, 'v18', 'node.exe'), '');
    // A backslash-separated pattern (Windows shape) rooted at the real temp dir must expand.
    const pattern = `${dir}\\v*\\node.exe`;
    const out = expandSingleStarGlob(pattern);
    expect(out).toHaveLength(1);
    expect(out[0].endsWith('v18/node.exe')).toBe(true);
    // A forward-slash pattern at the same dir expands identically (superset property).
    expect(expandSingleStarGlob(`${dir}/v*/node.exe`)).toHaveLength(1);
  });

  it('(d) win32 trust gate: contained-under-root → trusted; outside every root → NOT trusted', () => {
    const env: NodeJS.ProcessEnv = {
      USERPROFILE: 'C:\\Users\\dev',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    };
    // scoop under %USERPROFILE% — the documented residual (runs-as-you) bar.
    expect(isWindowsTrusted('C:\\Users\\dev\\scoop\\apps\\nodejs\\current\\node.exe', env)).toBe(true);
    // System MSI root is always trusted.
    expect(isWindowsTrusted('C:\\Program Files\\nodejs\\node.exe', env)).toBe(true);
    // Outside every allowlist root → rejected before probe.
    expect(isWindowsTrusted('C:\\Windows\\Temp\\evil\\node.exe', env)).toBe(false);
    expect(isWindowsTrusted('D:\\random\\node.exe', {})).toBe(false);
    // A prefix-collision must NOT pass (…\nodejs-evil is not under …\nodejs).
    expect(isWindowsTrusted('C:\\Program Files\\nodejs-evil\\node.exe', {})).toBe(false);
    // Case-insensitive containment (Windows paths are case-insensitive): a differently-cased but
    // VALID pointer must still be trusted, else auto-recovery silently degrades to loud-fail.
    expect(isWindowsTrusted('c:\\users\\dev\\SCOOP\\apps\\nodejs\\current\\NODE.EXE', env)).toBe(true);
  });

  it('(e) win32 + sub-floor + none found → loud fail (exit≠0), never a silent crash', () => {
    // Point every win root at a nonexistent dir → win32 discovery finds nothing.
    const env: NodeJS.ProcessEnv = { USERPROFILE: 'C:\\Users\\nobody-xyz' };
    expect(discoverCompatibleNode(env, 'win32')).toBeNull();

    let exitCode: number | null = null;
    let stderr = '';
    bootstrapNodeOrExit([], env, {
      nodeVersion: BELOW_FLOOR,
      discover: (e) => discoverCompatibleNode(e, 'win32'),
      stderr: (m) => {
        stderr += m;
      },
      exit: (c) => {
        exitCode = c;
      },
    });
    expect(exitCode).toBe(1);
    expect(exitCode).not.toBe(0);
    // The floor requirement statement is always present (the win32-specific winget line is proven
    // on the windows-latest CI leg — writeLoudRemedy reads the process.platform global, C-2).
    expect(stderr).toMatch(new RegExp(`${MIN_NODE_MAJOR}\\.${MIN_NODE_MINOR}\\.0`));
  });

  // (f) UNIX-UNCHANGED SNAPSHOT — the POSIX branch is byte-for-byte identical after the platform
  // branch. A diff to either assertion is a failing gate (§3 U-1).
  it('(f) linux allowlist snapshot is byte-identical to the pre-change POSIX list', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/fix' }; // no manager pointers → default layout
    expect(allowlistPatterns(env, 'linux')).toEqual([
      '/home/fix/.nvm/versions/node/*/bin/node',
      '/home/fix/.local/share/fnm/node-versions/*/installation/bin/node',
      '/home/fix/.volta/tools/image/node/*/bin/node',
      '/home/fix/.asdf/installs/nodejs/*/bin/node',
      '/home/fix/n/bin/node',
      '/opt/homebrew/opt/node@*/bin/node',
      '/usr/local/opt/node@*/bin/node',
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    ]);
  });

  it('(f2) linux acceptance predicate is the exact `startsWith("/")` rule', () => {
    expect(isAcceptedCandidatePath('/usr/local/bin/node', 'linux')).toBe(true);
    expect(isAcceptedCandidatePath('relative/node', 'linux')).toBe(false);
    expect(isAcceptedCandidatePath('C:\\x\\node.exe', 'linux')).toBe(false); // not `/`-rooted
  });

  // POSITIVE end-to-end discovery (L2-W-1) — only meaningful on a REAL Windows host (a `C:\…\node.exe`
  // must be a real, probe-able binary). Runs on the windows-latest CI leg. Plants a DETERMINISTIC
  // real node.exe (a copy of the running Node, guaranteed >= floor on the 22.13.0/latest matrix)
  // under a synthetic scoop allowlist root, so the assertion is UNCONDITIONAL — a broken discovery
  // and a nothing-found host can no longer render identically (architecture review ARCH-1).
  it.skipIf(process.platform !== 'win32')(
    'discovers a planted compatible node.exe under a synthetic allowlist root (unconditional positive)',
    () => {
      const home = mkdtempSync(resolve(tmpdir(), 'massu-win-home-'));
      const nodeDir = resolve(home, 'scoop', 'apps', 'nodejs', 'current');
      mkdirSync(nodeDir, { recursive: true });
      const planted = resolve(nodeDir, 'node.exe');
      copyFileSync(process.execPath, planted); // a real, >= floor Node → probes + passes the floor
      const env: NodeJS.ProcessEnv = { USERPROFILE: home };

      const result = discoverCompatibleNode(env, 'win32');
      expect(result).not.toBeNull();
      expect(isAcceptedCandidatePath(result as string, 'win32')).toBe(true);
      expect(isWindowsTrusted(result as string, env)).toBe(true);
      // Negative control: with the plant removed (empty env), discovery finds nothing here.
      expect(discoverCompatibleNode({ USERPROFILE: 'C:\\Users\\nobody-xyz-unused' }, 'win32')).toBeNull();
    },
  );
});
