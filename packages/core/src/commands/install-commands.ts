// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu install-commands` — Install massu slash commands, agents, patterns,
 * protocols, and reference files into a project.
 *
 * Copies all massu assets from the npm package into the project's .claude/
 * directory. Existing massu files are updated; non-massu files are preserved.
 * Handles subdirectories recursively (e.g., golden-path/references/).
 *
 * v1.3.0 — Stack-aware variants + local-edit protection (manifest):
 *   - Variant resolution at the top level of `commands/`: a template named
 *     `<base>.<variant>.md` is preferred over `<base>.md` when the consumer's
 *     `massu.config.yaml` declares a matching language. See `pickVariant`.
 *   - Local edits are preserved across reinstalls via a per-consumer manifest
 *     (`<claudeDir>/.massu/install-manifest.json`) that records the SHA-256 of
 *     each file at last install. See "Layer 3: Local-edit protection" in the
 *     2026-04-26 plan doc.
 */

import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'fs';
import { resolve, dirname, relative, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { getConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { renderTemplate, MissingVariableError, TemplateParseError } from './template-engine.ts';
import { atomicWriteFile } from '../lib/settings-local.ts';
import { installPermissions } from '../permissions.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Asset Types
// ============================================================

/** Asset categories distributed by massu */
const ASSET_TYPES = [
  { name: 'commands', targetSubdir: 'commands', description: 'slash commands' },
  { name: 'agents', targetSubdir: 'agents', description: 'agent definitions' },
  { name: 'patterns', targetSubdir: 'patterns', description: 'pattern files' },
  { name: 'protocols', targetSubdir: 'protocols', description: 'protocol files' },
  { name: 'reference', targetSubdir: 'reference', description: 'reference files' },
] as const;

// ============================================================
// Directory Resolution
// ============================================================

/**
 * Resolve the path to a bundled asset directory.
 * Handles both npm-installed and local development scenarios.
 */
/**
 * An asset dir is only a HIT if it actually CONTAINS assets.
 *
 * CR-65 — BROKEN AND EMPTY MAY NEVER RENDER IDENTICALLY.
 *
 * `existsSync(dir)` was the entire test, and it is the wrong question. Running from source,
 * `__dirname` is `src/commands/`, so candidate 2 — `resolve(__dirname, '..', 'commands')` —
 * resolves to `src/commands` ITSELF: a directory that exists, contains only `.ts`, and holds
 * ZERO installable assets. The resolver returned it, the installer walked it, found nothing to
 * do, and reported success with `installed: 0`.
 *
 *     "I found no commands to install"   and   "I looked in the wrong directory"
 *
 * were byte-identical. A resolver that CANNOT SEE passed as a resolver that FOUND NOTHING —
 * which is the mechanism behind every bug in this codebase's silent-failure class.
 *
 * So a candidate must prove it holds assets. If none does, we return null and the caller FAILS
 * LOUD rather than quietly installing nothing.
 */
function dirHoldsAssets(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some(
      (e) => e.endsWith('.md') || statSync(resolve(dir, e)).isDirectory(),
    );
  } catch {
    // Unreadable is NOT empty. Refuse it.
    return false;
  }
}

export function resolveAssetDir(assetName: string): string | null {
  const cwd = process.cwd();

  const candidates = [
    // 1. npm-installed: node_modules/@massu/core/{assetName}
    resolve(cwd, 'node_modules/@massu/core', assetName),
    // 2. Relative to compiled dist/cli.js → ../{assetName}
    resolve(__dirname, '..', assetName),
    // 3. Relative to source src/commands/ → ../../{assetName}
    resolve(__dirname, '../..', assetName),
  ];

  for (const c of candidates) {
    if (dirHoldsAssets(c)) return c;
  }

  return null;
}

/** Legacy alias for backwards compatibility */
export function resolveCommandsDir(): string | null {
  return resolveAssetDir('commands');
}

// ============================================================
// Manifest (local-edit protection)
// ============================================================

const MANIFEST_VERSION = 1;
const MANIFEST_RELPATH = join('.massu', 'install-manifest.json');

/** Manifest file shape — see plan §"Manifest JSON shape". */
export interface Manifest {
  version: number;
  generatedBy: string;
  generatedAt: string;
  /** key: path relative to the consumer's claudeDir; value: SHA-256 hex digest. */
  entries: Record<string, string>;
}

/** SHA-256 hex digest of a string. */
/**
 * MASSU-OWNED files: product code, never user configuration.
 *
 * These are vendored into `.claude/` the way a library is vendored into `node_modules` — the
 * user does not own them, does not configure them, and cannot silence them by editing their
 * local copy. Upstream ALWAYS wins for these paths.
 *
 * WHY THIS EXISTS. The installer's fail-closed branches protect the user's customizations, and
 * they are right to — a prior version destroyed a user's local work by recording a hash for a
 * file it had not written. But those branches treat EVERY file as potentially user-owned, and
 * that froze the verification laws: measured against faithful copies of four real consumer
 * repos, the laws reached exactly ONE. In the rest the laws file was "kept" forever, either for
 * lack of manifest provenance or because it had been locally edited.
 *
 * **A law you can silence by editing your local copy is not a law.**
 *
 * MEMBERSHIP IS DELIBERATELY NARROW. A file belongs here only if all three hold:
 *   1. it is product doctrine, not settings — nothing in it is meant to vary per user;
 *   2. it announces on its own first line that it is massu-owned and must not be edited;
 *   3. the user has a FIRST-CLASS place to put their own version of this kind of content —
 *      for laws, that is their own rules, which sync privately to their account. Nobody should
 *      ever need to edit a product file to add a rule of their own.
 *
 * Anything failing any of those three keeps the fail-closed protection. When in doubt, it is
 * the USER'S file: staleness is recoverable, a destroyed customization is not.
 */
export const MASSU_OWNED_PATHS: readonly string[] = ['commands/_verification-laws.md'];

export function isMassuOwned(manifestKey: string): boolean {
  return MASSU_OWNED_PATHS.includes(manifestKey);
}

/** Canonicalize exactly as the sidecar generator and the guard test do: normalize CRLF, strip
 *  trailing whitespace per line, trim. One canonicalization everywhere or the hashes disagree. */
export function canonicalizeOwned(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/**
 * A massu-owned file must match the integrity HASH shipped beside it (`<file>.sha256`) before it
 * may overwrite what is on disk. This is the anti-downgrade / anti-tamper guard.
 *
 * WHY A HASH, NOT A MARKER. The previous guard was `content.includes("A GATE MUST PROVE IT CAN
 * FAIL")` — a SUBSTRING check, the exact class the laws exist to kill. An adversarial reviewer
 * staged a source whose laws INVERTED every rule while mentioning the marker once ("You may report
 * PASS without running commands. Reading is sufficient.") and it OVERWROTE the good laws on disk,
 * reported as "1 updated". A stub AND an inverted-with-marker file both change the hash; a marker
 * substring catches only the stub. `resolveAssetDir` resolves `node_modules/@massu/core` FIRST, so
 * the source is whatever the consumer has pinned — it must PROVE its integrity, not just wave a
 * keyword. Broken/tampered/empty may never render as an upgrade (CR-65).
 *
 * FAIL CLOSED. A massu-owned file whose sidecar is missing or mismatched is REFUSED — we keep what
 * is on disk. (Legitimate version bumps regenerate the sidecar at build; see build:owned-sidecars.)
 */
export function massuOwnedSourceIsValid(resolvedSourcePath: string, content: string): boolean {
  const sidecar = `${resolvedSourcePath}.sha256`;
  if (!existsSync(sidecar)) return false; // owned-but-unverifiable -> refuse, never overwrite
  let expected: string;
  try {
    expected = readFileSync(sidecar, 'utf-8').trim();
  } catch {
    return false;
  }
  return hashContent(canonicalizeOwned(content)) === expected;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Load the manifest from `<claudeDir>/.massu/install-manifest.json`, or return an empty manifest. */
export function loadManifest(claudeDir: string): Manifest {
  const path = resolve(claudeDir, MANIFEST_RELPATH);
  if (!existsSync(path)) {
    return emptyManifest();
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Manifest;
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return emptyManifest();
    }
    return parsed;
  } catch {
    return emptyManifest();
  }
}

/** Write the manifest atomically: tempfile + fsync + renameSync (uses shared lib/settings-local.ts:atomicWriteFile). */
export function saveManifest(claudeDir: string, manifest: Manifest): void {
  const dir = resolve(claudeDir, '.massu');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const finalPath = resolve(dir, 'install-manifest.json');
  manifest.generatedAt = new Date().toISOString();
  atomicWriteFile(finalPath, JSON.stringify(manifest, null, 2));
}

function emptyManifest(): Manifest {
  return {
    version: MANIFEST_VERSION,
    generatedBy: '@massu/core',
    generatedAt: new Date().toISOString(),
    entries: {},
  };
}

/**
 * Run a function with the manifest loaded; persist atomically afterward.
 * Used by both `installAll` and the legacy `installCommands` so any caller
 * of either entry point gets the manifest written exactly once per run.
 */
export function runWithManifest<T>(claudeDir: string, fn: (m: Manifest) => T): T {
  const manifest = loadManifest(claudeDir);
  const result = fn(manifest);
  saveManifest(claudeDir, manifest);
  return result;
}

// ============================================================
// Variant Resolution (Phase 1)
// ============================================================

/** Discriminated-union return shape for `pickVariant`. */
export type PickVariantResult =
  | { kind: 'hit'; suffix: string } // found a variant (suffix may be "")
  | { kind: 'miss' } // no candidate found, caller SKIPS the file
  | { kind: 'fallback'; reason: string }; // misconfig / safe fallback, caller copies UNSUFFIXED default

/** Well-known language keys for the passthrough-fallback step in `pickVariant`. */
const PASSTHROUGH_LANG_KEYS = [
  'typescript',
  'javascript',
  'python',
  'swift',
  'rust',
  'go',
] as const;

/**
 * Choose the variant suffix for a base template name.
 *
 * Two-axis priority (Plan #2 P2-001 extends Plan #1's lang-only axis):
 *   For each language `L` in priority order (primary, languages.*, passthrough.*):
 *     a. If a sub-framework `F` is declared for L, probe `<base>.<L>-<F>.md`.
 *     b. Probe `<base>.<L>.md` (lang-only fallback).
 *   Then probe the unsuffixed `<base>.md`.
 *
 * Priority order for the language list (Plan #1):
 *   1. `framework.primary` (or `framework.type` if primary undefined). With the
 *      sub-framework axis, the candidate framework is the matching
 *      `framework.languages[primary].framework` if present, else `framework.router`
 *      / `framework.orm` / `framework.ui` heuristics, else just lang-only.
 *   2. Each declared `framework.languages.<lang>` entry with a non-empty `framework`,
 *      in YAML declaration order. Sub-framework = `entry.framework`.
 *   3. Passthrough fallback: well-known top-level `framework.<lang>` blocks with a
 *      non-empty `framework` field, in fixed order, excluding entries already covered.
 *      Sub-framework = top-level block's `framework` field.
 *   4. The unsuffixed default ("").
 *
 * The function NEVER throws. It returns a discriminated union so the caller can
 * distinguish "skip this file" from "copy the default" — see plan §"Error semantics".
 */
export function pickVariant(
  baseName: string,
  sourceDir: string,
  framework: Config['framework'],
): PickVariantResult {
  // Build (lang, subFramework) candidate pairs in priority order. Sub-framework
  // can be undefined — in that case only the lang-only axis is probed for that
  // language.
  type Candidate = { lang: string; subFramework?: string };
  const candidates: Candidate[] = [];
  const seenLangs = new Set<string>();

  function pushCandidate(lang: string, sub: string | undefined): void {
    if (seenLangs.has(lang)) return;
    seenLangs.add(lang);
    candidates.push({ lang, subFramework: sub && sub.length > 0 ? sub : undefined });
  }

  // 1. framework.primary (or fall back to framework.type)
  const primary = framework.primary ?? framework.type;
  if (primary && primary !== 'multi') {
    // Best-effort sub-framework detection for the primary lang:
    //   - If `framework.languages[primary]` has a `framework`, use that.
    //   - Else, fall back to top-level passthrough `framework[primary].framework`.
    let primarySub: string | undefined;
    if (framework.languages && framework.languages[primary]?.framework) {
      primarySub = framework.languages[primary].framework;
    } else {
      const passthrough = framework as unknown as Record<string, unknown>;
      const block = passthrough[primary];
      if (block && typeof block === 'object') {
        const fw = (block as { framework?: unknown }).framework;
        if (typeof fw === 'string' && fw.length > 0) primarySub = fw;
      }
    }
    pushCandidate(primary, primarySub);
  }

  // 2. framework.languages declaration order
  if (framework.languages) {
    for (const lang of Object.keys(framework.languages)) {
      const entry = framework.languages[lang];
      if (entry && typeof entry.framework === 'string' && entry.framework.length > 0) {
        pushCandidate(lang, entry.framework);
      }
    }
  }

  // 3. Passthrough fallback — `framework.<lang>` (top-level passthrough block).
  const passthrough = framework as unknown as Record<string, unknown>;
  for (const lang of PASSTHROUGH_LANG_KEYS) {
    if (seenLangs.has(lang)) continue;
    const block = passthrough[lang];
    if (block && typeof block === 'object') {
      const fw = (block as { framework?: unknown }).framework;
      if (typeof fw === 'string' && fw.length > 0) {
        pushCandidate(lang, fw);
      }
    }
  }

  // 4. Probe disk — for each (lang, sub) pair, try lang-sub first, then lang-only.
  for (const cand of candidates) {
    if (cand.subFramework) {
      const subPath = resolve(sourceDir, `${baseName}.${cand.lang}-${cand.subFramework}.md`);
      if (existsSync(subPath)) {
        return { kind: 'hit', suffix: `.${cand.lang}-${cand.subFramework}` };
      }
    }
    const langPath = resolve(sourceDir, `${baseName}.${cand.lang}.md`);
    if (existsSync(langPath)) {
      return { kind: 'hit', suffix: `.${cand.lang}` };
    }
  }
  // Unsuffixed default
  const defaultPath = resolve(sourceDir, `${baseName}.md`);
  if (existsSync(defaultPath)) {
    return { kind: 'hit', suffix: '' };
  }

  // No hit. Risk #7: framework.type=multi without primary → safe fallback.
  if (framework.type === 'multi' && !framework.primary) {
    process.stderr.write(
      'massu: warning - framework.type=multi but framework.primary is undefined; ' +
        'falling back to default templates\n',
    );
    return { kind: 'fallback', reason: 'multi-without-primary' };
  }

  return { kind: 'miss' };
}

// ============================================================
// Recursive File Sync
// ============================================================

interface SyncStats {
  installed: number;
  updated: number;
  skipped: number;
  kept: number;
}

/** Returns true if a top-level entry name has the `<base>.<variant>.md` shape. */
function isVariantFilename(entry: string): boolean {
  // Match exactly one inner dot before `.md`. `_shared-preamble.md` (no inner dot) survives.
  return /^[^.]+\.[^.]+\.md$/.test(entry);
}

/**
 * Recursively sync all .md files from sourceDir to targetDir.
 *
 * At top level (`topLevel === true`), apply variant resolution:
 *   - Skip entries that match `<base>.<variant>.md` (the variant siblings are
 *     selected indirectly via `pickVariant` so they never land in the consumer
 *     dir directly).
 *   - For each base entry `<base>.md`, call `pickVariant` to choose the source.
 *
 * At depth ≥ 1 (subdirectory recursion), copy files as-is — no variant logic,
 * no dot-skip filter (so future authors can use dotted filenames in subdirs).
 */
export function syncDirectory(
  sourceDir: string,
  targetDir: string,
  framework: Config['framework'],
  manifest: Manifest,
  manifestKeyPrefix: string,
  topLevel: boolean = true,
  templateVars: Record<string, unknown> = {},
): SyncStats {
  const stats: SyncStats = { installed: 0, updated: 0, skipped: 0, kept: 0 };

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const entries = readdirSync(sourceDir);

  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry);
    const entryStat = statSync(sourcePath);

    if (entryStat.isDirectory()) {
      // Recurse — depth > 0 disables variant filtering for nested files.
      const subTargetDir = resolve(targetDir, entry);
      const subPrefix = manifestKeyPrefix === ''
        ? entry
        : `${manifestKeyPrefix}/${entry}`;
      const subStats = syncDirectory(
        sourcePath,
        subTargetDir,
        framework,
        manifest,
        subPrefix,
        false,
        templateVars,
      );
      stats.installed += subStats.installed;
      stats.updated += subStats.updated;
      stats.skipped += subStats.skipped;
      stats.kept += subStats.kept;
      continue;
    }

    if (!entry.endsWith('.md')) continue;

    let sourceFilename = entry;
    let baseName = entry.slice(0, -'.md'.length);

    if (topLevel) {
      // Skip variant siblings — they are selected indirectly via the base name.
      if (isVariantFilename(entry)) continue;

      const choice = pickVariant(baseName, sourceDir, framework);
      if (choice.kind === 'miss') {
        // No file to copy.
        continue;
      }
      // 'hit' or 'fallback' both copy a file:
      //   - 'hit' uses the chosen suffix (may be "")
      //   - 'fallback' copies the unsuffixed default (same as suffix === "")
      const suffix = choice.kind === 'hit' ? choice.suffix : '';
      sourceFilename = suffix === '' ? `${baseName}.md` : `${baseName}${suffix}.md`;
    }

    const resolvedSourcePath = resolve(sourceDir, sourceFilename);
    if (!existsSync(resolvedSourcePath)) {
      // Defensive: pickVariant said hit, but file vanished between probe and read.
      continue;
    }

    // Target filename is always the BASE name (variant suffix is internal to the package).
    const targetFilename = topLevel ? `${baseName}.md` : entry;
    const targetPath = resolve(targetDir, targetFilename);
    const rawContent = readFileSync(resolvedSourcePath, 'utf-8');

    // Plan #2 P1-003: render any `{{var}}` substitutions BEFORE hashing so
    // the manifest entry hash matches the byte-stream that lands on disk.
    // Engine errors (missing var, malformed token) fail this single file but
    // never abort the whole install — see spec §"Error semantics".
    let sourceContent: string;
    try {
      sourceContent = renderTemplate(rawContent, templateVars);
    } catch (err) {
      if (err instanceof MissingVariableError || err instanceof TemplateParseError) {
        process.stderr.write(
          `massu: skipping ${resolvedSourcePath}: ${err.message}\n`,
        );
        stats.skipped++;
        continue;
      }
      throw err;
    }
    const sourceHash = hashContent(sourceContent);

    const manifestKey = manifestKeyPrefix === ''
      ? targetFilename
      : `${manifestKeyPrefix}/${targetFilename}`;
    const lastInstalledHash = manifest.entries[manifestKey];

    if (existsSync(targetPath)) {
      // A directory, socket, or unreadable node where a file belongs must fail THIS file, never
      // the whole install. `readFileSync` on a directory throws EISDIR; before this guard, one
      // stray directory at a target path aborted installAll and left agents/patterns/protocols/
      // reference all at zero — a single bad node DoS'd every asset.
      let existingContent: string;
      try {
        if (!statSync(targetPath).isFile()) throw new Error('not a regular file');
        existingContent = readFileSync(targetPath, 'utf-8');
      } catch (err) {
        process.stderr.write(
          `massu: skipping ${manifestKey}: target is not a readable file ` +
            `(${err instanceof Error ? err.message : String(err)}). Remove it and re-install.\n`,
        );
        stats.skipped++;
        continue;
      }
      const existingHash = hashContent(existingContent);

      if (existingHash === sourceHash) {
        // Already byte-identical to upstream. Ensure manifest reflects that.
        manifest.entries[manifestKey] = sourceHash;
        stats.skipped++;
        continue;
      }

      if (isMassuOwned(manifestKey)) {
        // ─── MASSU-OWNED — PRODUCT CODE, NOT YOUR CONFIG. ALWAYS OVERWRITE. ──────────────
        //
        // The fail-closed branches below exist to protect the USER'S customizations, and they
        // are right to. But they classify EVERY file as potentially-user-owned, and that made
        // them freeze the one file that is not: the verification laws.
        //
        // MEASURED, against faithful copies of four real consumer repos, with the real
        // installer: the laws reached ONE of them. In the other three the laws file either had
        // no manifest provenance (FIRST-INSTALL AMBIGUITY -> kept forever, idempotently) or had
        // been locally edited (-> "local edits, kept your version"). Both branches are correct
        // for a user's file. Both are catastrophic for a law: the delivery vehicle for the
        // rules that make Massu trustworthy sat on the one code path guaranteed never to update.
        //
        // A law you can silence by editing your local copy is not a law. So this class exists:
        // a MASSU-OWNED file is vendored product code — like a library file in node_modules. It
        // is documented as uneditable in its own first line, it carries no user configuration,
        // and upstream ALWAYS wins.
        //
        // This does NOT weaken the never-destroy-local-work guarantee. That guarantee is about
        // the USER'S files. This is ours, it says so on its face, and the user's own rules live
        // somewhere else entirely (authored as rules, synced privately to their account) —
        // precisely so that nobody ever has to edit a product file to add one.
        //
        // ANTI-DOWNGRADE: the SOURCE must prove it is the real file before it may overwrite. A
        // stale/stub source (resolved from an older pinned package) must never replace good laws.
        if (!massuOwnedSourceIsValid(resolvedSourcePath, sourceContent)) {
          process.stderr.write(
            `massu: REFUSING to overwrite massu-owned ${manifestKey} — the source failed its ` +
              `integrity hash (${resolvedSourcePath}.sha256 missing or mismatched). Your installed ` +
              `@massu/core may be stale or tampered; run \`npm i @massu/core@latest\` and ` +
              `re-install. Kept the existing file.\n`,
          );
          stats.kept++;
          continue;
        }
        atomicWriteFile(targetPath, sourceContent);
        manifest.entries[manifestKey] = sourceHash;
        stats.updated++;
        continue;
      }

      if (lastInstalledHash === undefined) {
        // ─── FIRST-INSTALL AMBIGUITY — FAIL CLOSED ───────────────────────────────────────
        //
        // The file exists, differs from upstream, and there is NO manifest entry. So we do not
        // know who wrote it: massu (from a version predating the manifest) or a human.
        //
        // KEEP IT — and record NOTHING.
        //
        // This branch used to do `manifest.entries[manifestKey] = existingHash`, i.e. record the
        // hash of a file it DID NOT WRITE. The manifest's entire meaning is "this is the hash of
        // what massu installed"; that line wrote a LIE into it. On the NEXT run the safe-upgrade
        // branch below read the lie back — `existingHash === lastInstalledHash` — concluded the
        // file was untouched since massu wrote it, and OVERWROTE the user's work.
        //
        // RUN 1 ARMED IT. RUN 2 DETONATED IT. Measured with the real installer against a scratch
        // copy of a real repo: run 1 reported "36 kept (local edits)", run 2 reported
        // "36 updated" — 36 files of local work destroyed, silently, reported as success.
        //
        // It was a FAIL-OPEN inside a branch whose own comment announced it was handling
        // AMBIGUITY. Asked "who wrote this?", the installer answered "massu, probably" and took
        // the destructive action. The only safe answer to not knowing is to write nothing: the
        // ambiguity is then re-detected on every subsequent run, and the file is kept on every
        // subsequent run — forever, idempotently.
        //
        // THE DELIBERATE CONSEQUENCE: a customized file with no provenance FREEZES. Upstream's
        // improvements will not reach it until either (a) a real three-way merge exists, or
        // (b) the user explicitly runs `rm <file> && massu install-commands`. It is stale, and it
        // is SAFE. Between "stale" and "your work is silently deleted", the operator's binding
        // rule — "never delete YOUR customizations; upstream may change its own content" —
        // chooses stale, every time.
        //
        // Guarded by: src/__tests__/install-commands-never-destroys-local-edits.test.ts
        // (FAILOPEN-01..07), which is RED against the previous behaviour.
        process.stderr.write(
          `First-install: keeping existing ${targetPath} (differs from upstream, and massu has ` +
            `no record of writing it).\n` +
            `  It will be kept on every future install until you resolve it explicitly.\n` +
            `  To accept upstream: rm ${targetPath} && npx massu install-commands\n`,
        );
        stats.kept++;
        continue;
      }

      if (existingHash !== lastInstalledHash) {
        // User edited it after the last install. Preserve.
        process.stderr.write(
          `${targetFilename} has local edits - kept your version.\n` +
            `  To accept upstream: rm ${targetPath} && npx massu install-commands\n` +
            `  To diff:            diff ${targetPath} <(npx massu show-template ${baseName})\n`,
        );
        stats.kept++;
        continue;
      }

      // existingHash === lastInstalledHash and sourceHash differs → safe upgrade.
      atomicWriteFile(targetPath, sourceContent);
      manifest.entries[manifestKey] = sourceHash;
      stats.updated++;
    } else {
      atomicWriteFile(targetPath, sourceContent);
      manifest.entries[manifestKey] = sourceHash;
      stats.installed++;
    }
  }

  return stats;
}

// ============================================================
// Install Commands (legacy API — preserved for backwards compat)
// ============================================================

export interface InstallCommandsResult {
  installed: number;
  updated: number;
  skipped: number;
  kept: number;
  commandsDir: string;
}

/**
 * Build the variable scope passed to the templating engine.
 * See spec §"Variable scope passed to the engine" for the contract.
 */
export function buildTemplateVars(): Record<string, unknown> {
  const config = getConfig();
  return {
    framework: config.framework,
    paths: config.paths,
    detected: config.detected ?? {},
    config,
    // P-H006 (plan-stage-c-high-batch): RESERVED CLAUDE CODE PLACEHOLDER.
    // Claude Code reads `{{ARGUMENTS}}` as a runtime placeholder inside
    // slash-command files. The Massu template engine has no native concept
    // of reserved literals; we model the placeholder as a variable whose
    // value IS the literal `{{ARGUMENTS}}` string. Because the engine never
    // re-renders output, this passes through verbatim. Closes the bug class
    // where `/massu-article-review`, `/massu-autoresearch`, etc. silently
    // failed to install because the engine threw MissingVariableError on
    // their {{ARGUMENTS}} usage.
    ARGUMENTS: '{{ARGUMENTS}}',
  };
}

export interface InstallCommandsOptions {
  /** When true, skip seeding `mcp__massu__*` into permissions.allow. */
  skipPermissions?: boolean;
}

export function installCommands(
  projectRoot: string,
  opts: InstallCommandsOptions = {},
): InstallCommandsResult {
  const claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  const claudeDir = resolve(projectRoot, claudeDirName);
  const targetDir = resolve(claudeDir, 'commands');

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const sourceDir = resolveAssetDir('commands');
  if (!sourceDir) {
    console.error('  ERROR: Could not find massu commands directory.');
    console.error('  Try reinstalling: npm install @massu/core');
    return { installed: 0, updated: 0, skipped: 0, kept: 0, commandsDir: targetDir };
  }

  const framework = getConfig().framework;
  const templateVars = buildTemplateVars();
  const stats = runWithManifest(claudeDir, (manifest) => {
    const syncStats = syncDirectory(
      sourceDir,
      targetDir,
      framework,
      manifest,
      'commands',
      true,
      templateVars,
    );
    if (!opts.skipPermissions) {
      installPermissions(claudeDir, manifest, { silent: true });
    }
    return syncStats;
  });
  return { ...stats, commandsDir: targetDir };
}

// ============================================================
// Install All Assets
// ============================================================

export interface InstallAllResult {
  assets: Record<string, SyncStats>;
  totalInstalled: number;
  totalUpdated: number;
  totalSkipped: number;
  totalKept: number;
  claudeDir: string;
  /** Permission-seeding outcome (undefined when --skip-permissions). */
  permissions?: { installed: number; kept: number; skipped: number };
}

export interface InstallAllOptions {
  /** When true, skip seeding `mcp__massu__*` into permissions.allow. */
  skipPermissions?: boolean;
}

export function installAll(
  projectRoot: string,
  opts: InstallAllOptions = {},
): InstallAllResult {
  const claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  const claudeDir = resolve(projectRoot, claudeDirName);

  const assets: Record<string, SyncStats> = {};
  let totalInstalled = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalKept = 0;
  let permissionsResult: { installed: number; kept: number; skipped: number } | undefined;

  const framework = getConfig().framework;
  const templateVars = buildTemplateVars();

  runWithManifest(claudeDir, (manifest) => {
    for (const assetType of ASSET_TYPES) {
      const sourceDir = resolveAssetDir(assetType.name);
      if (!sourceDir) continue;

      const targetDir = resolve(claudeDir, assetType.targetSubdir);
      const stats = syncDirectory(
        sourceDir,
        targetDir,
        framework,
        manifest,
        assetType.targetSubdir,
        true,
        templateVars,
      );

      assets[assetType.name] = stats;
      totalInstalled += stats.installed;
      totalUpdated += stats.updated;
      totalSkipped += stats.skipped;
      totalKept += stats.kept;
    }
    if (!opts.skipPermissions) {
      permissionsResult = installPermissions(claudeDir, manifest, { silent: true });
    }
  });

  return {
    assets,
    totalInstalled,
    totalUpdated,
    totalSkipped,
    totalKept,
    claudeDir,
    permissions: permissionsResult,
  };
}

// ============================================================
// Standalone CLI Runner
// ============================================================

export async function runInstallCommands(): Promise<void> {
  const projectRoot = process.cwd();
  const skipPermissions = process.argv.slice(2).includes('--skip-permissions');

  console.log('');
  console.log('Massu AI - Install Project Assets');
  console.log('==================================');
  console.log('');

  const result = installAll(projectRoot, { skipPermissions });

  // Report per-asset-type
  for (const assetType of ASSET_TYPES) {
    const stats = result.assets[assetType.name];
    if (!stats) {
      continue;
    }
    const total = stats.installed + stats.updated + stats.skipped + stats.kept;
    if (total === 0) continue;

    const parts: string[] = [];
    if (stats.installed > 0) parts.push(`${stats.installed} new`);
    if (stats.updated > 0) parts.push(`${stats.updated} updated`);
    if (stats.skipped > 0) parts.push(`${stats.skipped} current`);
    if (stats.kept > 0) parts.push(`${stats.kept} kept (local edits)`);

    const description = assetType.description;
    console.log(`  ${description}: ${parts.join(', ')} (${total} total)`);
  }

  const grandTotal =
    result.totalInstalled + result.totalUpdated + result.totalSkipped + result.totalKept;
  console.log('');
  console.log(`  ${grandTotal} total files synced to ${result.claudeDir}`);
  if (result.totalKept > 0) {
    console.log(
      `  ${result.totalKept} file(s) had local edits and were preserved (see stderr above).`,
    );
  }

  // Permission seeding outcome line
  if (skipPermissions) {
    console.log('  Permission seeding skipped (--skip-permissions).');
  } else if (result.permissions) {
    if (result.permissions.installed > 0) {
      console.log(
        `  Wrote merged permissions block to .claude/settings.local.json (use --skip-permissions to opt out).`,
      );
    } else if (result.permissions.kept > 0) {
      console.log(
        `  MCP allowlist entry was edited by operator; preserved. Use \`npx massu permissions check-drift\` to inspect.`,
      );
    }
    // skipped:1 → silent (already in sync, no operator-visible change)
  }

  console.log('');
  console.log('  Restart your Claude Code session to use them.');
  console.log('');
}
