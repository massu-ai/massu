// ─────────────────────────────────────────────────────────────────────────────────────────
// build-bundles.mjs — emits dist/cli.js and dist/hooks/*.js via the esbuild JS API.
//
// Replaces the two `esbuild …` shell strings that used to live in package.json scripts.
// Those were platform-dependent by construction: npm runs scripts through `cmd.exe` on
// Windows, which does not strip single quotes, so the single-quoted `--banner:js='…'`
// was split on whitespace and its fragments were read by esbuild as extra INPUT FILES.
// Nothing here is parsed by a shell, so there is no quoting layer to get wrong.
//
// The bundling contract itself lives in ./build-config.mjs — this file only applies it.
//
// Usage:  node scripts/build-bundles.mjs --cli
//         node scripts/build-bundles.mjs --hooks
// ─────────────────────────────────────────────────────────────────────────────────────────
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTERNALS, BANNER_JS, SHEBANG, BASE_BUILD_OPTIONS } from './build-config.mjs';

const PKG_CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = ['--cli', '--hooks'];

/**
 * `src/hooks/*.ts` used to be expanded by esbuild's own CLI glob handling. The JS API takes
 * explicit entry points, so expand it here — with the SAME shape the glob had: `.ts` files
 * directly under src/hooks, no recursion, no `.d.ts`.
 *
 * Fail-closed (blind-gate law M1/M2): an empty entry-point list must be a LOUD error. A
 * silent zero-entry build exits 0 and emits nothing, which is indistinguishable from a
 * healthy build until something downstream tries to load a hook that was never written.
 */
function hookEntryPoints() {
  const dir = join(PKG_CORE, 'src', 'hooks');
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new Error(`build-bundles: cannot read hook source dir ${dir}: ${err.message}`);
  }
  const entries = names
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))
    .sort()
    .map((n) => join(dir, n));
  if (entries.length === 0) {
    throw new Error(
      `build-bundles: 0 hook entry points under ${dir} — refusing to emit an empty dist/hooks. ` +
        `A build that compiles nothing must not report success.`,
    );
  }
  return entries;
}

async function buildCli() {
  const outfile = join(PKG_CORE, 'dist', 'cli.js');
  await build({
    ...BASE_BUILD_OPTIONS,
    entryPoints: [join(PKG_CORE, 'src', 'cli.ts')],
    outfile,
    external: [...EXTERNALS],
    banner: { js: SHEBANG + BANNER_JS },
    logLevel: 'warning',
  });
  console.log(`[build-bundles] cli: 1 entry point -> ${outfile}`);
}

async function buildHooks() {
  const entryPoints = hookEntryPoints();
  const outdir = join(PKG_CORE, 'dist', 'hooks');
  await build({
    ...BASE_BUILD_OPTIONS,
    entryPoints,
    outdir,
    external: [...EXTERNALS],
    banner: { js: BANNER_JS },
    logLevel: 'warning',
  });
  console.log(`[build-bundles] hooks: ${entryPoints.length} entry points -> ${outdir}`);
}

async function main() {
  const args = process.argv.slice(2);
  const selected = args.filter((a) => TARGETS.includes(a));

  // R-011: refuse an ambiguous or unmatched argument; never resolve it to the most likely
  // candidate. An unrecognised flag is an ERROR, not a silently ignored one.
  const unknown = args.filter((a) => !TARGETS.includes(a));
  if (unknown.length > 0) {
    throw new Error(
      `build-bundles: unrecognised argument(s): ${unknown.join(', ')}. Expected one of ${TARGETS.join(' | ')}.`,
    );
  }
  if (selected.length !== 1) {
    throw new Error(
      `build-bundles: expected exactly one of ${TARGETS.join(' | ')}, got ${selected.length}.`,
    );
  }

  if (selected[0] === '--cli') await buildCli();
  else await buildHooks();
}

main().catch((err) => {
  console.error(`[build-bundles] FAILED: ${err.message}`);
  process.exit(1);
});
