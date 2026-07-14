// A-00 — THERE IS EXACTLY ONE MEMORY-DIRECTORY RESOLVER.
//
// THE BUG (live, and it had already escaped once before):
// `hooks/session-start.ts` hand-rolled its own copy of the path encoder:
//     cwd.replace(/[/\\]/g, '-').replace(/^-/, '')
// Two bugs in one line. (1) It STRIPPED THE LEADING DASH — but an absolute path
// starts with '/', so the encoded name always begins with exactly one '-'
// (`lib/memory-path.ts:18-21` says so explicitly). (2) It keyed off `process.cwd()`
// instead of the project root.
//
// Result: session-start resolved `~/.claude/projects/Users-…/memory` — A DIRECTORY
// THAT DOES NOT EXIST — while the real corpus sat in `-Users-…/memory`.
//
// THE DAMAGE: `reconcileMemoryFileObservations` is called with that path at every
// session start. A nonexistent dir yields an empty live-file set, which (before
// A-01) took the unbounded branch: DELETE FROM observations WHERE title LIKE
// '[memory-file] %'. Meanwhile `massu init` and the backfill tool populate those
// same rows using the CORRECT resolver. A death loop: backfill inserts 69 rows ->
// the next session start deletes all 69. Forever. The live store showed exactly
// that — 0 [memory-file] rows against 69 files on disk.
//
// `lib/memory-path.ts` EXISTS TO BE THE SINGLE SOURCE OF TRUTH, and its own header
// records that it was written to close this SAME class once before (a writer that
// mangled the dash and "orphaned MEMORY.md in a directory the reader could never
// find"). A doc comment did not stop the second escape. This test does.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, basename } from 'path';

import { encodeMemoryDirName } from '../lib/memory-path.ts';

const SRC = join(__dirname, '..');

/** Scan CODE, not prose — the comments in session-start.ts document the old bug
 *  verbatim, and a guard that trips on its own incident write-up is useless. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Modules permitted to construct a memory path from parts. */
const RESOLVER_ALLOWLIST = new Set(['memory-path.ts', 'config.ts']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
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

describe('memory-dir single resolver (A-00 drift-guard)', () => {
  const files = walk(SRC);

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('NOBODY hand-rolls the encoder: the slash-replace + dash-strip chain is banned', () => {
    // The exact defect, as it was actually written:
    //     cwd.replace(/[/\\]/g, '-').replace(/^-/, '')
    // Narrowly targeted on purpose. A bare `.replace(/^-/, '')` is legitimate
    // elsewhere (camelCase->kebab in docs-tools.ts:296, sentinel-scanner.ts:60) —
    // it is the CHAIN, applied to an encoded path, that deletes the leading dash
    // and resolves the memory dir to a directory that does not exist.
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf-8'));
      if (/replace\([^)]*\[\/\\\\?\][^)]*\)\s*\n?\s*\.replace\(\s*\/\^-\//.test(code)) {
        offenders.push(relative(SRC, f));
      }
    }
    expect(
      offenders,
      'A path-encode followed by a leading-dash strip. An absolute root encodes to ' +
        'exactly ONE leading dash; removing it points at a nonexistent directory. ' +
        'Use getResolvedPaths().memoryDir. Offenders',
    ).toEqual([]);
  });

  it("every module that builds the memory path goes through the canonical encoder", () => {
    // The real invariant. init.ts and rule-candidate-applier.ts DO legitimately
    // construct the path — but they must do it with encodeMemoryDirName(), never by
    // hand. A module that joins 'projects' + 'memory' without the encoder is, by
    // definition, a second resolver, and a second resolver is how this drifted.
    const offenders: string[] = [];
    for (const f of files) {
      if (RESOLVER_ALLOWLIST.has(basename(f))) continue;
      const code = stripComments(readFileSync(f, 'utf-8'));
      const buildsPath = /['"]projects['"]\s*,[\s\S]{0,120}?['"]memory['"]/.test(code);
      if (!buildsPath) continue;
      const usesCanonical =
        /encodeMemoryDirName\s*\(/.test(code) || /getResolvedPaths\(\)\.memoryDir/.test(code);
      if (!usesCanonical) offenders.push(relative(SRC, f));
    }
    expect(
      offenders,
      'Memory-dir construction that bypasses the canonical encoder. Import ' +
        'getResolvedPaths() (config.ts) or encodeMemoryDirName() (lib/memory-path.ts). Offenders',
    ).toEqual([]);
  });

  it('the session-start hook resolves through the canonical path helper', () => {
    const code = stripComments(readFileSync(join(SRC, 'hooks', 'session-start.ts'), 'utf-8'));
    expect(
      /getResolvedPaths\(\)\.memoryDir/.test(code),
      'session-start must resolve the memory dir via getResolvedPaths().memoryDir',
    ).toBe(true);
    expect(
      /cwd\.replace\(/.test(code),
      'session-start must not derive the memory dir from process.cwd()',
    ).toBe(false);
  });

  it('the encoder produces exactly ONE leading dash', () => {
    // Encode is the half that matters: it is what every resolver uses.
    // (decode() is deliberately lossy for roots containing '-' — a documented
    // trade-off with ZERO production callers; see memory-path-roundtrip.test.ts:41.)
    for (const root of ['/Users/someone/my-project', '/Users/dev/some-repo', '/tmp/x']) {
      const encoded = encodeMemoryDirName(root);
      expect(encoded.startsWith('-'), `${root}: an absolute root encodes to a leading dash`).toBe(true);
      expect(encoded.startsWith('--'), `${root}: never two`).toBe(false);
    }
    expect(encodeMemoryDirName('/Users/dev/some-repo')).toBe('-Users-dev-some-repo');
  });
});
