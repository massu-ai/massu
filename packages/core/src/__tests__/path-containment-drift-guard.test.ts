/**
 * B-02 / F-05 drift-guard — there is exactly ONE containment implementation.
 *
 * Two copies of a containment check is how a containment check ends up containing
 * nothing. This repo already shipped a second one: `rule-candidate-applier.ts` hand-
 * rolled a realpath-walk anchored on `projectRoot`, and the memory directory lives
 * under `$HOME` — OUTSIDE `projectRoot` by construction. Reusing that check verbatim
 * for the renderer would have rejected every legitimate memory path; retargeting it by
 * hand is how it silently stops containing anything at all.
 *
 * The applier is now refactored ONTO `lib/safe-write.ts:assertContainedIn`. This guard
 * is what stops the next session from writing a third one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const CONTAINMENT_MODULE = join('lib', 'safe-write.ts');

/**
 * Walk src/ for .ts files.
 *
 * Tolerant of entries that vanish mid-walk: other suites in this repo write scratch
 * files under `packages/core/src/` and clean them up, so a `statSync` here races them
 * under `--no-file-parallelism`-less runs and throws ENOENT. (Reproduced: this guard
 * passes alone and failed only in the full parallel suite.) A filesystem walk must
 * tolerate concurrent mutation — the alternative is a guard that fails at random,
 * which is a guard nobody trusts and everybody skips.
 */
function allSourceFiles(dir: string = SRC, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // directory vanished mid-walk
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue; // entry vanished between readdir and stat
    }
    if (isDir) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      allSourceFiles(p, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/** Read a file that may have vanished since the walk. */
function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

describe('B-02 drift-guard — ONE containment implementation', () => {
  it('only lib/safe-write.ts implements a realpath-based CONTAINMENT check', () => {
    // Scoped to containment SHAPE, not to `realpathSync` as such: resolving a symlink
    // is a legitimate operation with other uses. `lsp/client.ts:294` realpaths argv[0]
    // to stat it for a setuid bit — that is not a containment decision and consolidating
    // it would be nonsense. Verified at source before narrowing this rule.
    //
    // A CONTAINMENT check is realpath + a comparison of the result against a root.
    const offenders: string[] = [];

    for (const file of allSourceFiles()) {
      const rel = relative(SRC, file);
      if (rel === CONTAINMENT_MODULE) continue;
      const src = safeRead(file);
      if (!/\brealpathSync\s*\(/.test(src)) continue;

      // Does it compare the realpath against a root? That is the duplicate check.
      const comparesToRoot =
        /realpathSync[\s\S]{0,400}?(startsWith\s*\(\s*real|relative\s*\(\s*real|===\s*real)/.test(src) ||
        /(real\w*Root|real\w*Base)[\s\S]{0,200}?startsWith/.test(src);

      if (comparesToRoot) offenders.push(rel);
    }

    expect(
      offenders,
      `A second realpath-based CONTAINMENT check exists outside ${CONTAINMENT_MODULE}. ` +
        `Import isContainedIn() (read path) or assertContainedIn() (write path) instead — ` +
        `they are parameterised by the root precisely so the applier (projectRoot), the ` +
        `renderer (memoryDir) and the source-dir detector can share ONE implementation. ` +
        `Two copies of a containment check is how a containment check ends up containing ` +
        `nothing.\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('ANTI-VACUITY: the containment-shape rule fires on the check it just retired', () => {
    // The exact code that WAS in detect/source-dir-detector.ts. If this stops matching,
    // the guard has gone blind and a fourth copy could land unnoticed.
    const retired = `
      const realRoot = realpathSync(root);
      const realCand = realpathSync(resolve(root, candidate));
      return realCand === realRoot || realCand.startsWith(realRoot + '/');
    `;
    const comparesToRoot =
      /realpathSync[\s\S]{0,400}?(startsWith\s*\(\s*real|relative\s*\(\s*real|===\s*real)/.test(retired) ||
      /(real\w*Root|real\w*Base)[\s\S]{0,200}?startsWith/.test(retired);
    expect(comparesToRoot, 'the drift-guard no longer detects a duplicate containment check').toBe(
      true
    );

    // ...and does NOT fire on a bare symlink resolution (the lsp/client.ts shape).
    const setuidProbe = `
      const linkStat = lstatSync(path);
      if (linkStat.isSymbolicLink()) { resolved = realpathSync(path); }
      const st = statSync(resolved);
    `;
    const falsePositive =
      /realpathSync[\s\S]{0,400}?(startsWith\s*\(\s*real|relative\s*\(\s*real|===\s*real)/.test(setuidProbe) ||
      /(real\w*Root|real\w*Base)[\s\S]{0,200}?startsWith/.test(setuidProbe);
    expect(falsePositive, 'the drift-guard is over-broad — it flags a plain symlink resolve').toBe(
      false
    );
  });

  it('nothing joins a raw frontmatter `name` into a path', () => {
    // A memory's `name` is human prose: 3 of the operator's real names contain a `/`.
    // `join(memoryDir, name)` is an arbitrary-file-write primitive.
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = relative(SRC, file);
      const src = safeRead(file);
      for (const re of [
        /join\([^)]*,\s*(fm|frontmatter)\.name\s*\)/,
        /join\([^)]*,\s*`\$\{\s*(fm|frontmatter)\.name\s*\}/,
        /join\([^)]*memoryDir[^)]*,\s*\w*[Nn]ame\s*\+/,
      ]) {
        if (re.test(src)) offenders.push(`${rel} :: ${re}`);
      }
    }
    expect(
      offenders,
      `A raw frontmatter name is being joined into a path. Only a validated slug may ` +
        `become a filename (A-05 / memoryFileSlug).\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the renderer computes its path through the shared helper, not by hand', () => {
    const renderPath = readFileSync(join(SRC, 'memory-render-path.ts'), 'utf8');
    expect(renderPath).toContain('assertContainedIn');
    expect(renderPath).toContain('memoryFileSlug');
    // It must not reimplement the check it just imported.
    expect(renderPath).not.toMatch(/\brealpathSync\s*\(/);
  });

  it('ANTI-VACUITY: the realpath rule would fire on a reintroduced second check', () => {
    // Guard against this guard being quietly satisfied by a rename.
    const probe = `const real = realpathSync(projectRoot);`;
    expect(/\brealpathSync\s*\(/.test(probe)).toBe(true);
  });
});
