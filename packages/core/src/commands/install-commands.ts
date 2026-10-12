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
import { resolve, relative, join } from 'path';
import { createHash } from 'crypto';
import { getConfig } from '../config.ts';
import type { Config } from '../config.ts';
import type { FragmentStats } from './fragments.ts';
// Variant selection and rendering live in their own modules so that every consumer of a
// bundled asset — this installer, `massu show-template`, anything added later — reaches the
// SAME answer instead of deriving its own. See the header of `asset-render.ts` for what the
// second derivation cost.
import {
  resolveAssetDir,
  isVariantFilename,
  variantFilename,
  pickVariant,
  type PickVariantResult,
} from './asset-resolution.ts';
import {
  buildTemplateVars,
  makeRenderContext,
  renderResolvedAsset,
  renderAssetFile,
  type RenderContext,
} from './asset-render.ts';
import { atomicWriteFile } from '../lib/settings-local.ts';
import { installPermissions } from '../permissions.ts';

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
// Recursive File Sync
// ============================================================

interface SyncStats {
  installed: number;
  updated: number;
  skipped: number;
  kept: number;
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
  // P4.3b: supplies `{{> name}}` bodies. Threaded through rather than built here so
  // ONE resolver (and one FragmentStats) spans the whole recursive walk.
  resolveFragment?: (name: string) => string | null,
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
        resolveFragment,
      );
      stats.installed += subStats.installed;
      stats.updated += subStats.updated;
      stats.skipped += subStats.skipped;
      stats.kept += subStats.kept;
      continue;
    }

    if (!entry.endsWith('.md')) continue;

    // ⛔ A DIRECTORY'S OWN README IS CORPUS FRONT MATTER, NOT AN ASSET.
    //
    // `commands/README.md` documents what the directory ships and how the templating
    // works. It is not a slash command and no customer was ever meant to receive it in
    // `.claude/commands/`. It was nonetheless in the rendered population, and because it
    // DOCUMENTS the syntax it contains a literal `{{variable.path}}` at line 115 — which
    // the renderer tried to resolve, threw `MissingVariableError`, and the installer
    // caught and turned into `stats.skipped++` plus one stderr line, exit 0.
    //
    // So it has been SILENTLY DROPPED on every stack since `{{...}}` rendering shipped in
    // 1.3.0, and nothing reported it. That is this plan's headline failure mode — an asset
    // silently absent while the install reports success — sitting inside the asset corpus
    // the whole time. Measured 2026-09-20: `totalSkipped=1`, `commands: skipped=1`.
    //
    // Fixing its escapes instead would be the WRONG repair: the file would then render
    // successfully and start appearing in every customer's command list, which is worse
    // than being absent. The defect is that it is in the population at all.
    //
    // Note line 119 of that README documents the `\{{` escape its own examples on 115/118
    // do not use — the documentation of the escape hatch is what the missing escape hatch
    // broke. The CLASS (an asset silently dropped) is now held by the P4 acceptance
    // gate, which asserts `stats.skipped === 0` on all 13 fixtures.
    if (entry === 'README.md') continue;

    let sourceFilename = entry;
    let baseName = entry.slice(0, -'.md'.length);

    if (topLevel) {
      // Skip variant siblings — they are selected indirectly via the base name.
      if (isVariantFilename(entry)) continue;

      const selected = variantFilename(baseName, pickVariant(baseName, sourceDir, framework));
      // A miss means this stack selects no file for that base name.
      if (selected === null) continue;
      sourceFilename = selected;
    }

    const resolvedSourcePath = resolve(sourceDir, sourceFilename);

    // Target filename is always the BASE name (variant suffix is internal to the package).
    const targetFilename = topLevel ? `${baseName}.md` : entry;
    const targetPath = resolve(targetDir, targetFilename);

    // Plan #2 P1-003: render any `{{var}}` substitutions BEFORE hashing so the manifest entry
    // hash matches the byte-stream that lands on disk.
    //
    // Through `renderAssetFile` rather than `renderTemplate` directly: it is the ONE render
    // step, shared with `massu show-template`, so the bytes that command prints are the bytes
    // this loop writes. They used to be derived separately and were not the same — see the
    // header of `asset-render.ts`.
    //
    // Engine errors (missing var, malformed token) fail this single file but never abort the
    // whole install — see spec §"Error semantics". An unreadable source is the same class: it
    // is reported, counted, and skipped, never silently treated as empty.
    const rendered = renderAssetFile(resolvedSourcePath, sourceFilename, {
      vars: templateVars,
      resolveFragment,
    });
    if (rendered.kind !== 'ok') {
      if (rendered.kind === 'error') {
        process.stderr.write(`massu: skipping ${rendered.sourcePath}: ${rendered.message}\n`);
        stats.skipped++;
      }
      continue;
    }
    const sourceContent = rendered.content;
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
  // P4.3b — ONE render context for the whole install: one variable scope, one fragment
  // resolver and one stats object, so the counts the acceptance asserts
  // (`fragmentsMissing === 0`) cover every asset rather than one directory. Built by the
  // same factory `massu show-template` uses, so neither can drift from the other.
  const ctx: RenderContext = makeRenderContext(framework);
  const { vars: templateVars, resolveFragment, fragments: fragmentStats } = ctx;
  const stats = runWithManifest(claudeDir, (manifest) => {
    const syncStats = syncDirectory(
      sourceDir,
      targetDir,
      framework,
      manifest,
      'commands',
      true,
      templateVars,
      resolveFragment,
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
  /**
   * P4.3b — `{{> name}}` resolution counts across the WHOLE install.
   *
   * REPORTED, not merely tallied: `missing` is the number the acceptance asserts at zero,
   * and a fragment that silently defaulted on every stack is a fragment nobody varied. A
   * count nobody reads is the blind-gate shape (M1).
   */
  fragments: FragmentStats;
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
  // P4.3b — ONE render context for the whole install: one variable scope, one fragment
  // resolver and one stats object, so the counts the acceptance asserts
  // (`fragmentsMissing === 0`) cover every asset rather than one directory. Built by the
  // same factory `massu show-template` uses, so neither can drift from the other.
  const ctx: RenderContext = makeRenderContext(framework);
  const { vars: templateVars, resolveFragment, fragments: fragmentStats } = ctx;

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
        resolveFragment,
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
    fragments: fragmentStats,
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
