// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu changelog <subcommand>` — CHANGELOG generation + verification CLI.
 *
 * Subcommands:
 *   generate   Emit a draft CHANGELOG.md entry to stdout for commits since the
 *              last tag. Operator pipes/copies into CHANGELOG.md.
 *   verify     Read current CHANGELOG.md latest entry; verify every plan-token
 *              in `git log <last-tag>..HEAD` subjects is referenced. Exit 0 if
 *              clean, exit 1 with one `gap: <token>` per missing.
 *
 * Plan ref: plan-1.9.0-plan-token-aware-changelog-batcher Phase C.
 * Mirrors the `permissions <sub>` cluster precedent shipped in 1.8.0.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  parseCommitsForPlanTokens,
  loadPlanSummaries,
  generateChangelogEntry,
  findCoverageGaps,
  MissingPlanFileError,
  MissingChangelogSummaryError,
} from '../changelog-generator.ts';

function resolveRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

function getLastTag(): string | null {
  try {
    return execSync('git describe --tags --abbrev=0', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function getCommitSubjects(range: string): string[] {
  try {
    const out = execSync(`git log ${range} --pretty=format:%s`, { encoding: 'utf-8' });
    return out.split('\n').filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

function getCurrentVersion(repoRoot: string): string {
  const pkgPath = resolve(repoRoot, 'packages/core/package.json');
  if (!existsSync(pkgPath)) return '0.0.0';
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version || '0.0.0';
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function getLatestChangelogEntryBody(repoRoot: string): string {
  const path = resolve(repoRoot, 'CHANGELOG.md');
  if (!existsSync(path)) return '';
  const content = readFileSync(path, 'utf-8');
  // Find first `## [...]` heading and capture until next or EOF
  const m = content.match(/^## \[[\d.]+\][^\n]*\n([\s\S]*?)(?=\n## \[|$)/m);
  return m ? m[1] : '';
}

export async function handleChangelogSubcommand(
  args: string[],
): Promise<{ exitCode: number }> {
  const sub = args[0];
  const repoRoot = resolveRepoRoot();
  const planDir = resolve(repoRoot, 'docs/plans');

  switch (sub) {
    case 'generate': {
      const lastTag = getLastTag();
      const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
      const subjects = getCommitSubjects(range);
      const { tokens, maintenance } = parseCommitsForPlanTokens(subjects);

      let planSummaries;
      try {
        planSummaries = loadPlanSummaries(tokens, planDir);
      } catch (err) {
        if (err instanceof MissingPlanFileError || err instanceof MissingChangelogSummaryError) {
          process.stderr.write(`changelog generate: ${err.message}\n`);
          return { exitCode: 2 };
        }
        throw err;
      }

      const entry = generateChangelogEntry({
        version: getCurrentVersion(repoRoot),
        date: todayDate(),
        planSummaries,
        maintenance,
      });
      process.stdout.write(entry);
      return { exitCode: 0 };
    }

    case 'verify': {
      const lastTag = getLastTag();
      const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
      const subjects = getCommitSubjects(range);
      const { tokens } = parseCommitsForPlanTokens(subjects);

      const entryBody = getLatestChangelogEntryBody(repoRoot);
      const gaps = findCoverageGaps(entryBody, tokens);

      if (gaps.length === 0) {
        process.stdout.write('All plan-tokens referenced.\n');
        return { exitCode: 0 };
      }
      for (const t of gaps) {
        process.stderr.write(`gap: ${t}\n`);
      }
      return { exitCode: 1 };
    }

    case '--help':
    case '-h':
    case undefined: {
      printChangelogHelp();
      return { exitCode: 0 };
    }

    default: {
      process.stderr.write(`massu: unknown changelog subcommand: ${sub}\n`);
      printChangelogHelp();
      return { exitCode: 1 };
    }
  }
}

export function printChangelogHelp(): void {
  process.stdout.write(`
massu changelog <subcommand>

Subcommands:
  generate    Emit a draft CHANGELOG.md entry to stdout. Reads commit subjects
              since the last git tag, groups by (plan-<token>) paren-notation,
              looks up each plan file's ## Changelog Summary section, and emits
              a Keep-a-Changelog 1.1.0 entry. Operator pipes/copies into
              CHANGELOG.md (no forced overwrite).

  verify      Read-only check that the latest CHANGELOG.md entry references
              every plan-token in commits since the last tag. Exit 0 if clean,
              exit 1 with one 'gap: <token>' per missing.

Examples:
  npx massu changelog generate > /tmp/draft-entry.md
  npx massu changelog verify

Documentation: https://massu.ai/docs/reference/cli-reference#massu-changelog
`);
}
