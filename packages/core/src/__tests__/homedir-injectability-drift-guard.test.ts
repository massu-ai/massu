// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * DRIFT-GUARD: `homedir()` may only be used as an INJECTABLE DEFAULT.
 *
 * THE CLASS, TWICE IN ONE DAY, IN ONE REPO:
 *
 *   d76ab2c8  `memory-integrity-check.sh` hardcoded `$HOME/.claude/projects`, so its own
 *             mutation test materialised SIX fixture directories inside the operator's LIVE
 *             memory store — the tree a burst deletion destroyed on 2026-07-26.
 *   2026-08-11 `massuShimPath()` resolved `homedir()` unconditionally, so
 *             `massu-shim-drift-guard.test.ts` installed a live `~/.massu/bin/massu-hook`
 *             on the developer's machine on EVERY `npm test`.
 *
 * The second one also DISARMED A GATE, which is why a memory was not enough. Once the shim
 * exists, `resolveMassuShim()` is non-null, `hookCmd` takes the shim branch, and the
 * anti-vacuity plant aimed at the npx branch never reaches an emitted command:
 * `init-hook-paths-no-absolute.test.ts` was reported "IT IS DECORATION" by the 2026-08-11
 * sweep. **A test that writes to $HOME can silently change which code path every other test
 * exercises**, so the blast radius is not "an untidy home directory" — it is a gate that
 * stops gating while still reporting green.
 *
 * THE RULE. In `packages/core/src/**` (non-test), a `homedir()` call may appear ONLY as an
 * injectable default:
 *
 *     export function f(..., home: string = homedir())      // OK — parameter default
 *     const home = opts.home ?? homedir();                  // OK — resolved into `home`
 *     resolve(homedir(), '.massu', 'bin', 'massu-hook')     // VIOLATION — no seam
 *
 * That is not a new convention invented here: it is what ~20 modules already do
 * (`credentials.ts`, `db-backup.ts`, `memory-backup.ts`, `memory-authorship.ts`,
 * `security/local-share-signer.ts`, `shared-memory-transport.ts`, …). This guard stops the
 * exceptions from growing.
 *
 * NOT A BRICK (CR-72). Pre-existing inline sites are held in a SHRINK-ONLY allowlist below.
 * A NEW one fails. An allowlist entry that no longer fires ALSO fails, so the list cannot
 * quietly outlive its violations — it can only shrink. Growing it to turn this test green is
 * the defect this format exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, relative, join } from 'path';
import { execFileSync } from 'child_process';
import ts from 'typescript';

const SRC = resolve(__dirname, '..');

/**
 * Inline `homedir()` sites that predate this guard. SHRINK-ONLY.
 *
 * Each is a real seam the codebase does not yet have. They are recorded rather than fixed
 * in this commit because widening a refactor is how a fix lands at one site of N badly
 * (CR-74); they are listed so the population is VISIBLE rather than implied.
 */
const KNOWN_INLINE: readonly string[] = [
  'advisors/cross-repo-share-advisor.ts',
  'commands/init.ts',
  'config.ts',
  'detect/adapters/tree-sitter-loader.ts',
  'permissions.ts',
  'security/install-tracking.ts',
  'security/local-fingerprint.ts',
  'security/manifest-cache.ts',
  'security/telemetry.ts',
];

/** Recursively collect non-test .ts sources. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err; // M2 — an unreadable input is an ERROR, never an empty one
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      out.push(...collectTsFiles(full));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * True when this `homedir()` call sits in an injectable position — a parameter default, or
 * an initializer binding it to a variable a caller can override.
 */
function isInjectableDefault(call: ts.Node): boolean {
  const parent = call.parent;
  if (!parent) return false;

  // `function f(home: string = homedir())`
  if (ts.isParameter(parent) && parent.initializer === call) return true;

  // `const home = homedir();`  /  `const home = opts.home ?? homedir();`
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return /home/i.test(parent.name.text);
  }
  // `opts.home ?? homedir()` / `x || homedir()` — the left side is the seam.
  if (ts.isBinaryExpression(parent)) {
    const tok = parent.operatorToken.kind;
    if (
      (tok === ts.SyntaxKind.QuestionQuestionToken || tok === ts.SyntaxKind.BarBarToken) &&
      parent.right === call
    ) {
      const gp = parent.parent;
      if (gp && ts.isVariableDeclaration(gp) && ts.isIdentifier(gp.name)) return /home/i.test(gp.name.text);
      if (gp && ts.isParameter(gp)) return true;
      return true; // a defaulted expression is still a seam
    }
  }
  return false;
}

/** Files carrying at least one NON-injectable `homedir()` call, repo-relative. */
function findInlineHomedirFiles(files: string[]): { offenders: string[]; calls: number } {
  const offenders = new Set<string>();
  let calls = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    if (!text.includes('homedir')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'homedir' &&
        node.arguments.length === 0
      ) {
        calls++;
        if (!isInjectableDefault(node)) offenders.add(relative(SRC, file));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { offenders: [...offenders].sort(), calls };
}

describe('homedir() must be an injectable default (d76ab2c8 / 2026-08-11 shim class)', () => {
  const files = collectTsFiles(SRC);
  const { offenders, calls } = findInlineHomedirFiles(files);

  it('the scan actually looked (M1 — denominator)', () => {
    // "0 offenders" is also what a scanner pointed at the wrong directory reports.
    expect(statSync(SRC).isDirectory()).toBe(true);
    expect(files.length, 'scanned 0 source files — this guard is blind').toBeGreaterThan(100);
    expect(calls, 'found 0 homedir() calls at all — the AST walk is not matching').toBeGreaterThan(10);
  });

  it('no NEW file resolves homedir() inline', () => {
    const unexpected = offenders.filter((f) => !KNOWN_INLINE.includes(f));
    expect(
      unexpected,
      'These resolve homedir() with no injectable seam, so a test cannot redirect them and ' +
        'will write into the real $HOME. Add a `home: string = homedir()` parameter — do NOT ' +
        'add the file to KNOWN_INLINE, which is shrink-only by design.',
    ).toEqual([]);
  });

  it('the allowlist is SHRINK-ONLY — no stale entries', () => {
    const stale = KNOWN_INLINE.filter((f) => !offenders.includes(f));
    expect(
      stale,
      'These allowlist entries no longer have an inline homedir() — delete them. An ' +
        'allowlist that outlives its violations silently re-opens the hole it documents.',
    ).toEqual([]);
  });

  it('the shim + runtime family is INJECTABLE (the 2026-08-11 regression site)', () => {
    // init.ts stays on the allowlist for OTHER sites (memory dirs), so assert the specific
    // functions this incident was about, by signature, rather than trusting the file-level
    // verdict (G28 — the predicate must BE the property, not a correlate).
    const src = readFileSync(resolve(SRC, 'commands/init.ts'), 'utf-8');
    for (const fn of [
      'massuShimPath',
      'installMassuShim',
      'resolveMassuShim',
      'massuRuntimeDir',
      'massuRuntimeCliPath',
      'resolveMassuRuntimeCli',
      'materializeMassuRuntime',
    ]) {
      // Terminate on `):` (end of the parameter list, before the return type) rather than
      // the first `)` — a default of `homedir()` contains a closing paren, and `[^)]*`
      // captured `home: string = homedir(` and then "failed" for the wrong reason.
      const re = new RegExp(`export function ${fn}\\(([\\s\\S]*?)\\)\\s*:`, 's');
      const m = re.exec(src);
      expect(m, `${fn} not found — renamed? this guard just went vacuous`).not.toBeNull();
      expect(
        m![1],
        `${fn}() takes no injectable home — a test cannot stop it writing to the real $HOME`,
      ).toMatch(/home\s*:\s*string\s*=\s*homedir\(\)/);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * THE SAME RULE, IN SHELL — and the language the ORIGINATING incident was written in.
 *
 * `d76ab2c8` is cited at the top of this file as instance #1 of the class, and it is a
 * SHELL script: `memory-integrity-check.sh` hardcoded `$HOME/.claude/projects`, so its own
 * mutation test materialised six fixture directories inside the operator's LIVE memory
 * store. The guard written afterwards swept TypeScript under `packages/core/src` only — so
 * it could never have seen its own founding defect. That is G18/CR-91: the candidate set was
 * narrower than the class, and the gap reports exactly the same green as full coverage.
 *
 * The shell seam is the parameter-expansion default, which is what the FIX to that very
 * script installed (`memory-integrity-check.sh:109`):
 *
 *     MEMORY_STORE_ROOT="${MASSU_MEMORY_STORE_ROOT:-$HOME/.claude/projects}"   // OK — seam
 *     REAL_STORE_ROOT="$HOME/.claude/projects"                                 // VIOLATION
 *
 * ONE guard, both languages (Rule 25): a second guard file would be the N+1th hand-
 * maintained sweep, and the two would drift on which seam forms count.
 * ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Tracked `*.sh` carrying at least one unseamed `$HOME` path build. SHRINK-ONLY, exactly
 * like KNOWN_INLINE above: a NEW file fails, and an entry that no longer fires ALSO fails,
 * so the list can never quietly outlive its violations.
 *
 * Recorded rather than fixed here because widening a refactor across ten scripts is how a
 * fix lands at one site of N (CR-74). The population is VISIBLE rather than implied.
 */
const KNOWN_INLINE_SH: readonly string[] = [
  // Live scripts that genuinely need a seam.
  'scripts/ci-sync-check.sh',
  'scripts/kb-staleness-audit.sh',
  'scripts/sync-public.sh',
  'scripts/tests/test-memory-integrity-check.sh',
  'scripts/tests/test_publication_gates_anti_vacuity.sh',
  // Protective comparisons: these REFUSE to operate on `$HOME` rather than building a path
  // under it (`probe-gate-requires.sh:317` is a `refusing to withdraw` fatal). Listed, not
  // rule-excluded, so that if the protective form is ever deleted the entry goes stale and
  // this guard fails rather than silently losing the site.
  'scripts/ops/probe-gate-requires.sh',
];

/**
 * A `$HOME` reference that builds a path the script will act on.
 *
 * Two exclusions, both by RULE rather than by allowlist, because each is a property of the
 * line and not a property of the file:
 *   - a FULL-LINE COMMENT is prose, not code. Omitting this filter is precisely what made a
 *     sibling sweep count `# ... legitimate patterns ...` as a repo creator (G29, limn
 *     `51209b6ea`), and it is self-masking: a guard wrong in one direction gets noticed, one
 *     wrong in both looks calibrated.
 *   - a SINGLE-QUOTED `$HOME` never expands, so it builds no path. `PROBE_PATH='$HOME/...'`
 *     in test_empty_path_component_guard.sh is a literal fixture string, deliberately
 *     unexpanded — flagging it would teach people the guard reads prose as code.
 *   - a QUOTED-HEREDOC body (`<<'PY'` / `<<"PY"`) is likewise unexpanded by the shell. This
 *     one was found the hard way: the first draft flagged this guard's OWN companion
 *     live-fire, whose plant payload is a `$HOME` line inside a `<<'PY'` block that python
 *     writes into a victim file. That is the prover, not the proved. An UNQUOTED heredoc
 *     (`<<EOF`) DOES expand and stays in scope.
 */
const SH_SEAM = /\$\{[A-Za-z_][A-Za-z0-9_]*:[-=][^}]*\$\{?HOME/;

/**
 * True when at least one `$HOME` on this line is actually EXPANDED by the shell — i.e. the
 * line really does build a path. Strips the three non-expanding forms, in order:
 *   1. `\$HOME` — backslash-escaped, a literal even inside double quotes. These are almost
 *      always diagnostic MESSAGE strings ("guard stayed GREEN on an unseamed \$HOME"), and
 *      flagging a failure message for naming the thing it detects is how a guard earns a
 *      reputation for crying wolf (G18: fix the RULE — fence-awareness, message-string
 *      exclusion — never the fixture).
 *   2. single-quoted spans — no expansion inside `'...'`.
 * Whatever survives both is a genuine expansion.
 */
function homeExpandsOn(line: string): boolean {
  return line
    .replace(/\\\$HOME/g, '')
    .replace(/'[^']*'/g, '')
    .includes('$HOME');
}

/** Opening a heredoc whose delimiter is QUOTED — the body is literal, nothing expands. */
const HEREDOC_QUOTED_OPEN = /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)")/;

function findUnseamedShellFiles(repoRoot: string): {
  offenders: string[];
  files: number;
  refs: number;
} {
  // `scripts/**` only — EXECUTABLE TOOLING, which is the whole subject: a script that can
  // run and write into the operator's real $HOME. Two reasons this is a scope decision
  // rather than a convenience, both stated out loud because every exclusion is a blind spot
  // you chose (G18):
  //   1. Archived evidence is not tooling. Documentation trees hold incident artifacts kept
  //      verbatim as a record; "fixing" one falsifies the thing it exists to preserve.
  //   2. THIS FILE SYNCS PUBLIC. A path that exists in only one of the two checkouts must
  //      never be NAMED here: the allowlist entry would be stale in the mirror, so the
  //      shrink-only assertion below would fail there while passing here. A guard whose
  //      verdict depends on which checkout it runs in is not a guard — and nothing in this
  //      checkout would ever show it.
  const listed = execFileSync('git', ['ls-files', 'scripts/*.sh', 'scripts/**/*.sh'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);

  const offenders = new Set<string>();
  let refs = 0;

  for (const rel of listed) {
    let text: string;
    try {
      text = readFileSync(resolve(repoRoot, rel), 'utf-8');
    } catch (err) {
      // M2 — an unreadable input is an ERROR, never an empty one. A tracked file we cannot
      // read must not silently shrink the denominator.
      throw new Error(`unreadable tracked script ${rel}: ${(err as Error).message}`);
    }
    if (!text.includes('$HOME')) continue;
    let heredocEnd: string | null = null;
    for (const line of text.split('\n')) {
      if (heredocEnd !== null) {
        if (line.trim() === heredocEnd) heredocEnd = null;
        continue; // inside a quoted heredoc — the shell expands nothing here
      }
      const open = HEREDOC_QUOTED_OPEN.exec(line);
      if (open) heredocEnd = open[1] ?? open[2];
      if (line.trimStart().startsWith('#')) continue;
      if (!homeExpandsOn(line)) continue;
      refs++;
      if (!SH_SEAM.test(line)) offenders.add(rel);
    }
  }
  return { offenders: [...offenders].sort(), files: listed.length, refs };
}

describe('$HOME must be an injectable default in shell too (d76ab2c8 was a .sh)', () => {
  const REPO_ROOT = resolve(__dirname, '../../../..');
  const { offenders, files, refs } = findUnseamedShellFiles(REPO_ROOT);

  // THIS FILE RUNS IN TWO CHECKOUTS and they hold different script sets: the published
  // mirror ships a subset, so several allowlisted scripts are simply ABSENT there. An entry
  // whose file does not exist here is NOT adjudicable here — treating it as "stale" is the
  // G26/CR-89 error of turning an unavailable INPUT into a verdict, and it made this guard
  // fail in the mirror while passing internally. Absolute floors have the same disease:
  // `refs > 10` is a claim about which checkout you are standing in.
  const present = KNOWN_INLINE_SH.filter((f) => existsSync(resolve(REPO_ROOT, f)));
  const absent = KNOWN_INLINE_SH.filter((f) => !existsSync(resolve(REPO_ROOT, f)));

  it('the scan actually looked (M1 — denominator)', () => {
    // "0 offenders" is also what a sweep pointed at the wrong root, or one whose
    // `git ls-files` returned nothing, reports. Assert the denominator, not the verdict.
    expect(files, 'git ls-files returned 0 tracked scripts — this sweep is blind').toBeGreaterThan(
      50,
    );
    expect(refs, 'found 0 expanding $HOME references at all — the line filter ate everything').
      toBeGreaterThan(0);
    // PRESENCE, not absence, as the anti-vacuity condition (G24): at least one allowlisted
    // file must be here AND still detected. That cannot be satisfied by a sweep that failed
    // to look, whereas "0 problems found" can — and it holds in either checkout.
    expect(
      present.length,
      'no allowlisted script exists in this checkout — the detector cannot demonstrate it fires',
    ).toBeGreaterThan(0);
    expect(
      present.filter((f) => offenders.includes(f)).length,
      'allowlisted scripts are present but NONE was detected — the detector is dead',
    ).toBeGreaterThan(0);
  });

  it('no NEW tracked script builds a path from $HOME without a seam', () => {
    const unexpected = offenders.filter((f) => !KNOWN_INLINE_SH.includes(f));
    expect(
      unexpected,
      'These build a path under the real $HOME with no override seam, so a test cannot ' +
        'redirect them — which is how d76ab2c8 wrote six fixture directories into the live ' +
        'memory store. Use `"${MASSU_SOMETHING:-$HOME/...}"` — do NOT add the file to ' +
        'KNOWN_INLINE_SH, which is shrink-only by design.',
    ).toEqual([]);
  });

  it('the shell allowlist is SHRINK-ONLY — no stale entries', () => {
    // Judged over PRESENT entries only. An absent file is unadjudicable in this checkout,
    // not fixed; scoring it stale here would delete an entry that is still load-bearing in
    // the other one. Absent entries are named below so the skip is announced, never inferred.
    const stale = present.filter((f) => !offenders.includes(f));
    expect(
      stale,
      'These allowlist entries no longer have an unseamed $HOME — delete them. An ' +
        'allowlist that outlives its violations silently re-opens the hole it documents.',
    ).toEqual([]);
  });

  it('reports which allowlist entries this checkout could not adjudicate (M1)', () => {
    // A skip that is counted and named is a decision; a skip that is inferred is silence.
    // This assertion cannot fail — it exists to put the number in the run's output, and it
    // fails loudly only if the allowlist has become entirely unadjudicable.
    // eslint-disable-next-line no-console
    console.log(
      `[shell $HOME sweep] scripts=${files} refs=${refs} offenders=${offenders.length} ` +
        `allowlist=${KNOWN_INLINE_SH.length} (present ${present.length}, ` +
        `absent-in-this-checkout ${absent.length}${absent.length ? `: ${absent.join(', ')}` : ''})`,
    );
    expect(
      present.length + absent.length,
      'the allowlist accounting does not add up',
    ).toBe(KNOWN_INLINE_SH.length);
  });

  it('the originating script KEEPS its seam (the d76ab2c8 regression site)', () => {
    // File-level verdicts are a correlate; assert the specific line the incident was about
    // (G28 — the predicate must BE the property). memory-integrity-check.sh is absent from
    // KNOWN_INLINE_SH precisely because it was fixed, so a silent revert must fail HERE.
    const src = readFileSync(resolve(REPO_ROOT, 'scripts/hooks/memory-integrity-check.sh'), 'utf-8');
    expect(
      src,
      'memory-integrity-check.sh lost its ${MASSU_MEMORY_STORE_ROOT:-...} seam — this is the ' +
        'exact d76ab2c8 defect, which wrote fixtures into the operator\'s live memory store.',
    ).toMatch(/MEMORY_STORE_ROOT="\$\{MASSU_MEMORY_STORE_ROOT:-\$HOME/);
  });
});
