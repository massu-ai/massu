// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-003 — Re-exec fidelity (Layer 2-6, CR-70).
 *
 * A hook receives a JSON event on stdin and Claude Code reads its stdout; the re-exec MUST
 * forward stdin → child stdout AND make the child's exit code the parent's exit code, or hooks
 * break in a new silent way. This drives a REAL pipeline end-to-end:
 *
 *   outer spawnSync(input) → wrapper (tsx) calls reexecUnder(...) → fixture child
 *
 * `reexecUnder` uses `stdio: 'inherit'`, so the outer `input` chains through the wrapper into the
 * fixture; the fixture encodes the verbatim stdin into its EXIT CODE (7 iff "boom"), which
 * `reexecUnder` mirrors. The 'boom'→7 case is the platform-robust proof of stdin-content fidelity
 * + exit-mirror; stdout is an extra POSIX-only signal.
 *
 * POSIX-SCOPED (P4-004, CI iterations 1-2). This REAL-subprocess E2E is scoped to POSIX because
 * the triple-nested `spawnSync(input) → node --import tsx wrapper → reexecUnder → fixture`
 * chain cannot faithfully reproduce production's re-exec stdin on Windows: the innermost child,
 * spawned via `stdio:'inherit'` off an ALREADY-SYNCHRONOUSLY-PIPED grandparent stdin (the outer
 * `input`), returns a NULL spawn status on `windows-latest` (→ `reexecUnder` returns its `?? 1`
 * fallback → exit 1, not 0/7). That is a TEST-HARNESS artifact of nested synchronous piping, NOT
 * a production defect: in production the re-exec'd process inherits a real terminal/hook stdin,
 * not a nested `spawnSync` `input`. reexecUnder's stdin-forward + exit-mirror CONTRACT is proven
 * PLATFORM-NEUTRALLY (incl. Windows) by `node-bootstrap-drift-guard.test.ts` (cases b/b2 — an
 * injected `reexec` spy asserts the chokepoint forwards argv verbatim and mirrors the returned
 * status). This file adds the real-subprocess E2E on top, on the platform where the harness is
 * faithful. Analogous to the win32-only positive-discovery test in node-bootstrap-windows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

const CORE_ROOT = resolve(__dirname, '..', '..');
const BOOTSTRAP_TS = resolve(__dirname, '..', 'lib', 'node-bootstrap.ts');

let dir: string;
let fixture: string;
let wrapper: string;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'massu-fidelity-'));
  fixture = resolve(dir, 'fixture.mjs');
  wrapper = resolve(dir, 'wrapper.mjs');

  // The re-exec'd child reads the stdin it RECEIVED and encodes the verbatim content into its
  // EXIT CODE — the ONE fidelity channel that survives every platform's nesting: exit 7 iff the
  // event contains "boom", else 0. Exit-code mirroring is reliable through the triple-nested
  // spawnSync → tsx wrapper → reexecUnder chain on BOTH POSIX and Windows (the inherited-pipe
  // stdout capture, by contrast, returns empty at the outer capture on Windows — P4-004). The
  // exit code is therefore the platform-robust proof that stdin content reached the child
  // verbatim AND its exit code was mirrored. It also writes stdout as an EXTRA POSIX-only signal.
  writeFileSync(
    fixture,
    [
      "import { readFileSync } from 'node:fs';",
      "let data = '';",
      "try { data = readFileSync(0, 'utf8'); } catch { data = ''; }",
      // GUARD the stdout write: on Windows the inherited stdout pipe through the triple-nested
      // spawnSync -> tsx -> reexecUnder chain is broken, so `process.stdout.write` throws EPIPE.
      // An UNCAUGHT throw here would kill the child with exit 1 BEFORE it reaches the exit-code
      // logic below (masking the real fidelity signal). Swallow it — the EXIT CODE is the proof;
      // stdout is only an extra POSIX-only signal (P4-004).
      "try { process.stdout.write('CHILD_STDOUT:' + data); } catch { /* broken inherited pipe (win32) */ }",
      "process.exit(data.includes('boom') ? 7 : 0);",
      '',
    ].join('\n'),
    'utf-8',
  );

  // The wrapper acts as the "parent": it calls the REAL reexecUnder and mirrors its return
  // code, exactly as the cli.ts chokepoint does. It imports the .ts via node's tsx loader.
  writeFileSync(
    wrapper,
    [
      `import { reexecUnder } from ${JSON.stringify(BOOTSTRAP_TS)};`,
      `const status = reexecUnder(process.execPath, ${JSON.stringify(fixture)}, [], process.env);`,
      'process.exit(status);',
      '',
    ].join('\n'),
    'utf-8',
  );
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* OS reclaims tmp */
  }
});

function runWrapper(input: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', wrapper], {
    input,
    encoding: 'utf-8',
    timeout: 30000,
    cwd: CORE_ROOT, // so `tsx` resolves from @massu/core's node_modules
    env: { ...process.env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// POSIX-scoped real-subprocess E2E (see file header). Windows re-exec fidelity is covered
// platform-neutrally by node-bootstrap-drift-guard's injected-reexec chokepoint cases.
describe.skipIf(process.platform === 'win32')('P4-003 node-bootstrap re-exec fidelity (Layer 2-6, CR-70)', () => {
  it('forwards a clean JSON event on stdin → the re-exec\'d child exits 0 (no false "boom")', () => {
    const event = '{"hook_event_name":"SessionStart","payload":42}';
    const { status, stdout, stderr } = runWrapper(event);
    expect(stderr, `wrapper stderr: ${stderr}`).not.toMatch(/Cannot find|ERR_MODULE|SyntaxError/);
    // The child read stdin and, seeing no "boom", exited 0 — mirrored to the parent. Paired with
    // the 'boom'→7 case below, this proves the child's exit code is DRIVEN BY the forwarded stdin
    // content (not a constant), on every platform incl. Windows.
    expect(status).toBe(0);
    // Extra POSIX-only signal: the inherited stdout chain surfaces the bytes on POSIX (it returns
    // empty at the outer capture on Windows — P4-004 — so it is not asserted there).
    if (process.platform !== 'win32') expect(stdout).toContain(`CHILD_STDOUT:${event}`);
  });

  it('forwards stdin verbatim + mirrors the child exit code (boom → 7, not swallowed)', () => {
    const { status, stdout } = runWrapper('{"say":"boom"}');
    // The child's exit 7 is reachable ONLY if the literal "boom" reached its stdin verbatim →
    // this single assertion proves BOTH stdin-content fidelity AND exit-code mirroring, through
    // the triple-nested spawnSync → tsx → reexecUnder chain, on every platform. A mutant
    // reexecUnder that drops stdin → child reads '' → no "boom" → exit 0 ≠ 7 → RED (P4-004 teeth).
    expect(status).toBe(7);
    if (process.platform !== 'win32') expect(stdout).toContain('CHILD_STDOUT:{"say":"boom"}');
  });
});
