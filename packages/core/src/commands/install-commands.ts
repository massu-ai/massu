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
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  renameSync,
} from 'fs';
import { resolve, dirname, relative, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { getConfig } from '../config.ts';
import type { Config } from '../config.ts';
import { renderTemplate, MissingVariableError, TemplateParseError } from './template-engine.ts';

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
export function resolveAssetDir(assetName: string): string | null {
  const cwd = process.cwd();

  // 1. npm-installed: node_modules/@massu/core/{assetName}
  const nodeModulesPath = resolve(cwd, 'node_modules/@massu/core', assetName);
  if (existsSync(nodeModulesPath)) {
    return nodeModulesPath;
  }

  // 2. Relative to compiled dist/cli.js → ../{assetName}
  const distRelPath = resolve(__dirname, '..', assetName);
  if (existsSync(distRelPath)) {
    return distRelPath;
  }

  // 3. Relative to source src/commands/ → ../../{assetName}
  const srcRelPath = resolve(__dirname, '../..', assetName);
  if (existsSync(srcRelPath)) {
    return srcRelPath;
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

/** Write the manifest atomically: tempfile + renameSync. */
export function saveManifest(claudeDir: string, manifest: Manifest): void {
  const dir = resolve(claudeDir, '.massu');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const finalPath = resolve(dir, 'install-manifest.json');
  const tempPath = finalPath + '.tmp';
  manifest.generatedAt = new Date().toISOString();
  writeFileSync(tempPath, JSON.stringify(manifest, null, 2), 'utf-8');
  renameSync(tempPath, finalPath);
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
      const existingContent = readFileSync(targetPath, 'utf-8');
      const existingHash = hashContent(existingContent);

      if (existingHash === sourceHash) {
        // Already byte-identical to upstream. Ensure manifest reflects that.
        manifest.entries[manifestKey] = sourceHash;
        stats.skipped++;
        continue;
      }

      if (lastInstalledHash === undefined) {
        // First-install ambiguity: file exists but no manifest entry.
        // Treat as user-edited: keep, record existing hash, print one-line notice.
        manifest.entries[manifestKey] = existingHash;
        process.stderr.write(
          `First-install heuristic: keeping existing ${targetPath} (differs from upstream).\n` +
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
      writeFileSync(targetPath, sourceContent, 'utf-8');
      manifest.entries[manifestKey] = sourceHash;
      stats.updated++;
    } else {
      writeFileSync(targetPath, sourceContent, 'utf-8');
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
  };
}

export function installCommands(projectRoot: string): InstallCommandsResult {
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
  const stats = runWithManifest(claudeDir, (manifest) =>
    syncDirectory(sourceDir, targetDir, framework, manifest, 'commands', true, templateVars),
  );
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
}

export function installAll(projectRoot: string): InstallAllResult {
  const claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  const claudeDir = resolve(projectRoot, claudeDirName);

  const assets: Record<string, SyncStats> = {};
  let totalInstalled = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalKept = 0;

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
  });

  return {
    assets,
    totalInstalled,
    totalUpdated,
    totalSkipped,
    totalKept,
    claudeDir,
  };
}

// ============================================================
// Standalone CLI Runner
// ============================================================

export async function runInstallCommands(): Promise<void> {
  const projectRoot = process.cwd();

  console.log('');
  console.log('Massu AI - Install Project Assets');
  console.log('==================================');
  console.log('');

  const result = installAll(projectRoot);

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
  console.log('');
  console.log('  Restart your Claude Code session to use them.');
  console.log('');
}
