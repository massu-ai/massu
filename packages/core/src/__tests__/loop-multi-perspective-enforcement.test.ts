// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-C-001 drift-guard (plan-loop-multi-perspective-enforcement / CR-52).
 *
 * Scans `.claude/metrics/command-scores.jsonl` and asserts that every entry
 * for a looping command (`massu-loop`, `massu-golden-path`,
 * `massu-loop-playwright`) since the CR-52 ship cutoff has
 * `scores.multi_perspective_review_spawned: true`.
 *
 * Closes the structural bug class where the score was silent self-attestation
 * not enforcement. Discovered 2026-05-19T00:09:00Z when `plan-2026-05-18-
 * security-medium-sweep` loop scored 3/4 (`multi_perspective_review_spawned:
 * false`) and shipped to production anyway.
 *
 * Companion: bash mirror is `scripts/massu-pattern-scanner.sh` Check 28.
 * Mirror-parity assertion enforces the `LEGACY_PRE_FIX_ENTRIES` allowlist
 * stays in sync between vitest and scanner (CR-50-style guard).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCORES_FILE = resolve(REPO_ROOT, '.claude/metrics/command-scores.jsonl');
const PATTERN_SCANNER = resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh');

/**
 * Commands subject to the multi-perspective-review-spawned gate. New
 * loop-family commands MUST be added here.
 */
const LOOPING_COMMANDS = new Set<string>([
  'massu-loop',
  'massu-golden-path',
  'massu-loop-playwright',
]);

/**
 * Cutoff timestamp — entries STRICTLY AFTER this point are subject to the
 * drift-guard. Entries on or before this timestamp are pre-CR-52 and exempt.
 *
 * Set to one second AFTER the 2026-05-19T00:09:00Z incident-surfacing line
 * so that single legacy entry is automatically pre-cutoff and not subject
 * to the assertion. Future commits cannot back-date entries because the
 * scorer always writes UTC `new Date().toISOString()`.
 */
const LEGACY_CUTOFF_ISO = '2026-05-19T00:09:01Z';

/**
 * LEGACY_PRE_FIX_ENTRIES — explicit allowlist of pre-CR-52 entries that
 * scored false. Must mirror the bash array in
 * `scripts/massu-pattern-scanner.sh` Check 28 (CR-50-style parity).
 *
 * Currently a single entry pins the incident-surfacing line by exact
 * (timestamp, input_summary, pass_rate) tuple. Adding future entries
 * requires both arrays updated AND a documented incident reference.
 */
export const LEGACY_PRE_FIX_ENTRIES: ReadonlyArray<{
  timestamp: string;
  input_summary: string;
  pass_rate: string;
}> = [
  {
    timestamp: '2026-05-19T00:09:00Z',
    input_summary: 'plan-2026-05-18-security-medium-sweep',
    pass_rate: '3/4',
  },
];

interface ScoreEntry {
  command?: string;
  timestamp?: string;
  scores?: Record<string, boolean>;
  pass_rate?: string;
  input_summary?: string;
  // Additional optional fields (heterogeneous schema across versions):
  iterations?: number;
  gap_trend?: number[];
  convergence?: string;
  plan_items?: number;
  [key: string]: unknown;
}

function readScoreEntries(): ScoreEntry[] {
  // Gracefully handle missing scores file (e.g., sandbox copies via
  // sync-public.sh that don't include `.claude/metrics/` — the leak-guard
  // sandbox legitimately excludes this private metrics file).
  if (!existsSync(SCORES_FILE)) {
    return [];
  }
  const content = readFileSync(SCORES_FILE, 'utf-8');
  const entries: ScoreEntry[] = [];
  let lineNo = 0;
  for (const line of content.split('\n')) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ScoreEntry);
    } catch {
      // Matches existing test convention — log + skip malformed lines.
      // eslint-disable-next-line no-console
      console.warn(`loop-multi-perspective-enforcement.test.ts: skipping malformed JSON at line ${lineNo}: ${trimmed.slice(0, 80)}`);
    }
  }
  return entries;
}

function isAfterCutoff(entryTs: string | undefined): boolean {
  if (!entryTs) return false;
  return entryTs > LEGACY_CUTOFF_ISO;
}

function isLegacyAllowlisted(entry: ScoreEntry): boolean {
  if (!entry.timestamp || !entry.input_summary || !entry.pass_rate) return false;
  return LEGACY_PRE_FIX_ENTRIES.some(
    (a) =>
      a.timestamp === entry.timestamp &&
      a.input_summary === entry.input_summary &&
      a.pass_rate === entry.pass_rate,
  );
}

describe('LMP loop-multi-perspective-enforcement drift-guard (CR-52)', () => {
  it('LMP-01: every looping-command entry past LEGACY_CUTOFF_ISO has multi_perspective_review_spawned: true', () => {
    const entries = readScoreEntries();
    const violations: Array<{ index: number; entry: ScoreEntry }> = [];
    entries.forEach((entry, idx) => {
      if (!entry.command || !LOOPING_COMMANDS.has(entry.command)) return;
      if (!isAfterCutoff(entry.timestamp)) return;
      if (isLegacyAllowlisted(entry)) return;
      // Required fields check + assertion.
      const ts = entry.timestamp;
      const scores = entry.scores;
      if (!ts || !scores) {
        violations.push({ index: idx, entry });
        return;
      }
      if (scores.multi_perspective_review_spawned !== true) {
        violations.push({ index: idx, entry });
      }
    });
    expect(
      violations,
      `LMP-01 FAIL: ${violations.length} looping-command entries past ${LEGACY_CUTOFF_ISO} have multi_perspective_review_spawned !== true. ` +
        `Sample: ${violations.slice(0, 3).map((v) => `[line ${v.index + 1}] ${JSON.stringify(v.entry)}`).join('; ')}`,
    ).toEqual([]);
  });

  it('LMP-02: synthetic false-score entry triggers test failure logic', () => {
    // Mirror the same filtering logic against a synthetic fixture to prove
    // the assertion is wired correctly (without mutating the real metrics file).
    const tmpdirPath = mkdtempSync(join(tmpdir(), 'lmp-synth-'));
    const fixture = join(tmpdirPath, 'fixture.jsonl');
    try {
      const lines = [
        // Clean post-cutoff loop entry — should NOT trigger.
        JSON.stringify({
          command: 'massu-loop',
          timestamp: '2026-05-20T00:00:00Z',
          scores: { multi_perspective_review_spawned: true },
          pass_rate: '4/4',
          input_summary: 'plan-x',
        }),
        // Failing post-cutoff loop entry — should trigger violation.
        JSON.stringify({
          command: 'massu-loop',
          timestamp: '2026-05-20T01:00:00Z',
          scores: { multi_perspective_review_spawned: false },
          pass_rate: '3/4',
          input_summary: 'plan-y',
        }),
      ];
      writeFileSync(fixture, lines.join('\n') + '\n');

      // Re-implement the filter on the fixture so we don't mutate the real file.
      const content = readFileSync(fixture, 'utf-8');
      const entries: ScoreEntry[] = content
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ScoreEntry);
      const violations = entries.filter(
        (e) =>
          e.command &&
          LOOPING_COMMANDS.has(e.command) &&
          isAfterCutoff(e.timestamp) &&
          !isLegacyAllowlisted(e) &&
          e.scores?.multi_perspective_review_spawned !== true,
      );
      expect(violations.length, 'synthetic fixture should produce exactly 1 violation').toBe(1);
      expect(violations[0]?.input_summary).toBe('plan-y');
    } finally {
      rmSync(tmpdirPath, { recursive: true, force: true });
    }
  });

  it('LMP-03: LOOPING_COMMANDS includes the three known loop-family commands', () => {
    expect(LOOPING_COMMANDS.has('massu-loop')).toBe(true);
    expect(LOOPING_COMMANDS.has('massu-golden-path')).toBe(true);
    expect(LOOPING_COMMANDS.has('massu-loop-playwright')).toBe(true);
  });

  it('LMP-04: LEGACY_PRE_FIX_ENTRIES mirror parity with pattern-scanner Check 28 bash array', () => {
    // Mirror-style assertion: every entry exported here MUST appear as a
    // (timestamp,input_summary,pass_rate) tuple in the pattern-scanner bash
    // mirror. Reads the scanner script and extracts the bash array via regex.
    //
    // Architecture-review F-ARCH-003 fix: use a literal field-separator that
    // CANNOT appear in any field. ASCII unit-separator (`\x1f`, U+001F) is the
    // POSIX-canonical non-printable delimiter for this use case and is
    // structurally impossible in plan tokens / ISO timestamps / pass-rate
    // strings. The bash mirror MUST use the same separator.
    const SEP = '\x1f';
    const scanner = readFileSync(PATTERN_SCANNER, 'utf-8');
    // The bash mirror declares entries in the form:
    //   LEGACY_PRE_FIX_ENTRY_<N>=$'<ts>\x1f<input>\x1f<rate>'
    // We extract them via $'...' literal and split on \x1f.
    const bashEntries: Array<{ timestamp: string; input_summary: string; pass_rate: string }> = [];
    const re = /LEGACY_PRE_FIX_ENTRY_\d+=\$'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scanner)) !== null) {
      // bash $'...' renders \x1f literally in the consumer; in the source file
      // it's spelled as the 4-char sequence "\\x1f". We replace the literal
      // backslash-x1f-sequence with the actual byte for the split.
      const raw = m[1].replace(/\\x1f/g, SEP);
      const parts = raw.split(SEP);
      if (parts.length === 3) {
        bashEntries.push({ timestamp: parts[0], input_summary: parts[1], pass_rate: parts[2] });
      }
    }
    const tupleKey = (e: { timestamp: string; input_summary: string; pass_rate: string }) =>
      `${e.timestamp}${SEP}${e.input_summary}${SEP}${e.pass_rate}`;
    const tsSet = new Set(LEGACY_PRE_FIX_ENTRIES.map(tupleKey));
    const bashSet = new Set(bashEntries.map(tupleKey));

    // Symmetric diff.
    const inTsOnly = [...tsSet].filter((x) => !bashSet.has(x));
    const inBashOnly = [...bashSet].filter((x) => !tsSet.has(x));

    expect(
      inTsOnly.concat(inBashOnly),
      `LEGACY_PRE_FIX_ENTRIES mirror drift. In TS only: ${inTsOnly.join(',')}. In bash only: ${inBashOnly.join(',')}. ` +
        `Update both packages/core/src/__tests__/loop-multi-perspective-enforcement.test.ts:LEGACY_PRE_FIX_ENTRIES ` +
        `AND scripts/massu-pattern-scanner.sh:LEGACY_PRE_FIX_ENTRY_*`,
    ).toEqual([]);
  });
});
