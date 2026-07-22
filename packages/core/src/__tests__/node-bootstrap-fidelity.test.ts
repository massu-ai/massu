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
 * `reexecUnder` uses `stdio: 'inherit'`, so the outer `input` chains through the wrapper into
 * the fixture, and the fixture's stdout chains back out to the outer capture. We assert the
 * JSON event arrives verbatim at the child's stdin and the child's exit code surfaces.
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

  // The re-exec'd child: echo stdin to stdout verbatim, exit 7 iff the event says "boom".
  writeFileSync(
    fixture,
    [
      "import { readFileSync } from 'node:fs';",
      "let data = '';",
      "try { data = readFileSync(0, 'utf8'); } catch { data = ''; }",
      "process.stdout.write('CHILD_STDOUT:' + data);",
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

describe('P4-003 node-bootstrap re-exec fidelity (Layer 2-6, CR-70)', () => {
  it('forwards a JSON event on stdin verbatim to the re-exec\'d child\'s stdout', () => {
    const event = '{"hook_event_name":"SessionStart","payload":42}';
    const { status, stdout, stderr } = runWrapper(event);
    expect(stderr, `wrapper stderr: ${stderr}`).not.toMatch(/Cannot find|ERR_MODULE|SyntaxError/);
    expect(stdout).toContain(`CHILD_STDOUT:${event}`);
    expect(status).toBe(0);
  });

  it('makes the child exit code the parent exit code (non-zero is NOT swallowed)', () => {
    const { status, stdout } = runWrapper('{"say":"boom"}');
    expect(stdout).toContain('CHILD_STDOUT:{"say":"boom"}');
    expect(status).toBe(7);
  });
});
