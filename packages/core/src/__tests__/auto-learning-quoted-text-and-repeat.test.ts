// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Two false-positive defects in the auto-learning Stop hook, reported 2026-11-08 from another
 * repository where the same "ACTION REQUIRED" block followed every reply for hours.
 *
 *   DEFECT 1 — keywords inside QUOTED TEXT scored as fix signals. The only file that tripped
 *     the hook was a slide-deck builder: 4 hits against a threshold of > 3, two of them slide
 *     copy inside Python string literals.
 *   DEFECT 2 — no ACKNOWLEDGEMENT. The scan re-reads the working tree on every Stop and
 *     nothing recorded that a warning had already been shown for those bytes.
 *
 * This is occurrence #4 of "the detector judged input it had no business judging" in this
 * one artifact (the header of `auto-learning-session-scoped-diff.test.ts` lists #1–#3), so it
 * ships its mechanism: each defect has a test here that is RED against the pre-fix code, and
 * a BOUNDARY test that must stay GREEN either way, so the fix cannot be "go blind".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanUncommittedForFix,
  scoreDiff,
  freshMatches,
  matchKey,
  readShownKeys,
  writeShownKeys,
} from '../hooks/auto-learning-pipeline.ts';
import { FIX_HEURISTICS } from '../hooks/fix-detector.ts';
import { projectCode, lexSpecFor, diffCodeView, LEX_SPECS } from '../hooks/lib/code-spans.ts';
import { gitSafeEnv, gitSafeEnvForNewRepo } from './helpers/git-safe-env.ts';

// ── The lexer ───────────────────────────────────────────────────────────────────────────

function code(path: string, ...lines: string[]): string[] {
  const spec = lexSpecFor(path);
  if (!spec) throw new Error(`no lexer for ${path}`);
  return projectCode(lines, spec);
}

/** The keyword regex the hooks use, applied to one projected line. */
const KW = /\b(?:try|except|catch|guard|throw|raise|assert|validate)\b/;

describe('code-spans lexer', () => {
  it('preserves every line length, so word boundaries survive projection', () => {
    const lines = ['x = "a # b"  # c', "y = 'it''s'", 'z = """doc', 'more""" + w'];
    const out = code('a.py', ...lines);
    expect(out.map((l) => l.length)).toEqual(lines.map((l) => l.length));
  });

  it('python: single, double and triple-quoted strings and # comments are not code', () => {
    const out = code(
      'a.py',
      'title = "The catch"',
      "note = 'we raise the bar'",
      'doc = """first line',
      'try harder, said the slide',
      'end"""',
      'x = 1  # raise here is a comment',
      'raise SystemExit("bad")',
    );
    expect(out.slice(0, 6).filter((l) => KW.test(l))).toEqual([]);
    expect(KW.test(out[6])).toBe(true); // the real raise is still code
    expect(out[6]).not.toContain('bad');
  });

  it('python: an escaped quote does not end the string', () => {
    const [l] = code('a.py', 'x = "say \\"catch\\" twice" ; assert x');
    expect(l).not.toMatch(/\bcatch\b/);
    expect(l).toMatch(/\bassert\b/);
  });

  it('js: template literals are strings, but their ${…} holes are code', () => {
    const out = code(
      'a.ts',
      'const a = `we try ${ (() => { try { return 1 } catch { return 2 } })() } and catch`;',
      'const b = `multi',
      'line throw text`;',
      'throw new Error(b);',
    );
    expect(out[0].match(/\b(?:try|catch)\b/g)).toEqual(['try', 'catch']); // the two in the hole
    expect(KW.test(out[1]) || KW.test(out[2])).toBe(false);
    expect(KW.test(out[3])).toBe(true);
  });

  it('js: block and line comments are not code, across lines', () => {
    const out = code('a.ts', '/* try', ' * catch', ' */ const x = 1; // throw', 'assert(x);');
    expect(out.slice(0, 3).some((l) => KW.test(l))).toBe(false);
    expect(KW.test(out[3])).toBe(true);
  });

  it('js: a regex literal containing a quote does not open a string', () => {
    const [l] = code('a.ts', "if (/['\"]x/.test(s)) throw new Error('no');");
    expect(l).toMatch(/\bthrow\b/);
    // and division is still division: `a / b / c` stays code
    const [d] = code('a.ts', 'const r = a / b; try { f(); } catch {}');
    expect(d.match(/\b(?:try|catch)\b/g)).toEqual(['try', 'catch']);
  });

  it('shell: # inside ${#x} and $# is code; a word-start # is a comment', () => {
    const [a, b] = code('a.sh', 'n=${#arr[@]} ; echo "$#" # trap catch', "echo 'it will throw'");
    expect(a).toContain('${#arr[@]}');
    expect(a).not.toMatch(/\bcatch\b/);
    expect(b).not.toMatch(/\bthrow\b/);
  });

  it("rust: a lifetime is code, a char literal is not", () => {
    const [l] = code('a.rs', "fn f<'a>(x: &'a str) -> char { assert!(true); 'c' }");
    expect(l).toContain("<'a>");
    expect(l).toMatch(/\bassert\b/);
    expect(l).not.toContain("'c'");
  });

  it('every LEX_SPECS extension resolves, and an unknown one is null (never guessed)', () => {
    for (const ext of Object.keys(LEX_SPECS)) expect(lexSpecFor(`f${ext}`)).not.toBeNull();
    expect(lexSpecFor('notes.txt')).toBeNull();
    expect(lexSpecFor('Makefile')).toBeNull();
  });
});

// ── Diff parsing ─────────────────────────────────────────────────────────────────────────

describe('diffCodeView', () => {
  it('reads the path from the +++ header and line numbers from the hunk header', () => {
    const d = [
      'diff --git a/src/x.py b/src/x.py',
      'index 1..2 100644',
      '--- a/src/x.py',
      '+++ b/src/x.py',
      '@@ -10,2 +10,3 @@ def f():',
      ' a = 1',
      '+b = "catch"',
      '-c = 3',
      ' d = 4',
    ].join('\n');
    const [v] = diffCodeView(d);
    expect(v.path).toBe('src/x.py');
    expect(v.mode).toBe('hunk');
    expect(v.added).toEqual([{ lineNo: 11, raw: 'b = "catch"', code: 'b =        ' }]);
    expect(v.removed).toEqual(['c = 3']);
  });

  it('a file header is not a removed line: `--- a/src/error.ts` used to score as "error"', () => {
    const d = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-x\n+y\n`;
    const r = scoreDiff(d('src/error.ts') + d('src/fail.ts'));
    expect(r.removedBroken).toBe(0);
  });

  it('an unknown language is reported as raw and judged exactly as before', () => {
    const d = 'diff --git a/Makefile b/Makefile\n--- a/Makefile\n+++ b/Makefile\n@@ -0,0 +1 @@\n+\techo "try"\n';
    const [v] = diffCodeView(d);
    expect(v.mode).toBe('raw');
    expect(v.added[0].code).toBe(v.added[0].raw);
  });

  it('with a post-image, a hunk that begins INSIDE a docstring is classified exactly', () => {
    // Without the post-image, the hunk is lexed from a code-state start and its closing `"""`
    // reads as an OPENING one — which would hide the real `raise` after it.
    const post = ['"""Long docstring', 'line 2', 'line 3', 'line 4', 'line 5', 'try this, said the slide', '"""', 'raise ValueError("x")', ''].join('\n');
    const d = [
      'diff --git a/a.py b/a.py', '--- a/a.py', '+++ b/a.py', '@@ -3,4 +3,6 @@',
      ' line 3', ' line 4', ' line 5', '+try this, said the slide', ' """', '+raise ValueError("x")',
    ].join('\n');
    const [exact] = diffCodeView(d, { postImage: () => post });
    expect(exact.mode).toBe('post-image');
    expect(KW.test(exact.added[0].code)).toBe(false);
    expect(KW.test(exact.added[1].code)).toBe(true);

    // A post-image that does not match the diff is not trusted.
    const [stale] = diffCodeView(d, { postImage: () => 'unrelated\n' });
    expect(stale.mode).toBe('hunk');
  });
});

// ── Fixtures A and B against a real repository ──────────────────────────────────────────

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...gitSafeEnvForNewRepo(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function write(rel: string, content: string, root = repo): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** Four added lines whose ONLY keyword is inside a string literal. */
const QUOTED_ONLY_PY = [
  'SLIDES = []',
  'SLIDES.append("The catch")',
  'SLIDES.append("Every app had to try its own copy")',
  "SLIDES.append('Then we raise the stakes')",
  'SLIDES.append("""Nobody would throw it away""")',
  '',
].join('\n');

/** The measured 2026-11-08 shape: two quoted hits and two real `raise` lines. */
const MEASURED_SHAPE_PY = [
  'def build():',
  '    title = "The catch"',
  '    body = "Every app kept its own copy, so we try once"',
  '    if not title:',
  '        raise SystemExit("missing title")',
  '    if not body:',
  '        raise SystemExit("missing body")',
  '',
].join('\n');

/** Four added lines of real exception handling. */
const REAL_HANDLING_PY = [
  'def load(p):',
  '    try:',
  '        return open(p).read()',
  '    except OSError as e:',
  '        raise RuntimeError(p) from e',
  '    assert p',
  '',
].join('\n');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'massu-al-quoted-'));
  git(['init', '-q', '--initial-branch=main']);
  write('build_story.py', '');
  write('src/load.py', '');
  git(['add', '-A']);
  git(['commit', '-qm', 'seed']);
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

describe('DEFECT 1: a keyword inside quoted text is not a fix signal', () => {
  it('FIXTURE A: four added lines whose only keyword is quoted -> no-signal', () => {
    write('build_story.py', QUOTED_ONLY_PY);
    const r = scanUncommittedForFix({ root: repo, sessionTouched: new Set(['build_story.py']) });
    expect(r.filesScanned).toBe(1); // M1: it looked
    expect(r.lexModes['build_story.py']).toBe('post-image');
    expect(r.fixPatterns).toBe(0);
    expect(r.reason).toBe('no-signal');
  });

  it('the measured shape (2 quoted + 2 real raise) no longer crosses the > 3 threshold', () => {
    write('build_story.py', MEASURED_SHAPE_PY);
    const r = scanUncommittedForFix({ root: repo, sessionTouched: new Set(['build_story.py']) });
    expect(r.fixPatterns).toBe(2); // the real raises still count
    expect(r.uncommittedFix).toBe(false);
  });

  it('FIXTURE B (boundary): four real exception-handling lines still fire', () => {
    write('src/load.py', REAL_HANDLING_PY);
    const r = scanUncommittedForFix({ root: repo, sessionTouched: new Set(['src/load.py']) });
    expect(r.fixPatterns).toBe(4);
    expect(r.reason).toBe('fix-detected');
  });

  it('the per-edit detector shares the lexer: quoted keywords do not make added_error_handling', () => {
    const h = FIX_HEURISTICS.find((x) => x.name === 'added_error_handling')!;
    const diffOf = (body: string) =>
      `diff --git a/s.py b/s.py\n--- a/s.py\n+++ b/s.py\n@@ -0,0 +1,${body.split('\n').length} @@\n` +
      body.split('\n').map((l) => `+${l}`).join('\n');
    expect(h.test(diffOf(QUOTED_ONLY_PY))).toBe(false);
    expect(h.test(diffOf(REAL_HANDLING_PY))).toBe(true);
  });
});

// ── DEFECT 2: acknowledgement ────────────────────────────────────────────────────────────

describe('DEFECT 2: the same matched lines are shown once per session', () => {
  it('identical keys are not fresh; a NEW matched line is; a shrinking set is not', () => {
    const k = [matchKey('a.py', '+', 'try:'), matchKey('a.py', '+', 'raise X')];
    expect(freshMatches(k, new Set())).toHaveLength(2);
    expect(freshMatches(k, new Set(k))).toEqual([]);
    const k5 = [...k, matchKey('a.py', '+', 'assert y')];
    expect(freshMatches(k5, new Set(k))).toEqual([k5[2]]);
    expect(freshMatches(k.slice(0, 1), new Set(k))).toEqual([]);
  });

  it('the key is content, not position: the same line moved down is not new', () => {
    expect(matchKey('a.py', '+', 'raise X')).toBe(matchKey('a.py', '+', 'raise X'));
    expect(matchKey('a.py', '+', 'raise X')).not.toBe(matchKey('b.py', '+', 'raise X'));
    expect(matchKey('a.py', '+', 'raise X')).not.toBe(matchKey('a.py', '-', 'raise X'));
  });

  it('the record round-trips, and an unreadable one is the empty set (fails toward showing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'massu-al-ack-'));
    try {
      const p = join(dir, 'nested', 'shown.json');
      writeShownKeys(p, new Set(['b', 'a']));
      expect([...readShownKeys(p)].sort()).toEqual(['a', 'b']);
      writeFileSync(p, '{not json', 'utf-8');
      expect(readShownKeys(p).size).toBe(0);
      expect(readShownKeys(join(dir, 'absent.json')).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FIXTURE C: the BUILT hook, run end to end on one session', () => {
  const HOOK = new URL('../../dist/hooks/auto-learning-pipeline.js', import.meta.url).pathname;
  const BANNER = 'MASSU AUTO-LEARNING PIPELINE';

  function runHook(project: string, sessionId: string, tmp: string): { out: string; err: string } {
    // execFileSync throws on non-zero; this hook always exits 0, so a throw is a real failure.
    const out = execFileSync('node', [HOOK], {
      cwd: project,
      input: JSON.stringify({ session_id: sessionId, transcript_path: join(project, 'transcript.jsonl'), cwd: project }),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...gitSafeEnv(), PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: tmp },
    });
    return { out, err: '' };
  }

  it('fires once on identical bytes, then again only when a matching line is added', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'massu-al-tmp-'));
    try {
      write('massu.config.yaml', 'project:\n  name: app\npaths:\n  source: src\nautoLearning:\n  enabled: true\n');
      mkdirSync(join(repo, 'docs', 'incidents'), { recursive: true });
      git(['add', '-A']);
      git(['commit', '-qm', 'config']);
      // The session's own transcript names the file, so the scan can attribute it.
      writeFileSync(
        join(repo, 'transcript.jsonl'),
        JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(repo, 'src/load.py') } }] } }) + '\n',
        'utf-8',
      );
      write('src/load.py', REAL_HANDLING_PY);
      const sid = `fixturec-${process.pid}`;

      const first = runHook(repo, sid, tmp).out;
      const second = runHook(repo, sid, tmp).out;
      expect(first).toContain(BANNER); // positive control: the hook runs and sees the fix
      expect(second).not.toContain(BANNER);

      write('src/load.py', REAL_HANDLING_PY + 'def g():\n    raise KeyError("k")\n');
      const third = runHook(repo, sid, tmp).out;
      expect(third).toContain(BANNER);

      // A different session has seen nothing: the record is per-session.
      expect(runHook(repo, `other-${process.pid}`, tmp).out).toContain(BANNER);

      // The record survives the warning (cleanup deletes only the flag file).
      expect(existsSync(join(tmp, 'massu-auto-learning', `shown-${sid.slice(0, 12)}.json`))).toBe(true);
      expect(readFileSync(join(tmp, 'massu-auto-learning', `shown-${sid.slice(0, 12)}.json`), 'utf-8')).toContain('shown');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
