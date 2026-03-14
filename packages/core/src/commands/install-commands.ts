// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu install-commands` — Install massu slash commands into a project.
 *
 * Copies all massu command .md files from the package's commands/ directory
 * into the project's .claude/commands/ directory. Existing massu commands
 * are updated; non-massu commands are preserved.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from '../config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Command Installation
// ============================================================

/**
 * Resolve the path to the bundled commands directory.
 * Handles both npm-installed and local development scenarios.
 */
export function resolveCommandsDir(): string | null {
  const cwd = process.cwd();

  // 1. npm-installed: node_modules/@massu/core/commands
  const nodeModulesPath = resolve(cwd, 'node_modules/@massu/core/commands');
  if (existsSync(nodeModulesPath)) {
    return nodeModulesPath;
  }

  // 2. Relative to compiled dist/cli.js → ../commands
  const distRelPath = resolve(__dirname, '../commands');
  if (existsSync(distRelPath)) {
    return distRelPath;
  }

  // 3. Relative to source src/commands/ → ../../commands
  const srcRelPath = resolve(__dirname, '../../commands');
  if (existsSync(srcRelPath)) {
    return srcRelPath;
  }

  return null;
}

export interface InstallCommandsResult {
  installed: number;
  updated: number;
  skipped: number;
  commandsDir: string;
}

export function installCommands(projectRoot: string): InstallCommandsResult {
  const claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  const targetDir = resolve(projectRoot, claudeDirName, 'commands');

  // Ensure .claude/commands directory exists
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Find source commands
  const sourceDir = resolveCommandsDir();
  if (!sourceDir) {
    console.error('  ERROR: Could not find massu commands directory.');
    console.error('  Try reinstalling: npm install @massu/core');
    return { installed: 0, updated: 0, skipped: 0, commandsDir: targetDir };
  }

  // Read all command files from source
  const sourceFiles = readdirSync(sourceDir).filter(f => f.endsWith('.md'));

  let installed = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of sourceFiles) {
    const sourcePath = resolve(sourceDir, file);
    const targetPath = resolve(targetDir, file);
    const sourceContent = readFileSync(sourcePath, 'utf-8');

    if (existsSync(targetPath)) {
      const existingContent = readFileSync(targetPath, 'utf-8');
      if (existingContent === sourceContent) {
        skipped++;
        continue;
      }
      // Update existing command
      writeFileSync(targetPath, sourceContent, 'utf-8');
      updated++;
    } else {
      // Install new command
      writeFileSync(targetPath, sourceContent, 'utf-8');
      installed++;
    }
  }

  return { installed, updated, skipped, commandsDir: targetDir };
}

// ============================================================
// Standalone CLI Runner
// ============================================================

export async function runInstallCommands(): Promise<void> {
  const projectRoot = process.cwd();

  console.log('');
  console.log('Massu AI - Install Slash Commands');
  console.log('==================================');
  console.log('');

  const result = installCommands(projectRoot);

  if (result.installed > 0) {
    console.log(`  Installed ${result.installed} new commands`);
  }
  if (result.updated > 0) {
    console.log(`  Updated ${result.updated} existing commands`);
  }
  if (result.skipped > 0) {
    console.log(`  ${result.skipped} commands already up to date`);
  }

  const total = result.installed + result.updated + result.skipped;
  console.log('');
  console.log(`  ${total} slash commands available in ${result.commandsDir}`);
  console.log('');
  console.log('  Restart your Claude Code session to use them.');
  console.log('');
}
