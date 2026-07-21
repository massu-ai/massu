// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Drift-guard (incident 2026-07-16 check26-sed-grep-q-broken-pipe-false-fail):
 * bans the broken-pipe-false-verdict class in gate scripts.
 *
 * THE BUG CLASS: `<streaming-command> | grep -q PATTERN` under `set -o pipefail`.
 * `grep -q` short-circuits (exits 0) on the FIRST match. When the match is early in a
 * long producer stream, the producer still has output to write, gets SIGPIPE, and exits
 * non-zero — and `set -o pipefail` then makes the WHOLE pipeline non-zero. So a gate that
 * means "the pattern IS present" reads the pipeline as failure and flips its verdict. It
 * is a timing race (~13% on the CI Linux runner, ~0% on macOS pipe buffering), which is
 * why pattern-scanner Check 26 flagged referenced ci-*.sh as "unreferenced" on CI only —
 * red on `main`, invisibly, for weeks. The fix everywhere is to CAPTURE the producer's
 * output into a variable first and match with a here-string (`grep -q P <<<"$var"`), which
 * has no pipe and therefore no race.
 *
 * THE RULE ENFORCED HERE: no gate script may pipe a STREAMING COMMAND into `grep -q`.
 * `echo`/`printf` of a shell variable are ALLOWED — they are builtins that emit a small,
 * already-computed string in a single write and finish before `grep -q` can close the pipe,
 * so they are not part of the race. Any other producer (git, sed over a file, awk, find,
 * a CLI, a `tail`, a `file`, …) MUST use the here-string capture idiom instead.
 *
 * This is the npm-test / CI-Test / pre-push enforcement. Its real-tree mutation proof is
 * scripts/tests/test-grep-q-pipe-guard-mutation.sh (CR-72: plant the defect in the real
 * tree, demand RED; plant the SAFE form, demand it stays GREEN).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');
const SCRIPTS_LIB_DIR = resolve(SCRIPTS_DIR, 'lib');
// scripts/tests/*.sh are gate scripts too: they are mutation-test HARNESSES that pipe a real
// gate's output into grep, so the broken-pipe-false-verdict class bites them exactly as it bites a
// production gate — it did, in the Wave-1b P7b harness `completeness | grep -q` (2026-07-17). The
// original guard excluded scripts/tests; that exclusion is why it would NOT have caught it. Covered now.
const SCRIPTS_TESTS_DIR = resolve(SCRIPTS_DIR, 'tests');

/** Producers that are SAFE to pipe into `grep -q` (see file header). */
const SAFE_PRODUCERS = new Set(['echo', 'printf']);

/**
 * Strip a shell comment from a line: a `#` at line-start or after whitespace begins a
 * comment (so `${#x}` / `$#` — where `#` follows `{` / `$` — are preserved). Mirrors the
 * scanner's own comment-strip sed idiom (a `#` at line-start or after whitespace, rest of line).
 */
function stripComment(line: string): string {
  return line.replace(/(^|\s)#.*/, '$1');
}

/**
 * Split a shell line into pipe segments, respecting single/double quotes (so a `|` inside
 * `grep -E 'a|b'` does not split) and treating `||` (logical OR) as NOT a pipe.
 */
function pipeSegments(line: string): string[] {
  // Mask quoted spans so their `|` chars cannot be seen as pipe operators.
  const masked = line
    .replace(/'[^']*'/g, (s) => ' '.repeat(s.length))
    .replace(/"[^"]*"/g, (s) => ' '.repeat(s.length));
  const cuts: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '|') continue;
    if (masked[i - 1] === '|' || masked[i + 1] === '|') continue; // part of `||`
    cuts.push(i);
  }
  const segs: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    segs.push(line.slice(prev, c));
    prev = c + 1;
  }
  segs.push(line.slice(prev));
  return segs;
}

/** True if a pipe segment is a `grep … -q…` / `grep … --quiet` consumer. */
function isGrepQConsumer(seg: string): boolean {
  const s = seg.trim();
  if (!/^grep\b/.test(s)) return false;
  // any flag cluster containing q (e.g. -q, -qE, -qF, -qxF, -qv) OR --quiet
  return /(^|\s)-[A-Za-z]*q[A-Za-z]*(\s|$)/.test(s) || /(^|\s)--quiet(\s|$)/.test(s);
}

/**
 * First executable token of a producer segment — i.e. the command whose stdout feeds the
 * pipe. Strips leading shell control words / operators (`if`, `!`, `(`, `&&`, `;`, `then`, …)
 * so `if ! echo "$x"` resolves to `echo`.
 */
function producerCommand(seg: string): string {
  let s = seg.trim();
  // Peel leading control keywords / operators, repeatedly.
  for (;;) {
    const next = s.replace(
      /^(?:if|elif|while|until|then|do|else|!|\(|\{|&&|\|\||;|&)\s+/,
      '',
    );
    if (next === s) break;
    s = next.trim();
  }
  const tok = s.split(/\s+/)[0] ?? '';
  return tok;
}

/** All gate scripts in scope: top-level scripts/*.sh + scripts/lib/*.sh (NOT scripts/tests, NOT scripts/hooks). */
function discoverGateScripts(): string[] {
  const files: string[] = [];
  for (const dir of [SCRIPTS_DIR, SCRIPTS_LIB_DIR, SCRIPTS_TESTS_DIR]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      // FAIL CLOSED (blind-gate M2): an unreadable scripts dir must be a LOUD error, never "no gate scripts → all clean".
      throw new Error(`gate-script grep-q guard: cannot read ${dir}: ${(e as Error).message}`);
    }
    for (const f of entries) {
      if (f.endsWith('.sh')) files.push(resolve(dir, f));
    }
  }
  return files.sort();
}

interface Violation {
  file: string;
  line: number;
  producer: string;
  text: string;
}

function scanForDangerousGrepQPipes(): { violations: Violation[]; filesScanned: number; linesScanned: number } {
  const scripts = discoverGateScripts();
  // M1 — PROVE IT LOOKED. Zero gate scripts means discovery broke; refuse to report "clean".
  if (scripts.length === 0) {
    throw new Error('gate-script grep-q guard: discovered ZERO gate scripts — refusing to report an empty (passing) denominator.');
  }
  const violations: Violation[] = [];
  let linesScanned = 0;
  for (const file of scripts) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch (e) {
      throw new Error(`gate-script grep-q guard: cannot read ${file}: ${(e as Error).message}`); // FAIL CLOSED
    }
    const rel = file.includes('/lib/') ? `scripts/lib/${basename(file)}`
      : file.includes('/tests/') ? `scripts/tests/${basename(file)}`
      : `scripts/${basename(file)}`;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      linesScanned++;
      const bare = stripComment(lines[i]);
      if (!/\|\s*grep\b/.test(bare)) continue;
      const segs = pipeSegments(bare);
      for (let s = 1; s < segs.length; s++) {
        if (!isGrepQConsumer(segs[s])) continue;
        const producer = producerCommand(segs[s - 1]);
        if (SAFE_PRODUCERS.has(producer)) continue; // echo/printf are safe
        violations.push({ file: rel, line: i + 1, producer: producer || '(empty)', text: lines[i].trim() });
      }
    }
  }
  return { violations, filesScanned: scripts.length, linesScanned };
}

describe('gate-script grep-q pipeline drift-guard (broken-pipe-false-verdict class, incident 2026-07-16)', () => {
  it('no gate script pipes a streaming command into `grep -q` (use a here-string capture instead)', () => {
    const { violations, filesScanned, linesScanned } = scanForDangerousGrepQPipes();
    // M1 — report the denominator so "scanned 0" can never masquerade as "clean".
    expect(filesScanned).toBeGreaterThan(0);
    expect(linesScanned).toBeGreaterThan(0);
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  ${v.file}:${v.line}  producer='${v.producer}'  →  ${v.text}`)
        .join('\n');
      throw new Error(
        `Found ${violations.length} dangerous \`<command> | grep -q\` pipe(s) in gate scripts ` +
          `(broken-pipe race under set -o pipefail — incident 2026-07-16). Capture the producer into a ` +
          `variable and match with a here-string: \`out="$(cmd)"; grep -q PATTERN <<<"$out"\`.\n${detail}`,
      );
    }
  });

  it('the detector itself is not vacuous — it flags a planted `git … | grep -q` and passes a safe `echo … | grep -q`', () => {
    // In-memory self-test of the classifier (the REAL-TREE proof is the mutation .sh).
    const danger = pipeSegments(stripComment('  if git show --stat "$s" | grep -qE "^x"; then'));
    const grepIdxD = danger.findIndex((seg) => isGrepQConsumer(seg));
    expect(grepIdxD).toBeGreaterThan(0);
    expect(SAFE_PRODUCERS.has(producerCommand(danger[grepIdxD - 1]))).toBe(false); // git → flagged

    const safe = pipeSegments(stripComment('  if ! echo "$norm" | grep -qxF "$x"; then'));
    const grepIdxS = safe.findIndex((seg) => isGrepQConsumer(seg));
    expect(grepIdxS).toBeGreaterThan(0);
    expect(SAFE_PRODUCERS.has(producerCommand(safe[grepIdxS - 1]))).toBe(true); // echo → allowed

    // An alternation `|` inside quotes must NOT be seen as a pipe.
    expect(pipeSegments(`grep -E 'a|b' file`).length).toBe(1);
  });
});
