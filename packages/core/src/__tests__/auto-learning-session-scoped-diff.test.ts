// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * OCCURRENCE #3 for the auto-learning fix detector, so this ships the mechanism.
 *
 *   #1  the classifier scored ~99% of test files as bug fixes
 *   #2  2026-08-11 — prose read as code: `try` matched inside `retry`/`entry`/`country`,
 *       and documentation was in scope at all
 *   #3  this — the doc exclusion reached 2 of 3 git reads, the diff was never scoped to
 *       the acting session, and the `fixDetection` switch did not reach this hook
 *
 * The three are one shape: **the detector judged input it had no business judging.** Prose
 * it should not have read, another session's edits it could not have made, and it did so
 * with no working off switch.
 *
 * Each test below goes RED against exactly one of the three defects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanUncommittedForFix,
  CODE_ONLY_PATHSPEC,
  DOC_EXCLUDE_PATHSPEC,
  MAX_SESSION_PATHSPEC_FILES,
  type GitRunner,
} from '../hooks/auto-learning-pipeline.ts';
import { sessionTouchedFiles } from '../hooks/lib/session-touched-files.ts';
import { gitSafeEnv, GIT_ENV_LEAKS } from './helpers/git-safe-env.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

/**
 * Markdown carrying >3 word-boundaried keyword hits. Every line is ordinary English; the
 * words `try`, `catch`, `throw`, `assert` appear as words, which is exactly what makes this
 * indistinguishable from code to a regex — and why the file-type exclusion is the load-
 * bearing half of the 2026-08-11 fix.
 */
const PROSE_MD = [
  '# Notes',
  'We try the request once, and we do not retry it.',
  'The catch here is that the entry point moved.',
  'You must throw out the old assumption about the country list.',
  'We assert nothing about ordering.',
  'A guard was added, then removed.',
].join('\n');

/** Real code with the same keyword density. */
const REAL_CODE = [
  'export function parse(raw: string) {',
  '  try {',
  '    const v = JSON.parse(raw);',
  '    if (v === null) throw new Error("null payload");',
  '    return v;',
  '  } catch (err) {',
  '    throw new Error(`bad payload: ${err}`);',
  '  }',
  '}',
].join('\n');

let repo: string;

/** A scratch repository. GIT_DIR et al are scrubbed so this cannot address the real repo. */
function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...gitSafeEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'massu-al-scope-'));
  git(['init', '-q', '--initial-branch=main']);
  // Seed the files as TRACKED and empty, then modify them in each test. `git diff` reports
  // unstaged changes to tracked files, so an untracked fixture would produce an empty diff
  // and every assertion below would pass for the wrong reason.
  for (const f of ['src/app.ts', 'src/parse.ts', 'notes.md']) write(f, '');
  git(['add', '-A']);
  git(['commit', '-qm', 'seed']);
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

// ── DEFECT 1 — the doc exclusion reached 2 of 3 git reads ───────────────────────────────

describe('DEFECT 1: every git read is documentation-scoped, not just the gate', () => {
  it('does NOT fire when the only prose-heavy file is a .md sitting beside a code change', () => {
    // The exact shape the partial fix missed. `nameOnly` is non-empty because of the code
    // file, so the scan proceeds — and the body read used to be unfiltered, pulling the
    // .md back into the very text the regex scores.
    write('src/app.ts', 'export const answer = 42;\n');
    write('notes.md', PROSE_MD);
    const touched = new Set(['src/app.ts', 'notes.md']);

    const r = scanUncommittedForFix({ root: repo, sessionTouched: touched });

    expect(r.uncommittedFix).toBe(false);
    expect(r.reason).toBe('no-signal');
    // The denominator: it looked, and at what.
    expect(r.filesScanned).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: the same session DOES fire when the prose is replaced by real code', () => {
    // Without this, "it did not fire" is equally consistent with a scan that never ran.
    write('src/app.ts', 'export const answer = 42;\n');
    write('src/parse.ts', REAL_CODE);
    const touched = new Set(['src/app.ts', 'src/parse.ts']);

    const r = scanUncommittedForFix({ root: repo, sessionTouched: touched });

    expect(r.uncommittedFix).toBe(true);
    expect(r.reason).toBe('fix-detected');
  });

  it('the session-scoped pathspec carries the SAME exclusions as the whole-tree one', () => {
    // Two positive pathspecs, one exclusion list. A second copy is a copy that drifts.
    for (const exclude of DOC_EXCLUDE_PATHSPEC) {
      expect(CODE_ONLY_PATHSPEC).toContain(exclude);
    }
    expect(CODE_ONLY_PATHSPEC.slice(0, 2)).toEqual(['--', '.']);
  });
});

// ── DEFECT 2 — the diff was never scoped to the acting session ──────────────────────────

describe('DEFECT 2: another session\'s edits raise no demand on this one', () => {
  /** Records what git was asked, so the assertions can be about the QUERY, not just the verdict. */
  function recordingGit(diffBody: string, changed: string[]): { run: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push([...args]);
      if (args.includes('--name-only')) return changed.join('\n') + '\n';
      if (args.includes('--shortstat')) return ' 2 files changed, 40 insertions(+), 2 deletions(-)\n';
      return diffBody;
    };
    return { run, calls };
  }

  const FIXY_DIFF = [
    '+  try {',
    '+  } catch (err) {',
    '+    throw new Error("x");',
    '+  if (v === null) return;',
    '+  assert(v);',
  ].join('\n');

  it('session A is NOT prompted for files only session B touched', () => {
    // The measured failure: a session blocked ~15 consecutive turns by a demand whose
    // trigger was another session's uncommitted work. No legal action could discharge it.
    const { run, calls } = recordingGit(FIXY_DIFF, ['src/b-session-file.ts']);

    const r = scanUncommittedForFix({
      root: repo,
      sessionTouched: new Set<string>(), // session A touched nothing
      git: run,
    });

    expect(r.uncommittedFix).toBe(false);
    expect(r.reason).toBe('not-this-session');
    // And it did not even read the body — there was nothing of A's to read.
    expect(calls.some(c => c.includes('--shortstat'))).toBe(false);
  });

  it('POSITIVE CONTROL: session A IS prompted for a file session A touched', () => {
    const { run } = recordingGit(FIXY_DIFF, ['src/a-session-file.ts']);

    const r = scanUncommittedForFix({
      root: repo,
      sessionTouched: new Set(['src/a-session-file.ts']),
      git: run,
    });

    expect(r.uncommittedFix).toBe(true);
    expect(r.reason).toBe('fix-detected');
    expect(r.filesScanned).toBe(1);
  });

  it('scopes the BODY read to the intersection, not merely the gate', () => {
    // Scoping only the gate would repeat defect 1 in a new place: the verdict would still
    // be computed over text this session did not write.
    const { run, calls } = recordingGit(FIXY_DIFF, ['src/mine.ts', 'src/theirs.ts']);

    scanUncommittedForFix({ root: repo, sessionTouched: new Set(['src/mine.ts']), git: run });

    const bodyCall = calls.find(c => c[0] === 'diff' && !c.includes('--name-only') && !c.includes('--shortstat'));
    expect(bodyCall).toBeDefined();
    expect(bodyCall).toContain('src/mine.ts');
    expect(bodyCall).not.toContain('src/theirs.ts');
  });

  it('UNATTRIBUTABLE is silence, never a demand — the gate must stay satisfiable', () => {
    // If the actor cannot be established the reminder has no legal discharge, and a demand
    // that cannot be met is one people route around. Silence is the specified direction.
    const { run, calls } = recordingGit(FIXY_DIFF, ['src/whoever.ts']);

    const r = scanUncommittedForFix({ root: repo, sessionTouched: null, git: run });

    expect(r.uncommittedFix).toBe(false);
    expect(r.reason).toBe('unattributable');
    expect(calls).toHaveLength(0); // it did not even ask
  });

  it('null and the empty set are DIFFERENT answers', () => {
    // Collapsing "could not attribute" into "attributed nothing" is the blind-gate failure.
    // Both are silent here, but they are distinguishable, which is what lets the caller and
    // a future reader tell a skip from a clean bill.
    const { run } = recordingGit(FIXY_DIFF, ['src/x.ts']);
    expect(scanUncommittedForFix({ root: repo, sessionTouched: null, git: run }).reason)
      .toBe('unattributable');
    expect(scanUncommittedForFix({ root: repo, sessionTouched: new Set(), git: run }).reason)
      .toBe('not-this-session');
  });
});

describe('DEFECT 2: the actor-bearing sources', () => {
  it('reads file paths this session wrote out of its own transcript', () => {
    const t = join(repo, 'transcript.jsonl');
    writeFileSync(t, [
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(repo, 'src/edited.ts') } }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'src/written.ts' } }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/only-read.ts' } }] } }),
      JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/etc/outside-the-repo' } }] } }),
      '{ this line is torn',
    ].join('\n'), 'utf-8');

    const got = sessionTouchedFiles({ root: repo, transcriptPath: t });

    expect(got).not.toBeNull();
    // Reading a file is not touching it, and a path outside the repo is not ours.
    expect([...got!].sort()).toEqual(['src/edited.ts', 'src/written.ts']);
  });

  it('returns null — not an empty set — when nothing is readable', () => {
    expect(sessionTouchedFiles({ root: repo, transcriptPath: join(repo, 'nope.jsonl') })).toBeNull();
    expect(sessionTouchedFiles({ root: repo })).toBeNull();
  });

  it('unions the transcript with the per-edit flag file', () => {
    const t = join(repo, 'transcript.jsonl');
    writeFileSync(t, JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/from-transcript.ts' } }] } }), 'utf-8');
    const flag = join(repo, 'flags.jsonl');
    writeFileSync(flag, JSON.stringify({ file: 'src/from-flag.ts', signals: ['x'], timestamp: 'n' }), 'utf-8');

    const got = sessionTouchedFiles({ root: repo, transcriptPath: t, flagPath: flag });

    expect([...got!].sort()).toEqual(['src/from-flag.ts', 'src/from-transcript.ts']);
  });
});

// ── The git-location scrub, because `cwd` alone does not scope git ──────────────────────

describe('the read is bound to the repo it names', () => {
  it('removes every git-location variable so cwd is authoritative', () => {
    const poisoned = Object.fromEntries(GIT_ENV_LEAKS.map(k => [k, '/somewhere/else/.git']));
    const scoped = gitSafeEnv({}, { ...poisoned, PATH: '/usr/bin' });

    for (const k of GIT_ENV_LEAKS) expect(scoped[k]).toBeUndefined();
    expect(scoped.PATH).toBe('/usr/bin'); // it scrubs, it does not empty
  });

  it('a poisoned GIT_DIR does not redirect the scan', () => {
    write('src/parse.ts', REAL_CODE);
    const other = mkdtempSync(join(tmpdir(), 'massu-al-other-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: other, env: gitSafeEnv() });
      const saved = process.env.GIT_DIR;
      process.env.GIT_DIR = join(other, '.git');
      try {
        const r = scanUncommittedForFix({ root: repo, sessionTouched: new Set(['src/parse.ts']) });
        // Without the scrub this reads `other`, where src/parse.ts does not exist.
        expect(r.uncommittedFix).toBe(true);
      } finally {
        if (saved === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved;
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// -- DEFECT 3 -- the fixDetection switch did not reach this hook ------------------------

describe('DEFECT 3: fixDetection.enabled gates BOTH branches', () => {
  const HOOK = new URL('../../dist/hooks/auto-learning-pipeline.js', import.meta.url).pathname;

  /** Run the BUILT hook end to end. The knob lives in main(); a unit test cannot see it. */
  function runHook(project: string, sessionId: string): { code: number; out: string } {
    try {
      const out = execFileSync('node', [HOOK], {
        cwd: project,
        input: JSON.stringify({
          session_id: sessionId,
          transcript_path: join(project, 'transcript.jsonl'),
          cwd: project,
        }),
        encoding: 'utf-8',
        env: { ...gitSafeEnv(), PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  /** A project whose per-session flag file already holds a fix, so the notice has input. */
  function makeProject(fixDetectionEnabled: boolean | null): { dir: string; sessionId: string } {
    const dir = mkdtempSync(join(tmpdir(), 'massu-al-cfg-'));
    const knob = fixDetectionEnabled === null
      ? ''
      : `  fixDetection:\n    enabled: ${fixDetectionEnabled}\n`;
    writeFileSync(
      join(dir, 'massu.config.yaml'),
      `project:\n  name: app\npaths:\n  source: src\nautoLearning:\n  enabled: true\n${knob}`,
      'utf-8',
    );
    mkdirSync(join(dir, 'docs', 'incidents'), { recursive: true });

    const sessionId = `sess-${Math.abs(Date.now() % 100000)}-${fixDetectionEnabled}`;
    const flagDir = join(tmpdir(), 'massu-auto-learning');
    mkdirSync(flagDir, { recursive: true });
    writeFileSync(
      join(flagDir, `fixes-${sessionId.slice(0, 12)}.jsonl`),
      JSON.stringify({ file: 'src/thing.ts', signals: ['added_error_handling'], timestamp: 'now' }) + '\n',
      'utf-8',
    );
    return { dir, sessionId };
  }

  it('POSITIVE CONTROL: with the knob unset, the notice fires', () => {
    // Without this the silence below is equally consistent with a hook that never runs.
    const { dir, sessionId } = makeProject(null);
    try {
      expect(runHook(dir, sessionId).out).toContain('MASSU AUTO-LEARNING PIPELINE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fixDetection.enabled: false silences it', () => {
    const { dir, sessionId } = makeProject(false);
    try {
      const r = runHook(dir, sessionId);
      expect(r.out).not.toContain('MASSU AUTO-LEARNING PIPELINE');
      expect(r.code).toBe(0); // silent, not broken
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fixDetection.enabled: true keeps it firing', () => {
    const { dir, sessionId } = makeProject(true);
    try {
      expect(runHook(dir, sessionId).out).toContain('MASSU AUTO-LEARNING PIPELINE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── DENOMINATOR — the count the previous fix got wrong ──────────────────────────────────

describe('DENOMINATOR: every git diff invocation carries the pathspec', () => {
  it('counts the invocations in the source and asserts all of them are scoped', () => {
    const src = readFileSync(new URL('../hooks/auto-learning-pipeline.ts', import.meta.url), 'utf-8');
    const invocations = [...src.matchAll(/git\(\[\s*'diff'[^)]*?\]/gs)].map(m => m[0]);

    // M1 — prove it looked. A source that stopped matching would otherwise pass vacuously.
    expect(invocations.length).toBeGreaterThanOrEqual(3);

    const scoped = invocations.filter(i => /CODE_ONLY_PATHSPEC|\.\.\.scoped/.test(i));
    expect(scoped).toHaveLength(invocations.length); // was 2 of 3
  });

  it('the session-scoped pathspec is capped so argv cannot grow without bound', () => {
    expect(MAX_SESSION_PATHSPEC_FILES).toBeGreaterThan(0);
    const many = Array.from({ length: MAX_SESSION_PATHSPEC_FILES + 1 }, (_, i) => `src/f${i}.ts`);
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push([...args]);
      if (args.includes('--name-only')) return many.join('\n');
      if (args.includes('--shortstat')) return ' 1 file changed, 1 insertion(+)\n';
      return '';
    };

    scanUncommittedForFix({ root: repo, sessionTouched: new Set(many), git: run });

    const body = calls.find(c => c[0] === 'diff' && !c.includes('--name-only') && !c.includes('--shortstat'));
    // Over the cap it falls back to pathspec magic rather than naming every file.
    expect(body).not.toContain('src/f0.ts');
    expect(body).toContain('.');
  });
});
