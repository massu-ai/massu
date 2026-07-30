// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Detector: npm `scripts` entries that depend on POSIX shell semantics.
 *
 * WHY THIS CLASS EXISTS. npm does not run a package.json script itself — it hands the
 * string to a shell. On POSIX that is `/bin/sh`; on Windows it is `cmd.exe`, which does
 * NOT treat `'` as a quote character, does not perform `$(…)` or `$VAR` expansion, and
 * cannot carry a newline inside an argument at all. A script relying on any of those is
 * silently RE-PARSED into a different argv on Windows — no error, no warning, wrong
 * command.
 *
 * MEASURED, 2026-07-29 (CI run 30428800020). `packages/core`'s `build:cli` passed
 * `--banner:js='#!/usr/bin/env node\nimport{…}'` — multi-line and single-quoted. cmd.exe
 * split it on whitespace, esbuild read the fragments as extra INPUT FILES, and the build
 * died with `Must use "outdir" when there are multiple input files`. `npm run build` had
 * therefore never worked on Windows. `build:hooks` carried the same banner and failed the
 * same way (reproduced: exit 1, three `Could not resolve` errors on the stray fragments).
 *
 * THE FIX WAS STRUCTURAL, AND THIS GUARD IS WHAT KEEPS IT: both scripts now call
 * `node scripts/build-bundles.mjs`, which consumes the banner and externals as JS values
 * from `scripts/build-config.mjs`. There is no shell string left to mis-quote. This
 * detector makes reintroducing one go RED.
 *
 * EXEMPTION, derived rather than hand-maintained: a script SEGMENT that explicitly invokes
 * `bash` has declared its interpreter, so POSIX constructs inside it are intentional and
 * correct. Measured, that exempts exactly the three `prepublishOnly` segments of the form
 * `bash ../../scripts/npm-publish-guard.sh "$PWD"` — publish-time, maintainer-machine
 * surfaces. The exemption is applied PER SEGMENT, not per script, so
 * `esbuild --banner:js='…' && bash foo.sh` is still caught: only the `bash` segment is
 * excused, never the whole line.
 */

/** One POSIX-only construct found in one script. */
export interface ShellPortabilityHit {
  /** Repo-relative path of the package.json the script lives in. */
  readonly file: string;
  /** The `scripts` key, e.g. `build:cli`. */
  readonly script: string;
  /** Which detection path fired. */
  readonly kind: ShellPortabilityKind;
  /** The offending segment, trimmed for reporting. */
  readonly segment: string;
}

export type ShellPortabilityKind =
  | 'single-quote'
  | 'embedded-newline'
  | 'backtick'
  | 'command-substitution'
  | 'variable-expansion';

/**
 * Detection paths. Each has a fixture in the drift-guard that MUST fire — a rule with five
 * paths and two fixtures is three-fifths decoration (CR-72/G18).
 *
 * Ordered most- to least-specific so a hit is reported under its truest name.
 */
const DETECTORS: ReadonlyArray<{
  kind: ShellPortabilityKind;
  test: (segment: string) => boolean;
}> = Object.freeze([
  // cmd.exe does not strip `'`. The quoted run is split on whitespace instead.
  { kind: 'single-quote', test: (s) => s.includes("'") },
  // cmd.exe cannot carry a newline inside an argument under any quoting.
  { kind: 'embedded-newline', test: (s) => s.includes('\n') },
  // Backtick substitution does not exist in cmd.exe.
  { kind: 'backtick', test: (s) => s.includes('`') },
  // `$(…)` does not exist in cmd.exe.
  { kind: 'command-substitution', test: (s) => s.includes('$(') },
  // cmd.exe spells variables `%VAR%`; `$VAR` is passed through as a literal.
  { kind: 'variable-expansion', test: (s) => /\$[A-Za-z_{]/.test(s) },
]);

/**
 * Split a script into shell segments on `&&`, `||` and `;`.
 *
 * Deliberately naive — it does not honour quoting, so a `&&` inside a string splits too.
 * That is the SAFE direction: over-splitting can only make the `bash` exemption NARROWER
 * (fewer characters excused), never wider. A splitter that tried to be clever about quotes
 * would be a second parser to get wrong.
 */
export function shellSegments(script: string): string[] {
  return script
    .split(/&&|\|\||;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does this segment name `bash` as its interpreter? */
export function declaresBashInterpreter(segment: string): boolean {
  return /(^|\s|\/)bash(\s|$)/.test(segment);
}

/**
 * Find every POSIX-only construct in one script.
 *
 * Pure — the drift-guard drives it with fixtures for each detection path AND with the
 * real tracked population.
 */
export function findShellPortabilityHits(
  file: string,
  script: string,
  body: string,
): ShellPortabilityHit[] {
  const hits: ShellPortabilityHit[] = [];
  for (const segment of shellSegments(body)) {
    if (declaresBashInterpreter(segment)) continue;
    for (const { kind, test } of DETECTORS) {
      if (test(segment)) {
        hits.push({ file, script, kind, segment: segment.slice(0, 160) });
        break; // report each segment once, under its most specific kind
      }
    }
  }
  return hits;
}

/** The detection paths this module implements — the guard asserts a fixture per entry. */
export const DETECTION_KINDS: readonly ShellPortabilityKind[] = Object.freeze(
  DETECTORS.map((d) => d.kind),
);
