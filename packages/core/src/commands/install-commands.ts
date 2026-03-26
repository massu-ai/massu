// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu install-commands` — Install massu slash commands, agents, patterns,
 * protocols, and reference files into a project.
 *
 * Copies all massu assets from the npm package into the project's .claude/
 * directory. Existing massu files are updated; non-massu files are preserved.
 * Handles subdirectories recursively (e.g., golden-path/references/).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative, join } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../config.ts';

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
// Recursive File Sync
// ============================================================

interface SyncStats {
  installed: number;
  updated: number;
  skipped: number;
}

/**
 * Recursively sync all .md files from sourceDir to targetDir.
 * Creates subdirectories as needed. Preserves non-massu files.
 */
function syncDirectory(sourceDir: string, targetDir: string): SyncStats {
  const stats: SyncStats = { installed: 0, updated: 0, skipped: 0 };

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const entries = readdirSync(sourceDir);

  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry);
    const targetPath = resolve(targetDir, entry);
    const entryStat = statSync(sourcePath);

    if (entryStat.isDirectory()) {
      // Recurse into subdirectories
      const subStats = syncDirectory(sourcePath, targetPath);
      stats.installed += subStats.installed;
      stats.updated += subStats.updated;
      stats.skipped += subStats.skipped;
    } else if (entry.endsWith('.md')) {
      const sourceContent = readFileSync(sourcePath, 'utf-8');

      if (existsSync(targetPath)) {
        const existingContent = readFileSync(targetPath, 'utf-8');
        if (existingContent === sourceContent) {
          stats.skipped++;
          continue;
        }
        writeFileSync(targetPath, sourceContent, 'utf-8');
        stats.updated++;
      } else {
        writeFileSync(targetPath, sourceContent, 'utf-8');
        stats.installed++;
      }
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
  commandsDir: string;
}

export function installCommands(projectRoot: string): InstallCommandsResult {
  const claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  const targetDir = resolve(projectRoot, claudeDirName, 'commands');

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const sourceDir = resolveAssetDir('commands');
  if (!sourceDir) {
    console.error('  ERROR: Could not find massu commands directory.');
    console.error('  Try reinstalling: npm install @massu/core');
    return { installed: 0, updated: 0, skipped: 0, commandsDir: targetDir };
  }

  const stats = syncDirectory(sourceDir, targetDir);
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
  claudeDir: string;
}

export function installAll(projectRoot: string): InstallAllResult {
  const claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  const claudeDir = resolve(projectRoot, claudeDirName);

  const assets: Record<string, SyncStats> = {};
  let totalInstalled = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const assetType of ASSET_TYPES) {
    const sourceDir = resolveAssetDir(assetType.name);
    if (!sourceDir) {
      continue;
    }

    const targetDir = resolve(claudeDir, assetType.targetSubdir);
    const stats = syncDirectory(sourceDir, targetDir);

    assets[assetType.name] = stats;
    totalInstalled += stats.installed;
    totalUpdated += stats.updated;
    totalSkipped += stats.skipped;
  }

  return { assets, totalInstalled, totalUpdated, totalSkipped, claudeDir };
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
    const total = stats.installed + stats.updated + stats.skipped;
    if (total === 0) continue;

    const parts: string[] = [];
    if (stats.installed > 0) parts.push(`${stats.installed} new`);
    if (stats.updated > 0) parts.push(`${stats.updated} updated`);
    if (stats.skipped > 0) parts.push(`${stats.skipped} current`);

    const description = assetType.description;
    console.log(`  ${description}: ${parts.join(', ')} (${total} total)`);
  }

  const grandTotal = result.totalInstalled + result.totalUpdated + result.totalSkipped;
  console.log('');
  console.log(`  ${grandTotal} total files synced to ${result.claudeDir}`);
  console.log('');
  console.log('  Restart your Claude Code session to use them.');
  console.log('');
}
