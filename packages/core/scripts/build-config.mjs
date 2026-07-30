// ─────────────────────────────────────────────────────────────────────────────────────────
// build-config.mjs — the SINGLE SOURCE OF TRUTH for how @massu/core is bundled.
//
// WHY THIS EXISTS. Until 2026-07-29 the bundling contract lived in THREE hand-maintained
// places: the `--external:` flags of `build:cli`, the identical flags of `build:hooks`, and
// a `const EXTERNALS` in scripts/bundle-adapters.ts carrying the comment "keep in lockstep
// with build:cli externals". It had already drifted — bundle-adapters.ts was missing
// `onnxruntime-web`, `@massu/adapter-rails` and `@massu/adapter-spring` (11 vs 14).
//
// The two package.json copies were worse than duplicated: they were encoded as SHELL
// STRINGS, so their correctness depended on the shell npm happens to use. On Windows npm
// runs scripts through `cmd.exe`, which does not treat `'` as a quote — it split the
// single-quoted banner on spaces, esbuild read the fragments as extra INPUT FILES, and
// `npm run build` failed with `Must use "outdir" when there are multiple input files`
// (CI run 30428800020). `build:cli`'s banner additionally carries a literal NEWLINE for the
// shebang, and cmd.exe cannot carry a newline inside an argument at all — so no CLI-string
// form of build:cli can work on Windows while keeping the shebang. Consuming these values
// from JS instead of a shell string removes the quoting layer entirely.
//
// EXTERNALS IS NOT DERIVABLE FROM package.json, and this was measured rather than assumed:
//   EXTERNALS - dependencies = ['fsevents']
//       fsevents is a transitive, platform-optional NATIVE dep of chokidar. It is never a
//       declared dependency, and esbuild must not try to bundle it.
//   dependencies - EXTERNALS = ['@clack/prompts', '@massu/types', 'fast-glob']
//       declared deps that are deliberately INLINED so the published CLI works without them.
// So this list is a real build decision, not a restatement of package.json. The property
// achieved here is SINGLE-SOURCE, not zero-source — every consumer imports these bindings;
// none re-declares them.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Packages left as runtime `import`s instead of being inlined into the bundle.
 * @type {readonly string[]}
 */
export const EXTERNALS = Object.freeze([
  'better-sqlite3',
  'yaml',
  'zod',
  'chokidar',
  'proper-lockfile',
  'fsevents',
  'web-tree-sitter',
  'tweetnacl',
  'tar',
  'smol-toml',
  'vscode-languageserver-protocol',
  'onnxruntime-web',
  '@massu/adapter-rails',
  '@massu/adapter-spring',
]);

/**
 * ESM output has no CommonJS `require`. Several externals (notably the native SQLite
 * fallback) are loaded through it, so every bundle re-creates one from `import.meta.url`.
 * @type {string}
 */
export const BANNER_JS =
  'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);';

/**
 * Prepended to the CLI bundle ONLY, so `dist/cli.js` is directly executable. The trailing
 * newline is load-bearing: a shebang is only honoured as the first LINE of the file.
 * @type {string}
 */
export const SHEBANG = '#!/usr/bin/env node\n';

/**
 * Settings shared by every bundle this package emits.
 * @type {{bundle: true, platform: 'node', format: 'esm'}}
 */
export const BASE_BUILD_OPTIONS = Object.freeze({
  bundle: true,
  platform: 'node',
  format: 'esm',
});
