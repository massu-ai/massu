// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * A hook bundle runs exactly ONE main().
 *
 * `isDirectInvocation(import.meta.url)` cannot tell modules apart inside an esbuild bundle:
 * every bundled module's import.meta.url is the bundle's own URL, which IS argv[1]. So a hook
 * that imported another hook's entry file ran that hook's main() too. pre-tool-use-gate.js ran
 * security-gate's and pre-delete-check's; classify-failure.js ran fix-detector's. Each extra
 * main() was a second stdin reader with a 400 ms cut-off: under load it parsed a truncated
 * payload and DENIED a legitimate Bash call ("Unexpected end of JSON input", eko on 2.5.3,
 * 2026-11-09), and an identical retry passed. Occurrence #2 of "importing a hook ran it"
 * (#1: 215a8b7c, which added isDirectInvocation — correct for unbundled modules only).
 *
 * The fix makes the shape impossible rather than guarded: shared checks live in hooks/lib/,
 * and no hook entry imports another. Both halves are pinned here: the import graph (derived
 * from the tree, so a 19th hook is covered on its first commit) and the BUILT artifact under
 * the exact timing that failed.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(CORE, 'src', 'hooks');

const entries = readdirSync(HOOKS).filter((f) => f.endsWith('.ts'))
  .filter((f) => /isDirectInvocation\(import\.meta\.url\)/.test(readFileSync(join(HOOKS, f), 'utf-8')));

describe('hook entries', () => {
  it('discovered the hook entry files (a zero scope would pass vacuously)', () => {
    expect(entries.length).toBeGreaterThanOrEqual(15);
  });

  it('no hook module imports a hook entry (shared code lives in hooks/lib/)', () => {
    // Every import FORM bundles the entry and so runs its main(): `from`, a bare side-effect
    // `import '...'`, a dynamic `import('...')`, with or without `.ts`, either quote. And the
    // importer can be any module the bundle reaches, including hooks/lib/ (2026-11-09: the
    // first version matched only `from './x.ts'` and stayed green on a bare import).
    const modules = [
      ...readdirSync(HOOKS).filter((f) => f.endsWith('.ts')).map((f) => join(HOOKS, f)),
      ...readdirSync(join(HOOKS, 'lib')).filter((f) => f.endsWith('.ts')).map((f) => join(HOOKS, 'lib', f)),
    ];
    const entryPaths = new Set(entries.map((f) => join(HOOKS, f)));
    const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    const offenders: string[] = [];
    let specifiers = 0;
    for (const file of modules) {
      for (const m of readFileSync(file, 'utf-8').matchAll(SPEC)) {
        specifiers += 1;
        const target = join(dirname(file), m[1].endsWith('.ts') ? m[1] : `${m[1]}.ts`);
        if (entryPaths.has(target) && target !== file) offenders.push(`${file.slice(HOOKS.length + 1)} imports ${m[1]}`);
      }
    }
    expect(specifiers, 'read no relative imports at all — the scan is blind').toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});

describe('the built pre-tool-use-gate under a slow stdin', () => {
  it('a valid payload that arrives in two halves 700 ms apart is ALLOWED, not denied', async () => {
    const bundle = join(CORE, 'dist', 'hooks', 'pre-tool-use-gate.js');
    expect(existsSync(bundle), `${bundle} missing — run npm run build:hooks`).toBe(true);
    const payload = JSON.stringify({
      session_id: 'slow-stdin', hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: CORE,
      tool_input: { command: "sed -n '1,20p' README.md" },
    });
    const child = spawn(process.execPath, [bundle], { cwd: CORE, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const done = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));
    await writeInTwoParts(child.stdin, payload, 700);
    const code = await done;
    expect(err).not.toContain('could not evaluate');
    expect(code, err).toBe(0);
  });
});

/**
 * The STIMULUS, not a budget: the payload arrives as a 40-byte head, then the rest after
 * `gapMs`. Nothing asserts on how long anything took. With the fix the gate reads to EOF and
 * allows the call for ANY gap; with the bug, the bundled security-gate main() gave up at 400 ms,
 * so any gap above that denied it. A slower host only lengthens the gap, which cannot turn the
 * fixed code red.
 */
async function writeInTwoParts(stdin: NodeJS.WritableStream, payload: string, gapMs: number): Promise<void> {
  stdin.write(payload.slice(0, 40));
  await new Promise((r) => setTimeout(r, gapMs));
  stdin.end(payload.slice(40));
}
