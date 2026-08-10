// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard: no runtime `require()` of a TypeScript specifier may re-enter the
 * tree.
 *
 * Closes the class documented in `./helpers/require-ts-specifier-detector.ts`.
 * Three such calls in `hooks-stdout-convention.test.ts` held CI RED in BOTH
 * repos for two days (2026-08-09 -> 2026-08-10) while `npm test` was green on
 * this machine, because the calls only fail below Node 22.18 and CI pins the
 * declared floor 22.16.0.
 *
 * If this regresses tomorrow, THIS goes red — on any Node, because it is a
 * static property of the source rather than a property of the loader.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  findRequireTsSpecifiers,
  type RequireTsHit,
} from './helpers/require-ts-specifier-detector.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Sites where the LAZY form is load-bearing, each with a cited reason.
 *
 * Adding an entry is a RULING that a static import would change behaviour, not
 * a convenience. Measured with esbuild 0.28 (bundle / esm / platform=node):
 * `require()` defers evaluation of the dependency until first call, a static
 * `import` evaluates it at module load. Both resolve to the `.ts` file and
 * neither leaves a runtime `require()` of a path in the bundle.
 */
const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  'packages/core/src/hooks/lib/hook-failure-signal.ts':
    'Channel 3 (the hook_health DB row) is loaded lazily ON PURPOSE so that a ' +
    'module-load failure in memory-db.ts — native binding, ABI mismatch, corrupt ' +
    'file — cannot take down the file and stderr channels above it, which are the ' +
    'ones that have to work. A static import is EAGER (proven: dependency evaluates ' +
    'before the entry module), so converting this site would make the DB the very ' +
    'thing that silences the failure signal. In the shipped artifact esbuild ' +
    'resolves and inlines the call, so the Node floor never sees the specifier; ' +
    'the exposure is limited to source-run environments below Node 22.18, where ' +
    'the call throws into an intentional best-effort catch and channel 3 no-ops.',
});

/** Every tracked TypeScript/JavaScript source file — the authoritative population. */
function trackedSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  const files = out.split('\n').filter(Boolean);
  // M1 — PROVE IT LOOKED. "Scanned 0, found 0" must be a loud error, never a pass.
  if (files.length === 0) {
    throw new Error('git ls-files enumerated 0 source files — refusing to report clean');
  }
  return files.sort();
}

/**
 * This guard's own path. It MUST appear in the swept population.
 *
 * Deliberately not an absolute file-count floor: the pre-push `[14/22] Sync
 * Check` runs the suite in a PARTIAL scratch copy where `git ls-files` returns a
 * legitimately smaller tree. A file that exists in every environment the suite
 * runs in is the honest positive control.
 */
const SELF = 'packages/core/src/__tests__/require-ts-specifier-drift-guard.test.ts';

interface Sweep {
  listed: number;
  parsed: number;
  unreadable: string[];
  hits: RequireTsHit[];
  files: string[];
}

function sweep(): Sweep {
  const files = trackedSources();
  const hits: RequireTsHit[] = [];
  const unreadable: string[] = [];
  let parsed = 0;

  for (const rel of files) {
    let source: string;
    try {
      source = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    } catch (e) {
      // M2 — FAIL CLOSED. An unreadable input is an ERROR, never an empty one.
      unreadable.push(`${rel}: ${(e as Error).message}`);
      continue;
    }
    parsed++;
    for (const h of findRequireTsSpecifiers(rel, source)) hits.push(h);
  }
  return { listed: files.length, parsed, unreadable, hits, files };
}

describe('require()-of-a-TypeScript-specifier drift-guard', () => {
  const report = sweep();
  const DENOMINATOR =
    `listed: ${report.listed}  parsed: ${report.parsed}  ` +
    `unreadable: ${report.unreadable.length}  hits: ${report.hits.length}`;

  it(`reports its denominator and reads every tracked source file [${DENOMINATOR}]`, () => {
    expect(report.unreadable, `unreadable files:\n${report.unreadable.join('\n')}`).toEqual([]);
    expect(report.parsed).toBe(report.listed);
    // A sweep that enumerated almost nothing reports "clean" just as loudly as a
    // healthy one. Positive control: the sweep must have seen ITSELF.
    expect(report.files, `sweep did not include its own file (${SELF})`).toContain(SELF);
  });

  it('no source file calls require() on a .ts/.tsx/.mts/.cts specifier', () => {
    const offending = report.hits.filter((h) => !(h.file in ALLOWLIST));
    const detail = offending.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
    expect(
      offending,
      `${offending.length} runtime require() of a TypeScript specifier:\n${detail}\n\n` +
        'A runtime require() is resolved by the LOADER, not by tsc and not by the vitest\n' +
        'transform. Node only gained require()-of-TypeScript in 22.18; packages/core\n' +
        'declares "node": ">=22.16.0" and CI pins that floor, so such a call passes on a\n' +
        'modern dev machine and throws on every runner:\n' +
        "  SyntaxError: Unexpected identifier 'as'\n\n" +
        "Use a static `import … from './x.ts'` — resolved at transform time, so the Node\n" +
        'floor never sees the specifier.\n\n' +
        'If LAZINESS is genuinely the point (a dependency whose module-load failure must\n' +
        'not take down its caller), add the path to ALLOWLIST here WITH that reason.',
    ).toEqual([]);
  });

  it('every ALLOWLIST entry still matches — a stale exemption is a hole', () => {
    const hitFiles = new Set(report.hits.map((h) => h.file));
    const stale = Object.keys(ALLOWLIST).filter((f) => !hitFiles.has(f));
    expect(
      stale,
      `ALLOWLIST entries that no longer match anything: ${stale.join(', ')}\n` +
        'The site was fixed or deleted. Remove the entry so the exemption cannot silently\n' +
        'cover a future re-introduction at the same path.',
    ).toEqual([]);
  });

  // FIXTURES — one per detection path, each demanded to FIRE, plus the shapes
  // that must stay SILENT. A rule with N paths and fewer fixtures is decoration.
  it('detector fixtures: fires on real calls, silent on prose and strings', () => {
    const fire = (src: string): number => findRequireTsSpecifiers('f.ts', src).length;

    // FIRES: the exact shape that broke CI (destructure + `as` cast, single quotes).
    expect(
      fire("const { HOOK_EVENTS } = require('../hooks/lib/write-hook-message.ts') as { x: 1 };"),
      'single-quoted .ts',
    ).toBe(1);
    // FIRES: double quotes.
    expect(fire('const m = require("./a.ts");'), 'double-quoted .ts').toBe(1);
    // FIRES: whitespace between the paren and the literal.
    expect(fire("const m = require(  './a.ts'  );"), 'padded argument').toBe(1);
    // FIRES: the other TypeScript extensions.
    expect(fire("require('./a.tsx');"), '.tsx').toBe(1);
    expect(fire("require('./a.mts');"), '.mts').toBe(1);
    expect(fire("require('./a.cts');"), '.cts').toBe(1);
    // FIRES: two calls in one file are two hits, and the line numbers are real.
    const two = findRequireTsSpecifiers('f.ts', "require('./a.ts');\n\nrequire('./b.ts');\n");
    expect(two.map((h) => h.line), 'line numbers').toEqual([1, 3]);
    expect(two.map((h) => h.specifier), 'specifiers').toEqual(['./a.ts', './b.ts']);

    // SILENT: a `.js` specifier is fine — esbuild resolves it to the .ts source
    // and Node can load a real .js at any version.
    expect(fire("const m = require('./a.js');"), '.js specifier').toBe(0);
    // SILENT: a bare package name.
    expect(fire("const m = require('better-sqlite3');"), 'package name').toBe(0);
    // SILENT: a static import, which is the sanctioned replacement.
    expect(fire("import { x } from './a.ts';"), 'static import').toBe(0);
    // SILENT: a longer identifier that merely ends in `require`.
    expect(fire("const m = createRequire('./a.ts');"), 'createRequire').toBe(0);
    expect(fire("const m = mod.require('./a.ts');"), 'member access').toBe(0);

    // SILENT — PROSE. Three scanners in this repo have flagged their own
    // documentation; these are the exact shapes that caused it.
    expect(fire("// never write require('./a.ts') — it breaks below Node 22.18"), 'line comment').toBe(
      0,
    );
    expect(fire("/* the broken form was require('./a.ts') */"), 'block comment').toBe(0);
    expect(fire('/**\n * Do not use require(\'./a.ts\').\n */'), 'jsdoc').toBe(0);
    // SILENT — TypeScript source quoted INSIDE a string, which is what this very
    // fixture block is. Without the lexer this file would flag itself.
    expect(fire('const fixture = "const m = require(\'./a.ts\');";'), 'code inside a string').toBe(0);
    expect(fire('const fixture = `const m = require(\'./a.ts\');`;'), 'code inside a template').toBe(
      0,
    );
    // SILENT: an escaped quote must not end the string early and expose the call.
    expect(fire('const s = "he said \\"hi\\" then require(\'./a.ts\')";'), 'escaped quotes').toBe(0);
  });

  // REGEX LITERALS — the path the CR-72 live-fire exposed. The first revision of
  // this detector had no regex state, so a regex containing a lone quote put the
  // lexer into "inside a string" for the rest of the file and it reported CLEAN
  // over a planted defect. Every assertion here must FIRE, i.e. the call after
  // the regex must still be seen.
  it('detector survives regex literals — the lexer must not desynchronise', () => {
    const fire = (src: string): number => findRequireTsSpecifiers('f.ts', src).length;

    // The exact shapes in hooks-stdout-convention.test.ts: regexes carrying an
    // unpaired double quote, single quote, and slashes.
    expect(
      fire('s.replace(/"(?:\\\\.|[^"\\\\])*"/g, \'""\');\nrequire(\'./a.ts\');'),
      'regex containing a double quote',
    ).toBe(1);
    expect(
      fire("s.replace(/'(?:\\\\.|[^'\\\\])*'/g, \"''\");\nrequire('./a.ts');"),
      'regex containing a single quote',
    ).toBe(1);
    expect(
      fire("s.replace(/\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\//g, '');\nrequire('./a.ts');"),
      'regex containing escaped slashes',
    ).toBe(1);
    // A `/` inside a CHARACTER CLASS does not end the regex.
    expect(fire("const re = /[/'\"]+/g;\nrequire('./a.ts');"), 'slash inside a character class').toBe(
      1,
    );
    // Division must NOT be mistaken for a regex — otherwise everything after it
    // is swallowed as regex body.
    expect(fire("const avg = total / count;\nrequire('./a.ts');"), 'division after an identifier').toBe(
      1,
    );
    expect(fire("const half = arr[0] / 2;\nrequire('./a.ts');"), 'division after a bracket').toBe(1);
    expect(fire("const r = f() / 2;\nrequire('./a.ts');"), 'division after a call').toBe(1);
    // A regex DOES follow a keyword.
    expect(fire("return /x'y/.test(s);\nrequire('./a.ts');"), 'regex after `return`').toBe(1);

    // POSITIVE CONTROL on the real file: the victim of the live-fire is dense
    // with these regexes, and the detector must reach its end. Appending the
    // planted call to its real source must produce exactly one hit.
    const victim = readFileSync(
      join(REPO_ROOT, 'packages/core/src/__tests__/hooks-stdout-convention.test.ts'),
      'utf-8',
    );
    expect(findRequireTsSpecifiers('victim.ts', victim), 'the real file is clean').toEqual([]);
    expect(
      findRequireTsSpecifiers('victim.ts', `${victim}\nrequire('../hooks/lib/write-hook-message.ts');\n`)
        .length,
      'the detector still sees a call appended AFTER all those regexes',
    ).toBe(1);
  });
});
