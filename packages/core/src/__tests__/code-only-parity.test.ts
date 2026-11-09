// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CROSS-LANGUAGE PARITY — the TypeScript helper vs the Python probe's stripper.
 *
 * Two implementations of one rule are unavoidable here: the measuring probe
 * (`scripts/ops/probe-comment-satisfiable-assertions.py`) is Python and the guards it
 * measures are TypeScript. This test is what stops them drifting — it must FAIL if either
 * side changes behaviour alone, in EITHER direction.
 *
 * THE SUBSET IS NAMED, NOT DISCOVERED. Byte-identity over the helper's FULL fixture corpus is
 * unsatisfiable by construction, and a test that can never go green gets deleted:
 *
 *   block comments             the probe strips LINE comments only, by design
 *                              ("over-stripping would manufacture findings", probe :107-108);
 *                              the helper strips `/* … *\/`.
 *   `#!` shebang               the probe DROPS it (`stripped.startswith(marker)` is true of
 *                              it, :129-130); the helper PRESERVES it — it is executable
 *                              configuration, not documentation.
 *   trailing `//` after a
 *   quoted `://`               the probe's `line.find(marker)` finds the `//` INSIDE the
 *                              quotes first, sees odd quote parity, and keeps the whole line
 *                              including the real trailing comment; the helper strips it.
 *
 * Each of those three carries its own ONE-SIDED fixture in `code-only-helper.test.ts`, and
 * `documented divergences` below asserts each exclusion is still REAL — an exclusion that has
 * silently stopped applying is a narrowed gate, which is the defect this file exists to
 * prevent one level up.
 *
 * IN SCOPE for byte-identity: full-line line-comments, trailing line-comments with no quote
 * on the line, the `#` marker set, the `//` marker set, and the `null`/`.json` outcome.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './helpers/code-only.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PROBE = join(REPO_ROOT, 'scripts', 'ops', 'probe-comment-satisfiable-assertions.py');

interface Case {
  name: string;
  ext: string;
  text: string;
}

/** IN-SCOPE corpus: every case here MUST be byte-identical across both implementations. */
const SHARED_CORPUS: readonly Case[] = [
  // --- full-line line-comments: the line is REMOVED, not blanked ---
  { name: 'ts full-line comment', ext: '.ts', text: 'const a = 1;\n// gone\nconst b = 2;\n' },
  { name: 'ts indented full-line comment', ext: '.ts', text: 'if (x) {\n  // gone\n}\n' },
  { name: 'ts consecutive full-line comments', ext: '.ts', text: '// a\n// b\nconst c = 1;\n' },
  { name: 'sh full-line comment', ext: '.sh', text: 'A=1\n# gone\nB=2\n' },
  { name: 'sh only comments', ext: '.sh', text: '# a\n# b\n' },
  { name: 'py full-line comment', ext: '.py', text: 'x = 1\n# gone\ny = 2\n' },
  { name: 'yml full-line comment', ext: '.yml', text: 'a: 1\n# gone\nb: 2\n' },

  // --- trailing line-comments, NO quote anywhere on the line ---
  { name: 'ts trailing comment', ext: '.ts', text: 'const a = 1; // why\n' },
  { name: 'ts trailing comment no space', ext: '.ts', text: 'const a = 1;// why\n' },
  { name: 'sh trailing comment', ext: '.sh', text: 'A=1 # why\n' },
  { name: 'bash trailing comment', ext: '.bash', text: 'set -e # why\n' },
  { name: 'py trailing comment', ext: '.py', text: 'x = 1  # why\n' },
  { name: 'yaml trailing comment', ext: '.yaml', text: 'a: 1 # why\n' },
  { name: 'mjs trailing comment', ext: '.mjs', text: 'export const a = 1; // why\n' },
  { name: 'cjs trailing comment', ext: '.cjs', text: 'module.exports = 1; // why\n' },
  { name: 'js trailing comment', ext: '.js', text: 'var a = 1; // why\n' },
  { name: 'tsx trailing comment', ext: '.tsx', text: 'const A = () => null; // why\n' },

  // --- mixed, still no quote on any line ---
  {
    name: 'sh mixed full-line and trailing',
    ext: '.sh',
    text: 'A=1 # why\n# gone\nB=2\n\nC=3\n',
  },
  {
    name: 'ts mixed full-line and trailing',
    ext: '.ts',
    text: 'const a = 1; // why\n// gone\nconst b = 2;\n',
  },

  // --- structural edge cases inside the subset ---
  { name: 'no trailing newline', ext: '.sh', text: 'A=1' },
  { name: 'empty input', ext: '.sh', text: '' },
  { name: 'blank lines preserved', ext: '.ts', text: 'const a = 1;\n\n\nconst b = 2;\n' },

  // --- the third outcome: no comment syntax at all ---
  { name: 'json has no comment syntax', ext: '.json', text: '{"a": 1}\n' },
];

/** OUT OF SCOPE, each for a stated mechanism. Asserted to still DIVERGE — see below. */
const DOCUMENTED_DIVERGENCES: readonly Case[] = [
  {
    name: 'block comment — probe keeps, helper strips',
    ext: '.ts',
    text: 'const a = /* gone */ 1;\n',
  },
  {
    name: 'shebang — probe drops, helper preserves',
    ext: '.sh',
    text: '#!/usr/bin/env bash\nA=1\n',
  },
  {
    name: 'trailing // after a quoted :// — probe keeps the whole line, helper truncates',
    ext: '.ts',
    text: "const u = 'https://example.com/x'; // why\n",
  },
];

const DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('probe', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
cases = json.load(sys.stdin)
print(json.dumps([m.strip_line_comments(c['text'], c['ext']) for c in cases]))
`;

function probeStrip(cases: readonly Case[]): (string | null)[] {
  const r = spawnSync('python3', ['-c', DRIVER, PROBE], {
    input: JSON.stringify(cases),
    encoding: 'utf-8',
  });
  // M2 — a probe that could not run must never read as agreement.
  expect(r.error ?? null, `python3 failed to spawn: ${r.error?.message ?? ''}`).toBeNull();
  expect(r.status, `python driver stderr:\n${r.stderr}`).toBe(0);
  const out = JSON.parse(r.stdout) as (string | null)[];
  expect(out.length, 'the python side returned a different number of results').toBe(cases.length);
  return out;
}

describe('code-only parity: the TS helper and the Python probe agree on the named subset', () => {
  it('the probe exists — a missing subject is a FAILURE, never a silent skip', () => {
    expect(existsSync(PROBE), `probe not found at ${PROBE}`).toBe(true);
  });

  it('reports its denominator (M1) — an empty corpus is a broken test, not a pass', () => {
    expect(SHARED_CORPUS.length).toBeGreaterThanOrEqual(20);
    expect(DOCUMENTED_DIVERGENCES.length).toBe(3);
  });

  it('POSITIVE CONTROL: the corpus actually exercises stripping, so parity is not trivial', () => {
    // Two identity functions agree perfectly. Demand that most in-scope cases CHANGE.
    const changed = SHARED_CORPUS.filter((c) => {
      const got = codeOnly(c.text, c.ext);
      return got !== null && got !== c.text;
    });
    expect(changed.length).toBeGreaterThanOrEqual(SHARED_CORPUS.length - 4);
  });

  it('is byte-identical on every in-scope case, in BOTH marker families', () => {
    const fromPython = probeStrip(SHARED_CORPUS);
    const mismatches: string[] = [];
    SHARED_CORPUS.forEach((c, i) => {
      const ts = codeOnly(c.text, c.ext);
      const py = fromPython[i];
      if (ts !== py) {
        mismatches.push(
          `${c.name} [${c.ext}]\n  input:  ${JSON.stringify(c.text)}\n` +
            `  ts:     ${JSON.stringify(ts)}\n  python: ${JSON.stringify(py)}`,
        );
      }
    });
    expect(mismatches.join('\n\n'), `${mismatches.length}/${SHARED_CORPUS.length} diverged`).toBe(
      '',
    );
  });

  it('documented divergences are still REAL — an exclusion that stopped applying is a narrowed gate', () => {
    const fromPython = probeStrip(DOCUMENTED_DIVERGENCES);
    DOCUMENTED_DIVERGENCES.forEach((c, i) => {
      expect(
        codeOnly(c.text, c.ext),
        `${c.name}: the two implementations now AGREE. If the probe was upgraded to the ` +
          `helper's semantics, move this case into SHARED_CORPUS — do not delete the check.`,
      ).not.toBe(fromPython[i]);
    });
  });
});
