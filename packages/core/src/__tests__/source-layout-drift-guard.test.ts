// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard: no compiled-in single-package layout may re-enter the source tree.
 *
 * Closes the class landed by `plan-2026-08-13-index-builder-input-contracts` Q3+Q4.
 * Ten sites across seven modules each answered "where does this project's source
 * live?" with the literal `src/`, and in this monorepo every one of them matched
 * nothing: `buildImportIndex` consumed 0 of 1266 files, `buildPageDeps` 0 of 69
 * real pages, and two hooks exited silently on every edit and every deletion.
 *
 * Nothing went red for any of it, because the wrong answer and the right answer
 * both look like "no results". If it regresses tomorrow, THIS goes red.
 *
 * The layout has ONE authoring site: `lib/source-layout.ts`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * One entry per detection path, each with a fixture below that MUST fire and a
 * counter-fixture that MUST NOT. A rule with more paths than fixtures is
 * decoration for the difference (G18).
 */
const RULES: ReadonlyArray<{ id: string; why: string; re: RegExp }> = [
  {
    id: 'sql-like-src-literal',
    why: "a SQL LIKE pattern rooted at `src/` — use sourceDirPredicate()/pagesPredicate()",
    re: /LIKE\s+['"`]src\//,
  },
  {
    id: 'startswith-src-literal',
    why: "`startsWith('src/')` — use isUnderSourceDir()",
    re: /\.startsWith\(\s*['"`]src\//,
  },
  {
    id: 'regex-anchored-on-src',
    why: 'a regex anchored on `^src/` — derive the prefix from getSourceLayout()',
    re: /\/\^src\\\//,
  },
  {
    id: 'paths-source-as-the-whole-set',
    why: '`paths.source + "/%"` treats ONE declared dir as the whole source set — use sourceDirPredicate()',
    re: /paths\.source\s*\+\s*['"`]\/%/,
  },
];

/**
 * Files exempt from the sweep, each with a RULING rather than a path alone.
 * Adding an entry says the layout genuinely cannot be derived there.
 */
const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  'packages/core/src/lib/source-layout.ts':
    'the SoT itself — it is where the literals are allowed to be written down',
});

/** Tracked TypeScript sources under packages/core/src, excluding tests. */
function trackedSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', 'packages/core/src/*.ts', 'packages/core/src/**/*.ts'],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  );
  const files = out
    .split('\n')
    .filter(Boolean)
    .filter(f => !f.includes('/__tests__/') && !f.endsWith('.test.ts'))
    .filter(f => !(f in ALLOWLIST))
    .sort();

  // M1 — PROVE IT LOOKED. "Scanned 0, found 0" is a loud error, never a pass.
  if (files.length === 0) {
    throw new Error('git ls-files enumerated 0 core sources — refusing to report clean');
  }
  return files;
}

/**
 * Strip full-line comments before matching.
 *
 * Without this the guard reads its own prose as code: every file that documents
 * this class mentions `startsWith('src/')` in a comment, and a scanner that
 * counts those is one people learn to ignore. Deliberately line-level and not a
 * full comment parser — a trailing `// ...` after real code is still scanned,
 * which is the direction that fails safe.
 */
function codeLines(content: string): { line: number; text: string }[] {
  return content
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
}

interface Hit { file: string; line: number; rule: string; why: string; text: string }

function scan(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
    } catch (e) {
      // M2 — FAIL CLOSED. An unreadable input is an error, never an empty one.
      throw new Error(`could not read ${file}: ${(e as Error).message}`);
    }
    for (const { line, text } of codeLines(content)) {
      for (const rule of RULES) {
        if (rule.re.test(text)) {
          hits.push({ file, line, rule: rule.id, why: rule.why, text: text.trim() });
        }
      }
    }
  }
  return hits;
}

describe('source-layout drift guard', () => {
  it('sweeps every tracked core source and finds no compiled-in layout', () => {
    const files = trackedSources();
    // The denominator, printed rather than assumed.
    expect(files.length).toBeGreaterThan(50);
    // M1 — a file known to be in the population, so an empty sweep cannot pass.
    expect(files).toContain('packages/core/src/import-resolver.ts');

    const hits = scan(files);
    const report = hits.map(h => `${h.file}:${h.line} [${h.rule}] ${h.why}\n    ${h.text}`).join('\n');
    expect(report).toBe('');
  });

  it('every detection path FIRES on its own fixture', () => {
    // A rule that cannot go red is decoration (M4). One fixture per path, and
    // each is asserted to be caught by ITS OWN rule, not merely by some rule.
    const fixtures: Record<string, string> = {
      'sql-like-src-literal': `const q = db.prepare("SELECT path FROM files WHERE path LIKE 'src/%'");`,
      'startswith-src-literal': `if (target.startsWith('src/')) { recurse(target); }`,
      'regex-anchored-on-src': `const route = pageFile.replace(/^src\\/app/, '');`,
      'paths-source-as-the-whole-set': `const pattern = config.paths.source + '/%';`,
    };

    expect(Object.keys(fixtures).sort()).toEqual(RULES.map(r => r.id).sort());

    for (const rule of RULES) {
      const fired = codeLines(fixtures[rule.id]).some(({ text }) => rule.re.test(text));
      expect(fired, `rule ${rule.id} did not fire on its own fixture`).toBe(true);
    }
  });

  it('stays silent on the derived forms that replaced each literal', () => {
    // The counter-fixtures. A guard that also flags the FIX teaches people to
    // disable it.
    const compliant = [
      `const pred = sourceDirPredicate(); db.prepare(\`SELECT path FROM files WHERE \${pred.sql}\`);`,
      `if (isUnderSourceDir(target)) { recurse(target); }`,
      `const prefix = getSourceLayout().pagesDir.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');`,
      `const routersPath = config.paths.routers ?? 'src/server/api/routers';`,
      `const srcSource = sourceDirPredicate('source_file');`,
    ];

    for (const line of compliant) {
      for (const rule of RULES) {
        expect(rule.re.test(line), `${rule.id} false-positived on: ${line}`).toBe(false);
      }
    }
  });

  it('reads prose as prose — a comment describing the defect is not the defect', () => {
    const prose = [
      `  // Only process src/ files — this was \`rel.startsWith('src/')\`.`,
      ` * selected \`FROM files WHERE path LIKE 'src/%'\` and returned 0.`,
      `/* replace(/^src\\/app/, '') was the old route derivation */`,
    ].join('\n');

    expect(codeLines(prose)).toEqual([]);
  });
});
