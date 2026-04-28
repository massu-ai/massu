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

import { describe, expect, it } from 'vitest';
import { LSPClient } from '../../lsp/client.ts';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
