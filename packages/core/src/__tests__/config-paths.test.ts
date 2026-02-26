// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, join } from 'path';

/**
 * P4-010: Config-path audit test.
 *
 * Scans ALL .ts source files in packages/core/src/ for hardcoded '.claude/'
 * string literals that should instead use config-driven paths via
 * getConfig() / getResolvedPaths().
 *
 * Allowed patterns (not flagged):
 * - Lines using getConfig() or getResolvedPaths() (config-driven)
 * - Lines with ?? '.claude or .default('.claude (Zod/config default value patterns)
 * - Lines referencing claudeDirName (config variable)
 * - Lines with DEFAULT (SQL default values)
 * - Comment lines (starting with // or *)
 * - Import statements
 * - Global home directory references (homedir())
 * - Human-readable error/status messages (detail:, message:)
 * - Test files (__tests__/)
 */

const SRC_DIR = resolve(__dirname, '..');

/** Recursively collect all .ts files under a directory, excluding __tests__/ and hooks/. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test directories and hooks (hooks are compiled scripts, not library code)
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...collectTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Check if a line is an allowed usage of '.claude/' */
function isAllowedUsage(line: string): boolean {
  const trimmed = line.trim();

  // Comment lines
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('*')) return true;

  // Config-driven usage
  if (trimmed.includes('getConfig()') || trimmed.includes('getConfig(')) return true;
  if (trimmed.includes('getResolvedPaths()') || trimmed.includes('getResolvedPaths(')) return true;

  // Default value pattern (e.g., ?? '.claude/...' or .default('.claude/...'))
  if (trimmed.includes("?? '.claude") || trimmed.includes('?? ".claude')) return true;
  if (trimmed.includes(".default('.claude") || trimmed.includes('.default(".claude')) return true;

  // Config variable reference
  if (trimmed.includes('claudeDirName')) return true;

  // SQL DEFAULT
  if (trimmed.includes('DEFAULT')) return true;

  // Import statements (referencing config module)
  if (trimmed.startsWith('import ')) return true;

  // Global Claude home directory (e.g., ~/.claude/projects/) — not project-local
  if (trimmed.includes('homedir()')) return true;

  // Human-readable error/status messages (not used as file paths)
  if (trimmed.includes('detail:') || trimmed.includes('message:')) return true;

  return false;
}

describe('P4-010: Config Path Audit', () => {
  it('no hardcoded .claude/ paths outside config-driven patterns', () => {
    const tsFiles = collectTsFiles(SRC_DIR);
    expect(tsFiles.length).toBeGreaterThan(0);

    const violations: { file: string; line: number; content: string }[] = [];

    for (const filePath of tsFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Look for string literals containing .claude/
        if (line.includes("'.claude/") || line.includes('".claude/') || line.includes('`.claude/')) {
          if (!isAllowedUsage(line)) {
            const relativePath = filePath.replace(SRC_DIR + '/', '');
            violations.push({
              file: relativePath,
              line: i + 1,
              content: line.trim(),
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} => ${v.content}`)
        .join('\n');
      expect.fail(
        `Found ${violations.length} hardcoded .claude/ path(s) that should use config:\n${report}\n\n` +
          'Use getConfig().conventions?.claudeDirName or getResolvedPaths() instead.',
      );
    }
  });

  it('scans a meaningful number of source files', () => {
    const tsFiles = collectTsFiles(SRC_DIR);
    // We expect at least 30 .ts source files in packages/core/src/
    expect(tsFiles.length).toBeGreaterThanOrEqual(30);
  });
});
