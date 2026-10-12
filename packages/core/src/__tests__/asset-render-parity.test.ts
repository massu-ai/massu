// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * ⛔ WHAT `massu show-template <name>` PRINTS MUST BE WHAT THE INSTALLER WRITES.
 *
 * The installer tells the user so itself. When an asset has been locally edited it prints:
 *
 *     To diff:  diff <target> <(npx massu show-template <base>)
 *
 * MEASURED 2026-09-21, BEFORE THE FIX. `show-template` read the bundled file and printed it
 * RAW, while the installer writes RENDERED bytes. 43 of the 67 shipped commands carry 305
 * `{{…}}` tokens, so for two thirds of the catalogue that diff reported hundreds of
 * differences on a file nobody had touched. Nothing errored — both sides produced a file.
 *
 * The fix was structural: ONE `renderResolvedAsset`, called by both. This test is what keeps
 * it that way, because "somebody re-derives it" is a code review away and the failure is
 * silent by construction.
 *
 * ⛔ THE POPULATION IS DERIVED FROM DISK AND ITS DENOMINATOR IS ASSERTED. A parity test that
 * compared zero assets would pass, and "0 compared, 0 differ" is exactly what a broken
 * derivation returns (M1). It is also run against TWO different stacks: parity that holds only
 * where nothing varies is not parity, it is a tautology.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { syncDirectory, type Manifest } from '../commands/install-commands.ts';
import { resolveAssetDir, isVariantFilename } from '../commands/asset-resolution.ts';
import { makeRenderContext } from '../commands/asset-render.ts';
import { getConfig, resetConfig } from '../config.ts';
import type { Config } from '../config.ts';

const created: string[] = [];

function mkRepo(configYaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'massu-parity-'));
  created.push(root);
  mkdirSync(resolve(root, '.claude', 'commands'), { recursive: true });
  writeFileSync(resolve(root, 'massu.config.yaml'), configYaml);
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const d = created.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function emptyManifest(): Manifest {
  return { version: 1, generatedBy: 'test', generatedAt: '', entries: {} };
}

const PYTHON = [
  'schema_version: 2',
  'project:',
  '  name: "parity-python"',
  '  root: auto',
  'framework:',
  '  type: python',
  '  router: fastapi-router',
  '  orm: none',
  '  ui: none',
  'paths:',
  '  source: app',
  'toolPrefix: massu',
  'domains: []',
  'rules: []',
  'verification:',
  '  python:',
  '    test: python3 -m pytest -q',
  '    type: python3 -m mypy .',
  '    lint: python3 -m ruff check .',
  '    build: python3 -m build',
  '',
].join('\n');

const TYPESCRIPT = [
  'schema_version: 2',
  'project:',
  '  name: "parity-typescript"',
  '  root: auto',
  'framework:',
  '  type: typescript',
  '  router: none',
  '  orm: none',
  '  ui: none',
  'paths:',
  '  source: src',
  'toolPrefix: massu',
  'domains: []',
  'rules: []',
  'verification:',
  '  typescript:',
  '    test: npm test',
  '    type: npx tsc --noEmit',
  '    lint: npx eslint .',
  '    build: npm run build',
  '',
].join('\n');

/** Top-level base names the installer would consider, derived from the shipped tree. */
function shippedBaseNames(sourceDir: string): string[] {
  return readdirSync(sourceDir)
    .filter((e) => e.endsWith('.md'))
    .filter((e) => e !== 'README.md') // corpus front matter, never an asset
    .filter((e) => !isVariantFilename(e))
    .map((e) => e.slice(0, -'.md'.length))
    .sort();
}

interface Parity {
  compared: number;
  installedOnly: string[];
  shownOnly: string[];
  differing: string[];
}

/**
 * Drive the REAL `massu show-template <base>` and capture what it prints.
 *
 * ⛔ IT CALLS THE COMMAND, NOT `renderResolvedAsset`. The first draft of this guard asserted
 * that `renderResolvedAsset` matched the installer — true, and the WRONG PROPERTY. The thing
 * a user runs is `show-template`, so a future re-derivation inside `show-template.ts` would
 * have left this green while reintroducing the exact bug (G28: a gate's scope predicate must
 * BE the property, never a correlate of it).
 */
async function showTemplateOutput(base: string): Promise<string | null> {
  const stdout: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  class Exited extends Error {}
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Exited();
  }) as never);
  try {
    const { runShowTemplate } = await import('../commands/show-template.ts');
    await runShowTemplate([base]);
    return stdout.join('');
  } catch (err) {
    if (err instanceof Exited) return null; // the command refused this name
    throw err;
  } finally {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  }
}

async function measureParity(configYaml: string): Promise<Parity> {
  const root = mkRepo(configYaml);
  const prev = process.cwd();
  resetConfig();
  try {
    process.chdir(root);

    const sourceDir = resolveAssetDir('commands');
    if (!sourceDir) throw new Error('could not resolve the shipped commands dir');
    const fw = getConfig().framework;

    // The INSTALLER's path: render every asset into the fixture's .claude/commands.
    // One context for the whole walk, exactly as `installCommands` builds it.
    const installCtx = makeRenderContext(fw);
    const targetDir = resolve(root, '.claude', 'commands');
    syncDirectory(
      sourceDir,
      targetDir,
      fw,
      emptyManifest(),
      'commands',
      true,
      installCtx.vars,
      installCtx.resolveFragment,
    );

    const bases = shippedBaseNames(sourceDir);
    const installedOnly: string[] = [];
    const shownOnly: string[] = [];
    const differing: string[] = [];
    let compared = 0;

    for (const base of bases) {
      const installedPath = resolve(targetDir, `${base}.md`);
      const onDisk = existsSync(installedPath) ? readFileSync(installedPath, 'utf-8') : null;
      const shown = await showTemplateOutput(base);

      if (onDisk !== null && shown === null) installedOnly.push(base);
      else if (onDisk === null && shown !== null) shownOnly.push(base);
      else if (onDisk !== null && shown !== null) {
        compared++;
        if (onDisk !== shown) differing.push(base);
      }
    }
    return { compared, installedOnly, shownOnly, differing };
  } finally {
    try {
      process.chdir(prev);
    } catch {
      /* ignore */
    }
    resetConfig();
  }
}

describe('show-template prints exactly what the installer writes', () => {
  for (const [stack, yaml] of [
    ['python-fastapi', PYTHON],
    ['typescript', TYPESCRIPT],
  ] as const) {
    describe(stack, () => {
      it('every shipped command renders identically through both paths', async () => {
        const p = await measureParity(yaml);

        // M1 — a parity run that compared nothing is an ERROR, not a pass.
        expect(
          p.compared,
          'no assets were compared — the derivation of the shipped population is broken',
        ).toBeGreaterThan(20);

        expect(
          p.differing,
          `show-template and the installer disagree on ${p.differing.length} asset(s). ` +
            `They must go through renderResolvedAsset — see asset-render.ts.`,
        ).toEqual([]);

        // A file one path produces and the other does not is the same defect in its
        // loudest form: the diff would be "the whole file".
        expect(p.installedOnly, 'installed but show-template refuses').toEqual([]);
        expect(p.shownOnly, 'show-template prints it but the installer skips it').toEqual([]);
      });
    });
  }

  it('show-template RENDERS — its output differs by stack, and from the raw file', async () => {
    // ⛔ THE NEGATIVE CONTROL, and it is the assertion that would have caught the original
    // bug. Parity alone can be satisfied by BOTH paths doing nothing; these two facts cannot:
    //   (a) two stacks must produce different bytes  -> variables are being substituted;
    //   (b) the output must differ from the bundled source file -> it is not a raw read.
    const read = async (yaml: string): Promise<string> => {
      const root = mkRepo(yaml);
      const prev = process.cwd();
      resetConfig();
      try {
        process.chdir(root);
        const out = await showTemplateOutput('massu-test');
        if (out === null) throw new Error('massu-test did not render');
        return out;
      } finally {
        try {
          process.chdir(prev);
        } catch {
          /* ignore */
        }
        resetConfig();
      }
    };
    const py = await read(PYTHON);
    const ts = await read(TYPESCRIPT);
    expect(py, 'the two stacks render identically — nothing is being substituted').not.toBe(ts);

    const raw = readFileSync(resolve(resolveAssetDir('commands')!, 'massu-test.md'), 'utf-8');
    expect(py, 'show-template printed the file verbatim — it is not rendering').not.toBe(raw);
  });
});
