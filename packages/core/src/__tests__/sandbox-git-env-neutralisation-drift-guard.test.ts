// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * G29/CR-92 — every file that CREATES a git repository must neutralise the caller's
 * git environment first.
 *
 * WHY THIS EXISTS
 * ---------------
 * `cd` does not scope git. Neither does `git -C <dir>`, nor `cwd:` on a child process.
 * `GIT_DIR` outranks all three. It is inherited from any CALLER that sets it — a nested
 * git invocation, a wrapper, a test harness, a tool. (Git does NOT hand `GIT_DIR` to the
 * hooks it runs; measured, `scripts/ops/probe-git-hook-env.sh`. Hooks DO inherit
 * `GIT_INDEX_FILE`, which redirects the index on its own, so a sandbox `git add` under a
 * pre-commit hook writes the REAL index with no `GIT_DIR` involved at all.) So a harness
 * that builds a throwaway repo and commits into it — launched from anywhere a leaked
 * `GIT_DIR` is set — does not touch its sandbox.
 * It addresses the REAL repository and records every other tracked file as deleted.
 *
 * 2026-08-04, a sibling repo on this machine: exactly that produced a commit touching
 * 5,543 files and deleting 1,388,627 lines. Caught before it was pushed. Incident #166.
 *
 * WHY A DISCOVERING TEST AND NOT A FILE LIST
 * ------------------------------------------
 * The class was swept four times. Each sweep worked a list, and each list was short:
 * pass 4's brief named 7 files and the real count was 8. **When a candidate set comes
 * from a human list, the list IS the population** — so this test encodes no list. It
 * DISCOVERS the population every run, by the effect that creates the hazard, and fails
 * when a member lacks the guard. A harness added next month is covered by declaring
 * itself (Rule 25). No pass 6.
 *
 * WHAT IT DOES *NOT* COVER — stated as a finding, not buried (G20)
 * ----------------------------------------------------------------
 * It covers files that CREATE a repo. It does NOT cover a file that merely READS git
 * through a path it was handed (`home_path_guard "$root"`, `--repo-root <dir>`), because
 * whether such a read intends the caller's own repo (correct, GIT_DIR points there
 * anyway) or some other tree (a bug) is a JUDGEMENT no regex can make. Pass 5 adjudicated
 * those 30 candidates by hand. `RESIDUAL_UNCOVERED_READERS` below records how many exist
 * so the uncovered surface has a NUMBER rather than a shrug.
 *
 * BLIND-GATE POSTURE
 * ------------------
 *   M1 prove it looked — the discovered population is asserted non-empty and reported.
 *   M2 fail closed — an unreadable file is an ERROR, never an implicit exemption.
 *   M4 fixtures per detection path, each of which must FIRE, plus must-stay-silent ones.
 *
 * THE SECOND OBLIGATION — A NEW REPO MUST ALSO BE BORN WITHOUT THE MACHINE'S HOOKS
 * --------------------------------------------------------------------------------
 * Neutralising GIT_DIR decides WHICH repository git addresses. It says nothing about what a
 * freshly created repository CONTAINS: `git init` / `git clone` copy the machine's
 * `init.templateDir` into `.git/hooks`, so a fixture repo arrives armed with every managed
 * pre-commit check. Since 2026-10-11 that includes `60-secret-scan`, which judged a fixture's
 * secret-shaped commit and bricked a sibling repo's commit gate. The fixtures were fixed
 * (gitSafeEnvForNewRepo); nothing stopped the NEXT one being written with plain gitSafeEnv().
 *
 * So the second half of this file finds every repo-CREATION SITE (not file) and demands the
 * template be stripped at that site: `gitSafeEnvForNewRepo()`, `--template=`, or an empty
 * `GIT_TEMPLATE_DIR`. TS/JS are PARSED (TypeScript compiler API), so a comment or an error
 * message saying "git init" is never a site; shell is read per joined statement at COMMAND
 * POSITION. A fixture that deliberately tests the machine hooks declares itself AT THE SITE:
 *
 *     // git-template-exempt: <why this repo must inherit the machine hooks>
 *
 * on the site's line or in the comment block directly above it. Exemptions are counted and
 * printed; a marker attached to no site is stale and fails.
 *
 * NOT COVERED, stated as findings (G20), each with its number in the report:
 *   - a command assembled by concatenation or held in a variable before reaching exec
 *     (`const c = 'git ' + sub; execSync(c)`) — no literal reaches the call;
 *   - shell wrapper FUNCTIONS (`git_isolated init`): the shell half matches the literal
 *     command word `git`, as the GIT_DIR half above does. The canonical
 *     scripts/lib/git-env-scrub.sh (byte-identical across repos) creates its self-test probe
 *     repos that way, and changing it is a cross-repo canonical change, not a local edit.
 */

import { describe, it, expect } from 'vitest';
import * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
// G29/CR-92 — this guard reads the repo it lives in; keep its own git call honest.
import { gitSafeEnv } from './helpers/git-safe-env.ts';
// console.log is swallowed by this runner; report() reaches the run output.
import { report } from './helpers/report.ts';

const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * "This file creates a git repository."
 *
 * `[^|;&\n]` — the newline exclusion is load-bearing. A negated character class in most
 * regex flavours MATCHES newline, so `git[^|;&]{0,60}\binit\b` pairs a `git` on one line
 * with an `init` three lines below and reports a file that never creates anything. That
 * false positive was observed while building this guard.
 *
 * Every alternative REQUIRES the command to be git. An earlier draft had a third branch
 * matching any argv beginning `['init', …]` with a `cwd:` nearby — it fired on
 * `massu init --yes` in init-tarball-e2e.test.ts, which creates no repository at all. A
 * guard that reads unrelated code as the hazard is one people learn to ignore, so the
 * branch was deleted rather than patched; the two git-anchored forms already cover the
 * node spellings.
 */
const CREATES_A_REPO =
  /\bgit\b[^|;&\n]{0,60}\binit\b|['"`]git['"`]\s*,\s*\[\s*['"`]init['"`]/;

/** Any recognised form of "the caller's git environment has been neutralised". */
const NEUTRALISED =
  /unset\s+GIT_DIR|gitSafeEnv|git_safe_env|GIT_ENV_LEAKS|env\s+-u\s+GIT_DIR|init\.templateDir=/;

/**
 * Files that create a repo but legitimately need the caller's git context, each with a
 * reason. An entry that NO LONGER creates a repo is a stale exemption and fails — an
 * allowlist that is never re-validated is how a gate quietly widens.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'scripts/ci-sync-check.sh',
    'DEPENDS on inheriting the global init.templateDir so the payload-safety hook is ' +
      'present in the ephemeral mirror; see its own comment. It DOES neutralise GIT_DIR ' +
      '(so this entry covers only the template), and is listed here to keep that ' +
      'deliberate dependency reviewed rather than silent.',
  ],
]);

/**
 * Every extension that can carry an executed git call. `.cjs/.mjs/.mts/.cts/.tsx/.jsx` and
 * `.bash` were added with the template half (2026-10-11): an exclusion is a blind spot you
 * chose, and node executes every one of these (G18).
 */
const SOURCE_PATHSPECS = [
  '*.sh', '*.bash', '*.py',
  '*.ts', '*.mts', '*.cts', '*.tsx',
  '*.js', '*.mjs', '*.cjs', '*.jsx',
];

function trackedSources(): string[] {
  let out: string;
  try {
    out = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', '-z', '--', ...SOURCE_PATHSPECS],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, env: gitSafeEnv() },
    );
  } catch (e) {
    throw new Error(
      `cannot look: git ls-files failed (${(e as Error).message}). ` +
        'A discovery failure is an ERROR, never an empty population.',
    );
  }
  const files = out.split('\0').filter(Boolean);
  if (files.length === 0) {
    throw new Error('cannot look: git ls-files returned ZERO tracked sources.');
  }
  return files;
}

function readOrThrow(rel: string): string {
  try {
    return readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
  } catch (e) {
    throw new Error(`cannot look: ${rel} unreadable (${(e as Error).message}) — M2.`);
  }
}

/**
 * A line that is ENTIRELY a comment, in any of the five scanned languages.
 *
 * WHY (2026-08-08): this guard reported `scripts/tests/test-memory-integrity-check.sh`
 * as an unguarded sandbox harness. That file runs no git at all — what matched was its
 * COMMENT saying so: *"No `git init` anywhere in this file: the hook is given its root
 * by env…"*. The guard read prose as code, and it punished a file for DOCUMENTING its
 * own G29 compliance. A detector that fires on the retro explaining the bug teaches
 * people to stop writing the explanation, so the RULE is fixed here rather than the
 * comment reworded.
 *
 * SAFE BY CONSTRUCTION — nothing executable can hide behind this. Only a line whose
 * FIRST non-whitespace characters open a comment is skipped; a `#` appearing mid-line
 * (`X=$(git init) # set up`) leaves the code before it intact and still matches.
 *
 * KNOWN LIMIT, stated rather than buried (G20): a whole-line `#` inside a heredoc that
 * is written out and later executed would be skipped here. That generated script is
 * itself a `git init` site, and is covered when it is tracked.
 */
const FULL_LINE_COMMENT = /^[ \t]*(#|\/\/|\*|<!--)/;

/**
 * Does this file create a repo in EXECUTABLE code?
 *
 * Matching is per line, which is not a change in reach: `CREATES_A_REPO` excludes `\n`,
 * so it never spanned lines in the first place. The only difference is that full-line
 * comments no longer count.
 */
function createsARepo(text: string): boolean {
  return text
    .split('\n')
    .some((line) => !FULL_LINE_COMMENT.test(line) && CREATES_A_REPO.test(line));
}

interface Scan {
  scanned: number;
  creators: string[];
  unguarded: string[];
}

function scan(): Scan {
  const creators: string[] = [];
  const unguarded: string[] = [];
  const files = trackedSources();
  for (const rel of files) {
    // This guard describes the patterns it hunts, so it would flag itself.
    if (rel.endsWith('sandbox-git-env-neutralisation-drift-guard.test.ts')) continue;
    const text = readOrThrow(rel);
    if (!createsARepo(text)) continue;
    creators.push(rel);
    if (ALLOWLIST.has(rel)) continue;
    if (!NEUTRALISED.test(text)) unguarded.push(rel);
  }
  return { scanned: files.length, creators, unguarded };
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// THE TEMPLATE HALF — every repo-CREATION SITE strips init.templateDir (2026-10-11)
// ═════════════════════════════════════════════════════════════════════════════════════════

/** A git subcommand that copies the machine template into a new `.git/hooks`. */
const CREATING_SUBCOMMANDS = new Set(['init', 'clone']);

/** Git GLOBAL options that consume the following argv token (`git -C <dir> init`). */
const GLOBAL_OPTS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path',
]);

/**
 * The process-spawning API, DERIVED from node:child_process itself rather than typed out
 * (G32) — a function node adds there is covered here without an edit.
 */
const SPAWNERS: ReadonlySet<string> = new Set(
  Object.entries(childProcess)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k),
);

/** The declared-at-site exemption. Reason must be a sentence, not a token. */
const EXEMPT_MARKER = /(?:#|\/\/|\/\*|\*)\s*git-template-exempt:\s*(.*)$/;
const MIN_EXEMPT_REASON = 20;

/** A line that is entirely a comment — for exemption-block adjacency only. */
const COMMENT_LINE = /^[ \t]*(#|\/\/|\/\*|\*|<!--)/;

/**
 * `git … init|clone` at COMMAND POSITION in a shell string. Prose like
 * `echo "…: git init failed"` or `"not a git clone"` has no command boundary before `git`
 * and does not match. Groups: 1 = prefix (env/command/VAR= assignments), 2 = git global
 * options, 3 = subcommand, 4 = the rest of that command up to the next separator.
 */
const Q = String.raw`(?:"[^"]*"|'[^']*')`;
const SHELL_CREATE = new RegExp(
  String.raw`(?:^|[;&|({!\x60]|\$\(|\b(?:then|do|else|if|while|until)\b)[ \t]*` +
    String.raw`((?:(?:command|exec|env|time|nice|nohup)[ \t]+(?:(?:-u[ \t]+\S+|-i|[A-Za-z_]\w*=(?:${Q}|\S*)|${Q})[ \t]+)*)*` +
    String.raw`(?:[A-Za-z_]\w*=(?:${Q}|[^\s;&|]*)[ \t]+)*)` +
    String.raw`git((?:[ \t]+(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)[ \t]+(?:${Q}|\S+)|[ \t]+-[-\w]+(?:=(?:${Q}|\S*))?)*)` +
    String.raw`[ \t]+(init|clone)\b([^;&|\n]*)`,
  'gm',
);

const EMPTY_VALUE = String.raw`(?:""|''|(?=[\s;&|)]|$))`;
const PREFIX_STRIPS = new RegExp(
  String.raw`GIT_TEMPLATE_DIR=${EMPTY_VALUE}|\$\{?GIT_ENV_TEMPLATE_NEUTRALISE\}?`,
);
const ARG_STRIPS = new RegExp(String.raw`(?:^|\s)--template=${EMPTY_VALUE}`);

interface ShellHit {
  sub: string;
  stripped: boolean;
  offset: number;
}

/**
 * Blank the inside of quoted shell strings (length-preserving), keeping `$(…)` inside double
 * quotes because that IS executed. Without this, `echo "ABORT (git clone failed)"` reads as a
 * clone at command position after `(` — observed on the real tree while building this.
 */
function maskQuoted(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? text.length : end;
      for (let j = i + 1; j < stop; j++) out[j] = ' ';
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          out[j] = ' ';
          if (j + 1 < text.length) out[j + 1] = ' ';
          j += 2;
          continue;
        }
        if (text[j] === '$' && text[j + 1] === '(') {
          let depth = 0;
          for (; j < text.length; j++) {
            if (text[j] === '(') depth++;
            else if (text[j] === ')' && --depth === 0) break;
          }
          j++;
          continue;
        }
        out[j] = ' ';
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

function shellScan(text: string): ShellHit[] {
  const hits: ShellHit[] = [];
  for (const masked of maskQuoted(text).matchAll(SHELL_CREATE)) {
    // Judge the strip on the ORIGINAL bytes: `"${GIT_ENV_TEMPLATE_NEUTRALISE}"` is quoted.
    const start = masked.index ?? 0;
    const orig = text.slice(start, start + masked[0].length);
    const m = new RegExp(SHELL_CREATE.source, 'm').exec(orig) ?? masked;
    const [, prefix = '', globals = '', , rest = ''] = m;
    hits.push({
      sub: masked[3] ?? '',
      stripped: PREFIX_STRIPS.test(prefix) || ARG_STRIPS.test(globals) || ARG_STRIPS.test(rest),
      offset: start,
    });
  }
  return hits;
}

/** First non-option argv token, skipping the values global options consume. */
function gitSubcommand(tokens: ReadonlyArray<string | null>): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === null) return null; // a non-literal where the subcommand would be: unknowable
    if (GLOBAL_OPTS_WITH_VALUE.has(t)) {
      i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    return t;
  }
  return null;
}

function argvStrips(tokens: ReadonlyArray<string | null>): boolean {
  return tokens.some(
    (t, i) => t === '--template=' || (t === '--template' && tokens[i + 1] === ''),
  );
}

interface CreationSite {
  file: string;
  line: number;
  form: string;
  stripped: boolean;
  exempt: string | null;
}

interface FileVerdict {
  sites: CreationSite[];
  /** exemption marker lines that no site consumed */
  staleMarkers: number[];
  /** markers whose reason is too short to be a reason */
  thinMarkers: number[];
}

/** Exemption attached to `line` (1-based): on it, or in the comment block directly above. */
function exemptionFor(lines: string[], line: number, consumed: Set<number>): string | null {
  const probe = (n: number): string | null => {
    const m = EXEMPT_MARKER.exec(lines[n - 1] ?? '');
    if (!m) return null;
    consumed.add(n);
    return (m[1] ?? '').replace(/\*\/\s*$/, '').trim();
  };
  const own = probe(line);
  if (own !== null) return own;
  for (let n = line - 1; n >= 1 && COMMENT_LINE.test(lines[n - 1] ?? ''); n--) {
    const r = probe(n);
    if (r !== null) return r;
  }
  return null;
}

function markerLines(lines: string[]): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (EXEMPT_MARKER.test(l)) out.push(i + 1);
  });
  return out;
}

function finish(rel: string, lines: string[], raw: Omit<CreationSite, 'exempt' | 'file'>[]): FileVerdict {
  const consumed = new Set<number>();
  const sites = raw.map((s) => ({ ...s, file: rel, exempt: exemptionFor(lines, s.line, consumed) }));
  const all = markerLines(lines);
  return {
    sites,
    staleMarkers: all.filter((n) => !consumed.has(n)),
    thinMarkers: sites
      .filter((s) => s.exempt !== null && s.exempt.length < MIN_EXEMPT_REASON)
      .map((s) => s.line),
  };
}

// ── TS / JS: parsed, so comments and non-exec strings are structurally invisible ────────

function scriptKind(rel: string): ts.ScriptKind {
  if (/\.(tsx)$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.(jsx)$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.(m?c?ts)$/.test(rel)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return null;
}

function stringText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    return n.head.text + n.templateSpans.map((s) => 'X' + s.literal.text).join('');
  }
  return null;
}

function tsSites(rel: string, text: string): FileVerdict {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diags.length > 0) {
    throw new Error(
      `cannot look: ${rel} does not parse (${diags.length} diagnostic(s), first: ` +
        `${ts.flattenDiagnosticMessageText(diags[0]!.messageText, ' ')}) — M2.`,
    );
  }

  // Local bindings: const strings, const objects, and functions (candidate wrappers).
  const consts = new Map<string, ts.Expression>();
  const fns = new Map<string, ts.Node>();
  const allCalls: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      consts.set(n.name.text, n.initializer);
    }
    const fn = functionName(n);
    if (fn) fns.set(fn, ts.isVariableDeclaration(n) ? n.initializer! : n);
    if (ts.isCallExpression(n)) allCalls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const resolveExpr = (e: ts.Expression, depth = 0): ts.Expression => {
    if (depth < 4 && ts.isIdentifier(e) && consts.has(e.text)) {
      return resolveExpr(consts.get(e.text)!, depth + 1);
    }
    return e;
  };
  const resolvedString = (e: ts.Expression | undefined): string | null =>
    e ? stringText(resolveExpr(e)) : null;

  const callsWithin = (n: ts.Node): ts.CallExpression[] =>
    allCalls.filter((c) => c.pos >= n.pos && c.end <= n.end && c !== n);

  // A wrapper is a local function whose body spawns, directly or through another wrapper.
  const wrappers = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, node] of fns) {
      if (wrappers.has(name)) continue;
      if (callsWithin(node).some((c) => {
        const k = calleeName(c);
        return k !== null && (SPAWNERS.has(k) || wrappers.has(k));
      })) {
        wrappers.add(name);
        changed = true;
      }
    }
  }

  /** env value that guarantees an empty GIT_TEMPLATE_DIR. Last writer wins. */
  const envStrips = (e: ts.Expression, depth = 0): boolean => {
    const x = resolveExpr(e);
    if (ts.isCallExpression(x)) return calleeName(x) === 'gitSafeEnvForNewRepo';
    if (ts.isObjectLiteralExpression(x) && depth < 4) {
      let on = false;
      for (const p of x.properties) {
        if (ts.isSpreadAssignment(p)) on = envStrips(p.expression, depth + 1);
        else if (
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          p.name.text === 'GIT_TEMPLATE_DIR'
        ) {
          on = resolvedString(p.initializer) === '';
        }
      }
      return on;
    }
    return false;
  };
  const optionsStrip = (call: ts.CallExpression): boolean =>
    call.arguments.some((a) => {
      const o = resolveExpr(a);
      if (!ts.isObjectLiteralExpression(o)) return false;
      return o.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'env' &&
            envStrips(p.initializer)) ||
          (ts.isShorthandPropertyAssignment(p) && p.name.text === 'env' && envStrips(p.name)),
      );
    });

  // Does a wrapper strip on EVERY spawning path? Monotone fixed point from "no".
  const wrapperStrips = new Map<string, boolean>([...wrappers].map((w) => [w, false]));
  const callStripsByEnv = (c: ts.CallExpression): boolean => {
    const k = calleeName(c);
    if (k !== null && wrappers.has(k) && !SPAWNERS.has(k)) return wrapperStrips.get(k)! || optionsStrip(c);
    return optionsStrip(c);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of wrappers) {
      if (wrapperStrips.get(w)) continue;
      const inner = callsWithin(fns.get(w)!).filter((c) => {
        const k = calleeName(c);
        return k !== null && (SPAWNERS.has(k) || wrappers.has(k));
      });
      if (inner.length > 0 && inner.every(callStripsByEnv)) {
        wrapperStrips.set(w, true);
        changed = true;
      }
    }
  }

  const arrayTokens = (e: ts.Expression | undefined): Array<string | null> | null => {
    if (!e) return null;
    const x = resolveExpr(e);
    if (!ts.isArrayLiteralExpression(x)) return null;
    return x.elements.map((el) => (ts.isSpreadElement(el) ? null : resolvedString(el)));
  };

  const raw: Omit<CreationSite, 'exempt' | 'file'>[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  for (const call of allCalls) {
    const k = calleeName(call);
    if (k === null) continue;
    const isSpawner = SPAWNERS.has(k) && !fns.has(k);
    const isWrapper = wrappers.has(k) || (!isSpawner && /git/i.test(k));
    if (!isSpawner && !isWrapper) continue;

    const envOk = callStripsByEnv(call);
    const found: Array<{ form: string; stripped: boolean }> = [];

    if (isSpawner) {
      const bin = resolvedString(call.arguments[0]);
      const argv = arrayTokens(call.arguments[1]);
      if (bin === 'git' && argv) {
        const sub = gitSubcommand(argv);
        if (sub && CREATING_SUBCOMMANDS.has(sub)) {
          found.push({ form: `${k}('git', [${sub}…])`, stripped: argvStrips(argv) });
        }
      } else if (bin !== null && /^(?:\/\S*\/)?(?:ba|z|da)?sh$/.test(bin) && argv) {
        const ci = argv.indexOf('-c');
        const script = ci >= 0 ? argv[ci + 1] : null;
        for (const h of script ? shellScan(script) : []) {
          found.push({ form: `${k}('${bin}', ['-c', 'git ${h.sub}…'])`, stripped: h.stripped });
        }
      } else if (bin !== null) {
        for (const h of shellScan(bin)) {
          found.push({ form: `${k}('git ${h.sub}…')`, stripped: h.stripped });
        }
      }
    } else {
      // Wrapper: the literal argv it is handed, skipping leading non-literals (a cwd).
      const tokens: Array<string | null> = [];
      for (const a of call.arguments) {
        const s = resolvedString(a);
        const arr = arrayTokens(a);
        if (s !== null) tokens.push(s);
        else if (arr) tokens.push(...arr);
        else if (tokens.length > 0) tokens.push(null);
        if (s !== null) {
          for (const h of shellScan(s)) {
            found.push({ form: `${k}('git ${h.sub}…')`, stripped: h.stripped });
          }
        }
      }
      if (tokens[0] === 'git') tokens.shift();
      const sub = gitSubcommand(tokens);
      if (sub && CREATING_SUBCOMMANDS.has(sub)) {
        found.push({ form: `${k}(… ${sub} …)`, stripped: argvStrips(tokens) });
      }
    }

    for (const f of found) {
      raw.push({ line: lineOf(call), form: f.form, stripped: f.stripped || envOk });
    }
  }
  return finish(rel, text.split('\n'), raw);
}

// ── Shell: joined statements, command position, file-level `export GIT_TEMPLATE_DIR=""` ──

const EXPORT_EMPTY = new RegExp(String.raw`^\s*export\s+GIT_TEMPLATE_DIR=(?:""|''|)\s*(?:[;#].*)?$`);
const TEMPLATE_REARMED = /^\s*(?:unset\b[^#]*\bGIT_TEMPLATE_DIR\b|(?:export\s+)?GIT_TEMPLATE_DIR=(?!""|''|\s|$)\S)/;

function shellSites(rel: string, text: string): FileVerdict {
  const lines = text.split('\n');
  const raw: Omit<CreationSite, 'exempt' | 'file'>[] = [];
  let exported = false;
  for (let i = 0; i < lines.length; i++) {
    const start = i + 1;
    let stmt = lines[i]!;
    while (/\\$/.test(stmt) && i + 1 < lines.length) stmt = stmt.slice(0, -1) + ' ' + lines[++i]!;
    if (COMMENT_LINE.test(stmt)) continue;
    if (EXPORT_EMPTY.test(stmt)) {
      exported = true;
      continue;
    }
    if (TEMPLATE_REARMED.test(stmt)) exported = false;
    for (const h of shellScan(stmt)) {
      // A `#` before the hit means the hit is inside a trailing comment.
      const before = stmt.slice(0, h.offset);
      if (/(^|\s)#/.test(before.replace(/"[^"]*"|'[^']*'/g, ''))) continue;
      raw.push({ line: start, form: `git ${h.sub}`, stripped: h.stripped || exported });
    }
  }
  return finish(rel, lines, raw);
}

// ── Python: argv lists and command strings, per non-comment line ────────────────────────

function pythonSites(rel: string, text: string): FileVerdict {
  const lines = text.split('\n');
  const raw: Omit<CreationSite, 'exempt' | 'file'>[] = [];
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const strips = /--template=(?:["']\s*[,\]]|["']{2})|GIT_TEMPLATE_DIR/.test(line);
    for (const m of line.matchAll(/\[\s*(['"])git\1\s*,([^\]]*)\]/g)) {
      const toks = (m[2] ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (/^(['"]).*\1$/.test(t) ? t.slice(1, -1) : null));
      const sub = gitSubcommand(toks);
      if (sub && CREATING_SUBCOMMANDS.has(sub)) {
        raw.push({ line: i + 1, form: `["git", "${sub}", …]`, stripped: strips || argvStrips(toks) });
      }
    }
    for (const m of line.matchAll(/f?(['"])((?:\\.|(?!\1).)*)\1/g)) {
      for (const h of shellScan(m[2] ?? '')) {
        raw.push({ line: i + 1, form: `"git ${h.sub} …"`, stripped: h.stripped || strips });
      }
    }
  });
  return finish(rel, lines, raw);
}

function creationSites(rel: string, text: string): FileVerdict {
  if (/\.(sh|bash)$/.test(rel)) return shellSites(rel, text);
  if (/\.py$/.test(rel)) return pythonSites(rel, text);
  return tsSites(rel, text);
}

interface TemplateScan {
  scanned: number;
  examined: number;
  sites: CreationSite[];
  stale: string[];
  thin: string[];
}

function templateScan(): TemplateScan {
  const files = trackedSources();
  const sites: CreationSite[] = [];
  const stale: string[] = [];
  const thin: string[] = [];
  let examined = 0;
  for (const rel of files) {
    if (rel.endsWith('sandbox-git-env-neutralisation-drift-guard.test.ts')) continue;
    const text = readOrThrow(rel);
    // A site needs the literal subcommand AND `git`; a marker needs its token. Cheap filter.
    if (!/\b(?:init|clone)\b/.test(text) && !text.includes('git-template-exempt')) continue;
    examined++;
    const v = creationSites(rel, text);
    sites.push(...v.sites);
    stale.push(...v.staleMarkers.map((n) => `${rel}:${n}`));
    thin.push(...v.thinMarkers.map((n) => `${rel}:${n}`));
  }
  return { scanned: files.length, examined, sites, stale, thin };
}

function denominatorLine(t: TemplateScan): string {
  const exempt = t.sites.filter((s) => !s.stripped && s.exempt !== null);
  const armed = t.sites.filter((s) => !s.stripped && s.exempt === null);
  return (
    `[git-template] scanned ${t.scanned} tracked sources; examined ${t.examined}; ` +
    `${t.sites.length} repo-creation site(s): ${t.sites.filter((s) => s.stripped).length} stripped, ` +
    `${exempt.length} exempt, ${armed.length} ARMED; stale markers ${t.stale.length}`
  );
}

describe('G29/CR-92 — sandbox git-env neutralisation (Incident #166)', () => {
  it('reports a real denominator (M1 — "scanned 0, found 0" is never a pass)', () => {
    const { scanned, creators } = scan();
    expect(scanned, 'tracked sources scanned').toBeGreaterThan(500);
    expect(
      creators.length,
      'files that create a git repo — if this is 0 the detector is dead, not the repo clean',
    ).toBeGreaterThan(0);
  });

  it('every repo-creating file neutralises the caller git environment', () => {
    const { scanned, creators, unguarded } = scan();
    expect(
      unguarded,
      `UNGUARDED sandbox git harness(es).\n` +
        `  scanned ${scanned} tracked sources; ${creators.length} create a repo.\n` +
        `  Each file below runs \`git init\` without first neutralising GIT_DIR, so when it\n` +
        `  is invoked from a git hook it addresses the REAL repository instead of its\n` +
        `  sandbox — writing to the wrong tree and adjudicating the wrong tree.\n` +
        `  Shell (executed): unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY\n` +
        `                          GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX\n` +
        `  Shell (sourced) : an \`env -u GIT_DIR …\` wrapper — a bare unset would mutate the caller.\n` +
        `  TypeScript      : env: gitSafeEnv()   from ./helpers/git-safe-env.ts\n` +
        `  Python          : env=git_safe_env()  from scripts/lib/git_safe_env.py`,
    ).toEqual([]);
  });

  it('no allowlist entry is stale (an unre-validated exemption widens the gate)', () => {
    const { creators } = scan();
    const stale = [...ALLOWLIST.keys()].filter((f) => !creators.includes(f));
    expect(
      stale,
      'allowlisted file(s) that no longer create a repo — remove the exemption',
    ).toEqual([]);
  });

  it('the allowlist carries a reason for every entry', () => {
    for (const [file, reason] of ALLOWLIST) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  // ── M4: one fixture per detection path, each of which MUST fire ──────────────
  it('DETECTS every spelling of "creates a repo"', () => {
    const mustMatch: Array<[string, string]> = [
      ['plain shell', 'git init -q .'],
      ['shell with -C', 'git -C "$SCRATCH" init -q'],
      ['shell with --git-dir', 'git --git-dir=/tmp/x init'],
      ['node argv', `execFileSync('git', ['init', '--quiet'], { cwd: testRepo })`],
      ['node spawnSync argv', `spawnSync('git', ['init', '-q'], { cwd: sandbox })`],
      ['python argv', `subprocess.run(["git", "init", "-q", d])`],
      ['python f-string', `os.system(f"git init {d}")`],
    ];
    for (const [label, src] of mustMatch) {
      expect(CREATES_A_REPO.test(src), `detection path "${label}" did not fire on: ${src}`).toBe(
        true,
      );
    }
  });

  it('does NOT fire on unrelated git usage (a gate that cries wolf gets ignored)', () => {
    const mustNotMatch: Array<[string, string]> = [
      ['status', 'git status --porcelain'],
      ['ls-files', `execSync('git ls-files', { cwd: REPO_ROOT })`],
      ['rev-parse', 'git rev-parse --show-toplevel'],
      [
        'cross-line false pair',
        'const a = git;\nconst b = 2;\nconst c = 3;\nfunction init() {}',
      ],
      // Regression pin: this exact shape was the guard's first false positive
      // (init-tarball-e2e.test.ts:239). `massu init` creates no repository.
      [
        'a non-git CLI whose argv starts with init',
        `spawnSync(cliBin, ['init', '--yes', '--skip-side-effects'],\n  {\n    cwd: fixtureRoot,\n  })`,
      ],
      ['npm init', `spawnSync('npm', ['init', '-y'], { cwd: dir })`],
    ];
    for (const [label, src] of mustNotMatch) {
      expect(CREATES_A_REPO.test(src), `false positive on "${label}": ${src}`).toBe(false);
    }
  });

  // ── Regression pins for the 2026-08-08 prose false positive ────────────────
  it('does NOT read a COMMENT as a git-init site', () => {
    const proseOnly: Array<[string, string]> = [
      // The exact shape that fired, from scripts/tests/test-memory-integrity-check.sh.
      [
        'shell comment declaring compliance',
        '# No `git init` anywhere in this file: the hook is given its root by env, so\n' +
          '# the harness never needs a repo.\nSANDBOX="$(mktemp -d)"',
      ],
      ['ts line comment', '// a harness must neutralise before git init\nconst x = 1;'],
      ['jsdoc continuation', ' * builds a sandbox with git init, so it must scrub GIT_DIR'],
      ['python comment', '# git init is deliberately not used here\nimport os'],
      ['markdown-ish html comment', '<!-- git init in a doc block -->'],
    ];
    for (const [label, src] of proseOnly) {
      expect(createsARepo(src), `false positive on prose "${label}"`).toBe(false);
    }
  });

  it('a comment CANNOT hide an executable git init (the fix must not weaken the gate)', () => {
    const stillHazardous: Array<[string, string]> = [
      ['code with a trailing comment', 'git init -q "$SANDBOX"   # set up the fixture'],
      ['code then comment line', 'git init -q .\n# explained above'],
      ['comment line then code', '# about to build a sandbox\ngit -C "$D" init -q'],
      ['indented code after comments', '  # note\n  git init -q'],
      ['assignment with inline comment', 'OUT=$(git init -q "$D") # capture'],
    ];
    for (const [label, src] of stillHazardous) {
      expect(createsARepo(src), `MISSED a real hazard: "${label}"`).toBe(true);
    }
  });

  it('recognises every neutralisation form actually used in this repo', () => {
    const forms = [
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
      'env -u GIT_DIR -u GIT_WORK_TREE git "$@"',
      'env: gitSafeEnv()',
      'env=git_safe_env()',
      'const GIT_ENV_LEAKS = [',
    ];
    for (const f of forms) {
      expect(NEUTRALISED.test(f), `neutralisation form not recognised: ${f}`).toBe(true);
    }
    expect(NEUTRALISED.test('const x = 1;'), 'must not match arbitrary code').toBe(false);
  });
});

describe('G29 template half — a repo-creation site must strip init.templateDir (2026-10-11)', () => {
  /** Sites in an in-memory source, for fixtures. */
  const sitesOf = (rel: string, src: string) => creationSites(rel, src).sites;
  const armed = (rel: string, src: string) =>
    sitesOf(rel, src).filter((s) => !s.stripped && s.exempt === null);

  it('reports its denominator, and the population is real (M1)', () => {
    const t = templateScan();
    // Printed every run: the denominator is part of the verdict, not a debug aid.
    report(denominatorLine(t));
    expect(t.scanned, 'tracked sources scanned').toBeGreaterThan(500);
    expect(t.examined, 'files examined after the literal prefilter').toBeGreaterThan(0);
    expect(
      t.sites.length,
      'repo-creation sites — 0 means the detector is dead, not the repo clean',
    ).toBeGreaterThan(0);
    // The TS fixtures routed through gitSafeEnvForNewRepo must be SEEN as stripped sites,
    // or the parser half is blind and this file is green by omission.
    expect(
      t.sites.filter((s) => /\.(?:m?c?[jt]sx?)$/.test(s.file) && s.stripped).length,
      'stripped TS/JS creation sites',
    ).toBeGreaterThan(5);
    expect(
      t.sites.filter((s) => /\.(?:sh|bash)$/.test(s.file)).length,
      'shell creation sites',
    ).toBeGreaterThan(5);
  });

  it('every repo-creation site strips the machine template or declares why it must not', () => {
    const t = templateScan();
    const bad = t.sites.filter((s) => !s.stripped && s.exempt === null);
    const exempt = t.sites.filter((s) => !s.stripped && s.exempt !== null);
    report(
      `[git-template] sites:\n` +
        t.sites
          .map((s) => `  ${s.stripped ? 'stripped' : s.exempt !== null ? 'EXEMPT  ' : 'ARMED   '} ${s.file}:${s.line}  ${s.form}`)
          .join('\n'),
    );
    report(
      `[git-template] exemptions (${exempt.length}):\n` +
        exempt.map((s) => `  ${s.file}:${s.line}  ${s.exempt}`).join('\n'),
    );
    expect(
      bad.map((s) => `${s.file}:${s.line}  ${s.form}`),
      `TEMPLATE-ARMED repo creation.\n  ${denominatorLine(t)}\n` +
        `  Each site below creates a repository that inherits the machine's init.templateDir,\n` +
        `  so it is born with every managed pre-commit check (secret scan included), which then\n` +
        `  judges whatever the fixture commits.\n` +
        `  TypeScript : env: gitSafeEnvForNewRepo()   from ./helpers/git-safe-env.ts\n` +
        `  any argv   : --template=\n` +
        `  shell      : export GIT_TEMPLATE_DIR=""  (or mk_git_sandbox, or GIT_TEMPLATE_DIR= git init)\n` +
        `  deliberate : // git-template-exempt: <why it must inherit the machine hooks>`,
    ).toEqual([]);
  });

  it('no exemption marker is stale, and each carries a real reason', () => {
    const t = templateScan();
    expect(t.stale, 'git-template-exempt marker(s) attached to no creation site').toEqual([]);
    expect(t.thin, `exemption reason(s) shorter than ${MIN_EXEMPT_REASON} chars`).toEqual([]);
  });

  // ── M4: one fixture per detection path; each MUST be found ARMED ─────────────────────
  it('FIRES on every detection path when the template is not stripped', () => {
    const decl = `import { execFileSync, execSync, spawnSync } from 'node:child_process';\n`;
    const mustFire: Array<[string, string, string]> = [
      ['spawner argv', 'a.test.ts', `execFileSync('git', ['init', '-q'], { cwd: d, env: gitSafeEnv() });`],
      ['argv with global option', 'a.test.ts', `spawnSync('git', ['-C', d, 'init'], { env: gitSafeEnv() });`],
      ['clone argv', 'a.test.ts', `execFileSync('git', ['clone', '-q', src, dst]);`],
      ['binary held in a const', 'a.test.ts', `const GIT = 'git';\nexecFileSync(GIT, ['init']);`],
      ['shell string', 'a.test.ts', `execSync('git init -q -b main', { cwd: d });`],
      ['template literal', 'a.test.ts', 'execSync(`git -C ${d} init -q`, { env: gitSafeEnv() });'],
      ['bash -c', 'a.test.ts', `execFileSync('bash', ['-c', 'cd x && git init -q']);`],
      [
        'function wrapper, argv',
        'a.test.ts',
        `function git(a: string[]) { return execFileSync('git', a, { env: gitSafeEnv() }); }\ngit(['init', '-q']);`,
      ],
      [
        'arrow wrapper with a non-git name',
        'a.test.ts',
        `const g = (a: string[]) => execFileSync('git', ['-C', d, ...a], { env: gitSafeEnv() });\ng(['init']);`,
      ],
      [
        'wrapper taking a leading cwd',
        'a.test.ts',
        `function git(cwd: string, ...a: string[]) { return spawnSync('git', a, { cwd }); }\ngit(dir, 'init', '-q');`,
      ],
      [
        'wrapper taking a shell string',
        'a.test.ts',
        `function runInTmp(cmd: string) { return execSync(cmd, { env: gitSafeEnv() }); }\nrunInTmp('git init -q');`,
      ],
      ['imported git-named helper', 'a.test.ts', `gitIn(dir, 'clone', src);`],
      [
        'env that re-arms after the strip',
        'a.test.ts',
        `execFileSync('git', ['init'], { env: { ...gitSafeEnvForNewRepo(), ...process.env } });`,
      ],
      ['options through a variable', 'a.test.ts', `const opts = { env: gitSafeEnv() };\nexecFileSync('git', ['init'], opts);`],
      ['JS module', 'a.mjs', `execFileSync('git', ['init']);`],
      ['shell: plain', 'a.sh', `git init -q "$D"`],
      ['shell: -C', 'a.sh', `git -C "$D" init -q`],
      ['shell: if ! clone', 'a.sh', `if ! git clone --quiet "$A" "$B"; then exit 2; fi`],
      ['shell: after &&', 'a.sh', `mkdir -p x && cd x && git init -q .`],
      ['shell: continuation under env', 'a.sh', `command env -u GIT_DIR \\\n  git init -q .`],
      ['shell: export AFTER the site', 'a.sh', `git init -q .\nexport GIT_TEMPLATE_DIR=""`],
      ['shell: re-armed by unset', 'a.sh', `export GIT_TEMPLATE_DIR=""\nunset GIT_TEMPLATE_DIR\ngit init -q .`],
      ['shell: $(…) inside double quotes executes', 'a.sh', `OUT="$(git init -q "$D")"`],
      ['python argv', 'a.py', `subprocess.run(["git", "init", "-q", d])`],
      ['python command string', 'a.py', `os.system(f"git init {d}")`],
    ];
    for (const [label, rel, src] of mustFire) {
      const body = /\.[mc]?[jt]sx?$/.test(rel) ? decl + src : src;
      expect(armed(rel, body).length, `detection path "${label}" did not fire:\n${src}`).toBe(1);
    }
  });

  it('stays SILENT on every recognised strip form (a brick gate gets bypassed)', () => {
    const mustStrip: Array<[string, string, string]> = [
      ['gitSafeEnvForNewRepo()', 'a.test.ts', `execFileSync('git', ['init'], { env: gitSafeEnvForNewRepo() });`],
      [
        'spread of it, plus metadata',
        'a.test.ts',
        `execFileSync('git', ['init'], { env: { ...gitSafeEnvForNewRepo(), GIT_AUTHOR_NAME: 't' } });`,
      ],
      ['explicit empty GIT_TEMPLATE_DIR', 'a.test.ts', `execFileSync('git', ['init'], { env: { ...gitSafeEnv(), GIT_TEMPLATE_DIR: '' } });`],
      ['--template= argv', 'a.test.ts', `execFileSync('git', ['init', '--template=', '-q']);`],
      ['shell-string prefix', 'a.test.ts', `execSync("GIT_TEMPLATE_DIR= git init -q");`],
      [
        'stripped wrapper',
        'a.test.ts',
        `function git(a: string[]) { return execFileSync('git', a, { env: gitSafeEnvForNewRepo() }); }\ngit(['init']);`,
      ],
      [
        'stripped shell-string wrapper',
        'a.test.ts',
        `function runInTmp(cmd: string, env = {}) { return execSync(cmd, { env: gitSafeEnvForNewRepo(env) }); }\nrunInTmp('git init -q');`,
      ],
      ['shell: file-level export', 'a.sh', `export GIT_TEMPLATE_DIR=""\ngit init -q .`],
      ['shell: command prefix', 'a.sh', `GIT_TEMPLATE_DIR= git init -q .`],
      ['shell: --template=', 'a.sh', `git clone --template= "$A" "$B"`],
      ['shell: the scrub lib constant', 'a.sh', `command env "\${GIT_ENV_TEMPLATE_NEUTRALISE}" \\\n  git -C "$d" init -q .`],
      ['python --template=', 'a.py', `subprocess.run(["git", "init", "--template=", d])`],
    ];
    for (const [label, rel, src] of mustStrip) {
      const s = sitesOf(rel, src);
      expect(s.length, `strip form "${label}" was not even SEEN as a site:\n${src}`).toBe(1);
      expect(s[0]!.stripped, `strip form "${label}" not recognised:\n${src}`).toBe(true);
    }
  });

  it('is NOT a site: prose, messages, other subcommands, other binaries', () => {
    const notASite: Array<[string, string, string]> = [
      ['ts comment', 'a.test.ts', `// execSync('git init -q')\nconst x = 1;`],
      ['ts block comment', 'a.test.ts', `/* execFileSync('git', ['init']) */\nconst x = 1;`],
      ['assertion message', 'a.test.ts', `expect(x, 'run git init first').toBe(1);`],
      ['thrown message', 'a.test.ts', 'throw new Error(`mk_sandbox: git init failed in ${d}`);'],
      ['commit message "init"', 'a.test.ts', `execFileSync('git', ['commit', '-qm', 'init']);`],
      ['wrapper commit message "init"', 'a.test.ts', `function git(a: string[]) { return execFileSync('git', a); }\ngit(['commit', '-m', 'init']);`],
      ['non-git CLI init', 'a.test.ts', `spawnSync(cliBin, ['init', '--yes']);`],
      ['npm init', 'a.test.ts', `spawnSync('npm', ['init', '-y']);`],
      ['string never executed', 'a.test.ts', `const doc = 'git init';`],
      ['echo of prose', 'a.test.ts', `execSync('echo "not a git init"');`],
      ['shell comment', 'a.sh', `# git init -q here`],
      ['shell prose in echo', 'a.sh', `echo "[install-hooks] no .git/ — not a git clone, skipping" >&2`],
      ['shell remedy string', 'a.sh', `_fail "absent" "git clone --depth 1 https://x \\"$P\\""`],
      ['shell trailing comment', 'a.sh', `true  # then git init -q`],
      // Regression pin: the real-tree false positive, test-ci-parity-regression.sh:36.
      ['shell: parenthesis inside an echo string', 'a.sh', `echo "ABORT (git clone failed; see log)"`],
      ['shell: separator inside single quotes', 'a.sh', `echo 'a; git init -q'`],
      ['python comment', 'a.py', `# git init is not used here`],
      ['python prose string', 'a.py', `print("withdraw via depth-1 git clone")`],
    ];
    for (const [label, rel, src] of notASite) {
      expect(sitesOf(rel, src), `false site on "${label}":\n${src}`).toEqual([]);
    }
  });

  it('honours an at-site exemption, counts it, and rejects a stale or thin one', () => {
    const exempted = creationSites(
      'a.sh',
      `# git-template-exempt: the mirror clone must carry the managed payload-safety hook\ngit init -q "$M"`,
    );
    expect(exempted.sites.length).toBe(1);
    expect(exempted.sites[0]!.exempt).toMatch(/payload-safety/);
    expect(exempted.staleMarkers).toEqual([]);

    const tsExempt = creationSites(
      'a.test.ts',
      `// git-template-exempt: this fixture asserts the machine hooks fire on a new repo\nexecFileSync('git', ['init']);`,
    );
    expect(tsExempt.sites[0]!.exempt).not.toBeNull();

    // A marker separated from the site by code does not attach.
    const detached = creationSites(
      'a.sh',
      `# git-template-exempt: a reason that is long enough to count\necho hi\ngit init -q .`,
    );
    expect(detached.sites[0]!.exempt).toBeNull();
    expect(detached.staleMarkers).toEqual([1]);

    const thin = creationSites('a.sh', `git init -q .  # git-template-exempt: why`);
    expect(thin.thinMarkers).toEqual([1]);
  });

  it('fails CLOSED on a TS/JS source it cannot parse (M2)', () => {
    expect(() => creationSites('a.test.ts', `execFileSync('git', ['init'] {`)).toThrow(/cannot look/);
  });
});
