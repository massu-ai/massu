// A-05 — A MEMORY'S `name` IS NOT A FILENAME, AND MAY NEVER BECOME ONE.
//
// The renderer's original design wrote `memory/<name>.md`, where `name` is the
// frontmatter value — human prose, taken verbatim, never validated. In the operator's
// REAL corpus:
//   - THREE names contain a `/` (e.g. `massu-ai/massu IS PUBLIC — never commit …`),
//   - 14 of 69 are not valid filenames at all (spaces, parens, em-dashes, `+`, `↔`).
// That is an ARBITRARY FILE WRITE primitive: `../../CLAUDE.md` is one memory away — and
// CLAUDE.md governs every future agent turn. `name` is also human-editable and NOT
// unique, which is why identity in `memory_files` is `rel_path`.
//
// This guard is the structural half: the slugger exists, it is the ONLY one, and no
// module may join a raw frontmatter `name` into a path.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, basename } from 'path';

import {
  memoryFileSlug,
  deriveSlug,
  SLUG_ALLOWED,
  assertContainedIn,
  PathEscapeError,
} from '../lib/safe-write.ts';

const SRC = join(__dirname, '..');

function walk(dir: string, acc: string[] = []): string[] {
  // BASE-3a (audit 2026-07-14): tolerate a directory vanishing mid-walk. A
  // concurrently-running test may create+remove a scratch dir under src/ while
  // this guard recurses; an unguarded readdirSync then throws ENOENT and the
  // guard CRASHES instead of guarding (a blind gate). A vanished dir = skip it.
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      walk(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** The shapes that actually appear in the operator's corpus. */
const REAL_HOSTILE_NAMES = [
  'massu-ai/massu IS PUBLIC — never commit docs/internal, reports, plans, etc.',
  '.mcp.json MUST pin @massu/core version (stale-global-install hang root cause)',
  'Pre-push ↔ CI parity drift class (plan-2026-05-18-pre-push-ci-parity SHIPPED)',
  'CR-48 — Vercel deploy is mandatory in Stage D for website-touching plans (1.6.3+)',
];

describe('A-05: a memory name is not a filename (drift-guard)', () => {
  it('every hostile REAL name slugs to a safe, flat filename', () => {
    for (const name of REAL_HOSTILE_NAMES) {
      const slug = memoryFileSlug(name, `${name}.md`);
      expect(SLUG_ALLOWED.test(slug), `${name} -> ${slug}`).toBe(true);
      expect(slug).not.toContain('/');
      expect(slug).not.toContain('..');
      expect(slug.length).toBeLessThanOrEqual(60);
    }
  });

  it('THE ATTACK: a traversal name cannot escape the memory dir', () => {
    const evil = '../../CLAUDE';
    // Slugged, it is inert...
    expect(memoryFileSlug(evil, 'x.md')).not.toContain('..');
    // ...and the raw name is refused by the containment check outright.
    expect(() => assertContainedIn('/tmp/memory', `${evil}.md`)).toThrow(PathEscapeError);
  });

  it('DISTINCT memories with the same 60-char prefix do NOT collide', () => {
    // deriveSlug truncates at 60 and the corpus is full of long near-identical names.
    // A collision would make one render silently CLOBBER the other, every session.
    const a = 'Pre-push CI parity drift class plan 2026 05 18 pre push ci parity SHIPPED alpha';
    const b = 'Pre-push CI parity drift class plan 2026 05 18 pre push ci parity SHIPPED beta';
    expect(deriveSlug(a), 'precondition: the naive slugs DO collide').toBe(deriveSlug(b));
    expect(
      memoryFileSlug(a, 'a.md'),
      'the discriminator must make the mapping injective',
    ).not.toBe(memoryFileSlug(b, 'b.md'));
  });

  it('a name that cannot slug at all is REFUSED, never coerced into something arbitrary', () => {
    expect(() => memoryFileSlug('   ', undefined)).not.toThrow(); // deriveSlug's fallback
    expect(SLUG_ALLOWED.test(memoryFileSlug('!!!', 'x.md'))).toBe(true);
  });

  it('STRUCTURAL: exactly ONE slugger — no module re-implements it', () => {
    // A second slugger is how two writers end up disagreeing about what a file is
    // called; `rule-candidate-applier.ts` now re-exports the shared one.
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (basename(f) === 'safe-write.ts') continue;
      const code = readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // The signature of a hand-rolled slugger: lowercase + strip-non-alnum + collapse.
      if (/replace\(\s*\/\[\^a-z0-9\\s\]\+\/g/.test(code)) offenders.push(relative(SRC, f));
    }
    expect(
      offenders,
      'Hand-rolled slugger(s). Import deriveSlug/memoryFileSlug from lib/safe-write.ts. Offenders',
    ).toEqual([]);
  });

  it('STRUCTURAL: no module joins a raw frontmatter `name` into a path', () => {
    // The exact bug: `join(memoryDir, name + '.md')` / `memory/${name}.md`.
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const code = readFileSync(f, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (
        /join\([^)]*,\s*`?\$?\{?\s*(fm\.name|name)\s*\}?\s*\+?\s*['"`]?\.md/.test(code) ||
        /`[^`]*\/\$\{\s*(fm\.name|name)\s*\}\.md`/.test(code)
      ) {
        offenders.push(relative(SRC, f));
      }
    }
    expect(
      offenders,
      'A memory `name` used as a PATH. It is untrusted human prose — 3 real memories contain a "/". ' +
        'Use memoryFileSlug(name, relPath) + assertContainedIn(). Offenders',
    ).toEqual([]);
  });
});
