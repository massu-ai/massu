// THE ONE PLACE THAT DECIDES WHICH VITEST CONFIGS ARE RUN ROOTS.
//
// A RUN ROOT is a config vitest loads as the root of a run, and it is the only kind that can carry
// a reporter: `reporters` is a member of vitest's `NonProjectOptions`
// (node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts:3572) and
// `type ProjectConfig = Omit<InlineConfig, NonProjectOptions | "sequencer" | "deps">` (:3597), so a
// `defineProject` config cannot express one. Every consumer of the hang detector needs this exact
// set — the arming gate asserts over it, the startup instrument launches one, and the supervisor
// discovers runs beneath it — and re-deriving it per consumer is how they drift.
//
// ⛔ WHY THIS MODULE EXISTS: THE PREDICATE WAS RE-DERIVED AND THE SECOND DERIVATION WAS WRONG
// WITHIN MINUTES. The arming gate got this right (comment-aware, fail-closed). A shell instrument
// written the same hour used `grep -q defineProject` and silently dropped the repo's most important
// run root, because the root config's line 6 is a COMMENT reading
// "…or an inline `defineProject({...})` call". Third occurrence of prose-read-as-code in one
// session. A shared module makes the next consumer correct by construction instead of detectably
// wrong (Rule 25 / G32).
//
// ⛔ WHAT THIS MODULE DELIBERATELY DOES *NOT* OWN — AND THE REASON IS A CONTRACT DIFFERENCE, NOT
// LAZINESS. `packages/core/src/__tests__/corrections-md-drift-guard.test.ts:35` has its own
// comment stripper and KEEPS it. The two are not the same function wearing different names:
//
//     that one        takes a PATH, strips block comments and FULL-LINE `//` only, and is
//                     blind to string literals — which it must be, because its predicates key
//                     on literals like '## Archived'.
//     this one        takes SOURCE TEXT, is quote-aware, and strips `//` anywhere outside a
//                     string — which it must be, because a trailing comment can name a config
//                     helper.
//
// Each has a failure mode the other lacks: full-line-only misses a trailing comment; strip-anywhere
// would cut inside a regex literal such as /\/\//. Merging them on textual similarity would drop
// behaviour one of them depends on — the same trap that once took a guard's exemption set 4 -> 0 by
// over-stripping. Group duplicated code by CONTRACT, never by text.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Strip comments so a predicate cannot read PROSE as code.
 *
 * Quote-aware: a `//` or `/*` inside a string or template literal is content, not a comment.
 * Newlines inside block comments are preserved so `^`-anchored patterns keep their line structure.
 */
export function codeOf(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue; // the newline itself is emitted by the next iteration
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Tracked vitest configs, by `git ls-files` — membership is derived, never a roster. */
export function trackedVitestConfigs(repoRoot) {
  const out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8' });
  return out
    .split('\n')
    .filter((f) => /(^|\/)vitest\.config\.(ts|mts|js|mjs)$/.test(f))
    .sort();
}

/**
 * Classify one tracked config.
 *
 * Throws rather than guessing. An unreadable file, an unrecognised export shape, and a file
 * matching both or neither factory are each an ERROR — none of them may resolve to "not a run
 * root", because that is the value a correct classification also produces and it is the quiet one.
 *
 * @returns {{path: string, shape: 'run-root'|'project', armed: boolean, dir: string}}
 */
export function classifyConfig(repoRoot, rel) {
  let src;
  try {
    src = readFileSync(resolve(repoRoot, rel), 'utf-8');
  } catch (err) {
    throw new Error(
      `vitest-run-roots: UNREADABLE ${rel}: ${err.message} — an unreadable config is an error, ` +
        'never an empty finding (M2).',
    );
  }

  const code = codeOf(src);

  const exportMatch = code.match(/^export default\s+([A-Za-z_$][\w$]*)\s*\(/m);
  if (!exportMatch) {
    throw new Error(
      `vitest-run-roots: ${rel} has no recognisable \`export default <fn>(\` — this module cannot ` +
        'classify it, and refusing is the only honest answer (M2). If the config shape changed ' +
        'legitimately, teach this module the new shape.',
    );
  }

  const hasDefineConfig = /\bdefineConfig\s*\(/.test(code);
  const hasDefineProject = /\bdefineProject\s*\(/.test(code);
  if (hasDefineProject === hasDefineConfig) {
    throw new Error(
      `vitest-run-roots: ${rel} matches ${hasDefineConfig ? 'BOTH' : 'NEITHER'} \`defineConfig\` ` +
        'nor `defineProject` — that distinction decides whether a reporter is even expressible, ' +
        'so an ambiguous shape must fail closed (M2).',
    );
  }

  const dirOf = dirname(rel) === '.' ? '.' : dirname(rel);
  return {
    path: rel,
    dir: dirOf,
    shape: hasDefineProject ? 'project' : 'run-root',
    // ARMED means the DEFAULT EXPORT is wrapped by the arming factory — not that the file merely
    // mentions it. A comment or an unused import naming the factory arms nothing.
    armed: exportMatch[1] === 'withHangDetection',
  };
}

/**
 * Every tracked vitest config, classified. The caller filters; this function never hides a row,
 * so a consumer that wants only run roots and a consumer that wants the denominator both get
 * what they need from one derivation.
 */
export function discoverRunRoots(repoRoot) {
  const configs = trackedVitestConfigs(repoRoot);
  if (configs.length === 0) {
    throw new Error(
      'vitest-run-roots: discovered ZERO tracked vitest configs — "scanned 0, found 0" is a loud ' +
        'error, never a pass (M1).',
    );
  }
  return configs.map((rel) => classifyConfig(repoRoot, rel));
}

// ── CLI, so a SHELL caller asks this module instead of re-deriving the predicate with grep ─────
// `node scripts/lib/vitest-run-roots.mjs [--json] [--run-roots-only]`
if (process.argv[1] && process.argv[1].endsWith('vitest-run-roots.mjs')) {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const onlyRoots = args.includes('--run-roots-only');
  const unknown = args.filter((a) => !['--json', '--run-roots-only'].includes(a));
  if (unknown.length > 0) {
    // R-011: refuse an unrecognised argument and name what IS accepted.
    process.stderr.write(
      `vitest-run-roots: unrecognised argument(s): ${unknown.join(' ')}\n` +
        'accepted: --json, --run-roots-only\n',
    );
    process.exit(2);
  }
  try {
    const all = discoverRunRoots(repoRoot);
    const rows = onlyRoots ? all.filter((c) => c.shape === 'run-root') : all;
    if (asJson) {
      process.stdout.write(JSON.stringify({ denominator: all.length, rows }, null, 2) + '\n');
    } else {
      for (const r of rows) process.stdout.write(`${r.dir}\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}
