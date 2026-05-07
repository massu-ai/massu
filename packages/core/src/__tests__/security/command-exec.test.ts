// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Plan 3b — Phase 3.5 Surface 4: Config-driven command execution.
 *
 * Vectors covered:
 *   - Shell-metachar injection: argv array form prevents shell expansion (F-013)
 *   - PATH-poisoning: refuse non-absolute argv[0] unless explicitly opted in
 *   - `..` traversal: refuse argv elements containing ".."
 *   - NUL-byte injection in argv (F-013b)
 *   - Environment hardening: spawned LSP gets a minimal env, not parent env
 *
 * Tests do not actually launch real LSPs — they assert the validation
 * branch and inspect spawn options via the source code. The actual
 * argv-to-spawn round-trip (without shell) is observable when fromCommand
 * passes validation: the failure surface narrows to ENOENT (no such
 * binary), proving validation accepted but no shell evaluation occurred.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LSPClient,
  LspBinaryIsSetuidError,
  _detectSetuid,
  _probeChildRssMb,
  _startRssWatchdog,
  LSP_WATCHDOG_OVERBUDGET_SAMPLES,
} from '../../lsp/client.ts';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawn, type ChildProcess } from 'child_process';

// ============================================================
// F-013: shell-metachar / argv array form
// ============================================================

describe('Cmd exec — argv array form prevents shell injection (F-013)', () => {
  it('shell metachars in argv element are treated as a literal — never expanded', () => {
    // The argv array form means `;`, `&&`, backticks, `$()` are kernel-
    // level argv strings, not shell tokens. The kernel has no shell. The
    // factory MUST NOT reject these (they may be legitimate filenames),
    // but it MUST also not invoke a shell.
    let validationError: string | null = null;
    try {
      const client = LSPClient.fromCommand({
        language: 'python',
        argv: ['/usr/bin/echo', ';', 'rm', '-rf', '~'],
        // We intentionally use /usr/bin/echo (real binary) so spawn
        // succeeds. The point is: rm -rf is NOT executed because there
        // is no shell.
      });
      void client.shutdown();
    } catch (e) {
      validationError = e instanceof Error ? e.message : String(e);
    }
    // Validation should NOT fire on metachars in non-argv[0] positions.
    expect(validationError).toBeNull();
  });

  it('source code never passes shell:true to spawn', () => {
    const src = readFileSync(
      resolve(__dirname, '../../lsp/client.ts'),
      'utf-8',
    );
    // Strip comment lines so commentary like "Explicitly NO `shell: true`"
    // doesn't trigger a false positive.
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
      .join('\n');
    expect(codeOnly).not.toMatch(/shell\s*:\s*true/);
    // Verify explicit `shell: false` is present in code.
    expect(codeOnly).toMatch(/shell\s*:\s*false/);
  });
});

// ============================================================
// PATH-poisoning: non-absolute argv[0] rejection
// ============================================================

describe('Cmd exec — refuses non-absolute argv[0] by default (PATH poisoning)', () => {
  it('relative path "pyright-langserver" is rejected', () => {
    expect(() =>
      LSPClient.fromCommand({
        language: 'python',
        argv: ['pyright-langserver', '--stdio'],
      }),
    ).toThrow(/non-absolute/);
  });

  it('absolute path is accepted', () => {
    // Won't actually spawn anything — we just want to verify no validation
    // throw. The /usr/bin/false-style path may or may not exist; we only
    // care about the validation gate.
    let validationThrew: string | null = null;
    try {
      const client = LSPClient.fromCommand({
        language: 'python',
        argv: ['/usr/bin/totally-not-real-binary', '--stdio'],
      });
      void client.shutdown();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/non-absolute|refused/.test(msg)) validationThrew = msg;
    }
    expect(validationThrew).toBeNull();
  });

  it('relative path is allowed when allowRelativePath: true (explicit opt-in)', () => {
    let validationThrew: string | null = null;
    try {
      const client = LSPClient.fromCommand({
        language: 'python',
        argv: ['pyright-langserver', '--stdio'],
        allowRelativePath: true,
      });
      void client.shutdown();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/non-absolute|refused/.test(msg)) validationThrew = msg;
    }
    expect(validationThrew).toBeNull();
  });
});

// ============================================================
// `..` traversal rejection
// ============================================================

describe('Cmd exec — refuses ".." in any argv element', () => {
  it('refuses argv[0] containing ".."', () => {
    expect(() =>
      LSPClient.fromCommand({
        language: 'python',
        argv: ['/usr/bin/../etc/passwd-fake-binary'],
      }),
    ).toThrow(/refused argv element containing/);
  });

  it('refuses argv[N] containing ".."', () => {
    expect(() =>
      LSPClient.fromCommand({
        language: 'python',
        argv: ['/usr/bin/pyright', '--root=../../../../etc'],
      }),
    ).toThrow(/refused argv element containing/);
  });

  it('refuses ".." even when bundled with allowRelativePath', () => {
    expect(() =>
      LSPClient.fromCommand({
        language: 'python',
        argv: ['../foo/bar'],
        allowRelativePath: true,
      }),
    ).toThrow(/refused argv element containing/);
  });
});

// ============================================================
// F-013b: NUL byte injection
// ============================================================

describe('Cmd exec — NUL byte injection in argv (F-013b)', () => {
  it('refuses argv[0] containing NUL byte', () => {
    expect(() =>
      LSPClient.fromCommand({
        language: 'python',
        argv: ['/usr/bin/pyright\0/etc/passwd'],
      }),
    ).toThrow(/NUL byte/);
  });

  it('refuses argv[N] containing NUL byte', () => {
    expect(() =>
      LSPClient.fromCommand({
        language: 'python',
        argv: ['/usr/bin/pyright', 'arg-with-NUL\0evil'],
      }),
    ).toThrow(/NUL byte/);
  });
});

// ============================================================
// Environment hardening
// ============================================================

describe('Cmd exec — spawned process gets minimal env, not parent env (F-013c)', () => {
  it('source code passes a minimal env (PATH/HOME/LANG only) to spawn', () => {
    const src = readFileSync(
      resolve(__dirname, '../../lsp/client.ts'),
      'utf-8',
    );
    // Verify the env-hardening block is present in fromCommand.
    expect(src).toMatch(/env:\s*\{/);
    expect(src).toMatch(/PATH:\s*process\.env\.PATH/);
    // Critically, no `env: process.env` (which would carry secrets).
    expect(src).not.toMatch(/env:\s*process\.env\b/);
  });
});

// ============================================================
// Empty argv rejection
// ============================================================

describe('Cmd exec — empty argv rejected', () => {
  it('refuses empty array', () => {
    expect(() =>
      LSPClient.fromCommand({ language: 'python', argv: [] }),
    ).toThrow(/non-empty array/);
  });

  it('refuses argv[0] empty string', () => {
    expect(() =>
      LSPClient.fromCommand({ language: 'python', argv: [''] }),
    ).toThrow(/non-empty/);
  });
});

// ============================================================
// Type rejection: non-string argv elements
// ============================================================

describe('Cmd exec — type-confusion rejection', () => {
  it('refuses non-string argv elements', () => {
    expect(() =>
      LSPClient.fromCommand({
        language: 'python',
        argv: ['/usr/bin/pyright', 42 as unknown as string],
      }),
    ).toThrow(/must be a string/);
  });
});

// ============================================================
// F-014 — SUID/SGID binary detection (closed 2026-05-06)
// ============================================================

describe('Cmd exec — SUID binary refusal (F-014)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'massu-suid-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('_detectSetuid returns hasSetuid=true for a SUID-bit file', () => {
    const path = join(dir, 'fake-suid');
    writeFileSync(path, '#!/bin/sh\necho ok\n');
    chmodSync(path, 0o4755); // -rwsr-xr-x
    const det = _detectSetuid(path);
    expect(det).not.toBeNull();
    expect(det!.hasSetuid).toBe(true);
    expect((det!.mode & 0o4000) !== 0).toBe(true);
  });

  it('_detectSetuid returns hasSetuid=true for a SGID-bit file', () => {
    const path = join(dir, 'fake-sgid');
    writeFileSync(path, '#!/bin/sh\necho ok\n');
    chmodSync(path, 0o2755); // -rwxr-sr-x
    const det = _detectSetuid(path);
    expect(det).not.toBeNull();
    expect(det!.hasSetuid).toBe(true);
  });

  it('_detectSetuid returns hasSetuid=false for a regular executable', () => {
    const path = join(dir, 'normal');
    writeFileSync(path, '#!/bin/sh\necho ok\n');
    chmodSync(path, 0o755);
    const det = _detectSetuid(path);
    expect(det).not.toBeNull();
    expect(det!.hasSetuid).toBe(false);
  });

  it('_detectSetuid follows symlinks to detect SUID on the target', () => {
    const real = join(dir, 'real-suid');
    const link = join(dir, 'link-to-suid');
    writeFileSync(real, '#!/bin/sh\necho ok\n');
    chmodSync(real, 0o4755);
    symlinkSync(real, link);
    const det = _detectSetuid(link);
    expect(det).not.toBeNull();
    expect(det!.hasSetuid).toBe(true);
    // macOS resolves /var/folders → /private/var/folders via realpath; Linux
    // doesn't have that quirk. Compare via realpath to handle both.
    expect(det!.resolvedPath).toBe(realpathSync(real));
  });

  it('_detectSetuid returns null for a missing file (no crash)', () => {
    expect(_detectSetuid(join(dir, 'does-not-exist'))).toBeNull();
  });

  it('LSPClient.fromCommand throws LspBinaryIsSetuidError when argv[0] is SUID', () => {
    const path = join(dir, 'evil-suid');
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o4755);
    expect(() =>
      LSPClient.fromCommand({ language: 'python', argv: [path] }),
    ).toThrow(LspBinaryIsSetuidError);
  });

  it('LSPClient.fromCommand allows SUID when allowSetuid: true is opted in', () => {
    const path = join(dir, 'opted-in-suid');
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o4755);
    // Spawn will succeed (or fail with ENOENT-style error from the child).
    // Critical: the SUID check must NOT throw. We catch any post-validation
    // error and only fail the test if LspBinaryIsSetuidError is thrown.
    let suidErr: unknown = null;
    try {
      const client = LSPClient.fromCommand({
        language: 'python',
        argv: [path],
        allowSetuid: true,
      });
      // Best-effort cleanup; not load-bearing for the assertion.
      try { (client as unknown as { transport?: { close?: () => void } }).transport?.close?.(); } catch { /* ignore */ }
    } catch (e) {
      if (e instanceof LspBinaryIsSetuidError) suidErr = e;
    }
    expect(suidErr).toBeNull();
  });

  it('LspBinaryIsSetuidError exposes path + mode for actionable error messages', () => {
    const err = new LspBinaryIsSetuidError('/usr/bin/passwd', 0o4755);
    expect(err.path).toBe('/usr/bin/passwd');
    expect(err.mode).toBe(0o4755);
    expect(err.message).toContain('SUID');
    expect(err.message).toContain('/usr/bin/passwd');
    expect(err.message).toContain('allowSetuid: true');
  });
});

// ============================================================
// F-015 — RSS watchdog (closed 2026-05-06)
// ============================================================

describe('Cmd exec — RSS watchdog kills sustained over-budget LSP (F-015)', () => {
  it('_probeChildRssMb returns a positive number for a real running process', () => {
    // Use the current Node process — guaranteed to exist and have RSS.
    const rss = _probeChildRssMb(process.pid);
    expect(rss).not.toBeNull();
    expect(rss!).toBeGreaterThan(0);
  });

  it('_probeChildRssMb returns null for a non-existent pid', () => {
    // PID 999999 is extremely unlikely to exist on a test runner.
    const rss = _probeChildRssMb(999_999);
    expect(rss).toBeNull();
  });

  it('_startRssWatchdog with maxRssMb=0 is a no-op (returns inert handle)', () => {
    // Use a fake child shape that the watchdog won't actually touch.
    const fakeChild = { pid: process.pid, killed: false, exitCode: null, kill: () => true } as unknown as ChildProcess;
    const wd = _startRssWatchdog(fakeChild, 'python', 0);
    expect(typeof wd.stop).toBe('function');
    wd.stop(); // safe to call even when disabled
  });

  it('_startRssWatchdog kills child after LSP_WATCHDOG_OVERBUDGET_SAMPLES consecutive over-budget samples', async () => {
    // Spawn a real long-running child so the watchdog has a real PID + ChildProcess to track.
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    expect(child.pid).toBeGreaterThan(0);

    let killed = false;
    child.once('exit', () => { killed = true; });

    // maxRssMb=0.001 (1 KB) guarantees over-budget on EVERY sample;
    // intervalMs=50 makes the test fast.
    const wd = _startRssWatchdog(child, 'python-test', 0.001, 50);

    // Wait for OVERBUDGET_SAMPLES * intervalMs + slop.
    await new Promise((r) => setTimeout(r, 50 * (LSP_WATCHDOG_OVERBUDGET_SAMPLES + 2) + 200));

    wd.stop();
    expect(killed).toBe(true);
  }, 5_000);

  it('_startRssWatchdog does NOT kill when RSS stays under budget', async () => {
    const child = spawn('sleep', ['2'], { stdio: 'ignore' });
    expect(child.pid).toBeGreaterThan(0);

    let killedBySignal = false;
    child.once('exit', (_code, signal) => {
      if (signal === 'SIGKILL') killedBySignal = true;
    });

    // maxRssMb=10000 (10 GB) is wildly above any real Node child.
    const wd = _startRssWatchdog(child, 'python-test', 10_000, 50);

    // Wait for several sample intervals. Watchdog should NOT trigger.
    await new Promise((r) => setTimeout(r, 50 * (LSP_WATCHDOG_OVERBUDGET_SAMPLES + 2) + 200));

    wd.stop();
    // Process exits naturally on its own from `sleep 2`, but NOT via SIGKILL.
    try { child.kill(); } catch { /* clean up if still alive */ }
    expect(killedBySignal).toBe(false);
  }, 5_000);
});
