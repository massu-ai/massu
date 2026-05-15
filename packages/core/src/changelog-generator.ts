// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Release-boundary CHANGELOG entry generator. Reads `git log <last-tag>..HEAD`
 * commit subjects, groups by `(plan-<token>)` paren-notation prefix, looks up
 * the matching `docs/plans/*.md` files for their `## Changelog Summary` section,
 * and emits a Keep-a-Changelog 1.1.0-compliant entry.
 *
 * Plan-token regex mirrors `scripts/lib/plan-token-regex.sh` (SSOT). See
 * plan-1.9.0-plan-token-aware-changelog-batcher Phase B.
 *
 * Pure functions only — caller threads in commit subjects + plan directory.
 * No git invocations inside this module (those live in commands/changelog.ts).
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Plan-token regex (TS shim of scripts/lib/plan-token-regex.sh PLAN_TOKEN_REGEX).
 * Matches subject prefix `<type>(plan-<token>):` where <type> ∈ {feat, fix, chore, docs}.
 * Captures: group 1 = type, group 2 = full plan-<token>.
 */
const PLAN_TOKEN_RE = /^(feat|fix|chore|docs)\((plan-[a-z0-9._-]+)\)/;

export class MissingPlanFileError extends Error {
  constructor(token: string) {
    super(`No plan file found in plans directory matching Plan Token: ${token}`);
    this.name = 'MissingPlanFileError';
  }
}

export class MissingChangelogSummaryError extends Error {
  constructor(token: string, planFile: string) {
    super(`Plan file ${planFile} for token ${token} has no '## Changelog Summary' section`);
    this.name = 'MissingChangelogSummaryError';
  }
}

export interface PlanSummary {
  title: string;
  summary: string;
}

export interface ParseResult {
  tokens: Set<string>;
  maintenance: string[];
}

/**
 * Parse commit subject lines into:
 *   - `tokens`: Set of unique `plan-<token>` strings (with `plan-` prefix)
 *   - `maintenance`: subjects that DID NOT match the paren-notation pattern
 */
export function parseCommitsForPlanTokens(subjects: readonly string[]): ParseResult {
  const tokens = new Set<string>();
  const maintenance: string[] = [];
  for (const subject of subjects) {
    const m = subject.match(PLAN_TOKEN_RE);
    if (m && m[2]) {
      tokens.add(m[2]);
    } else {
      maintenance.push(subject);
    }
  }
  return { tokens, maintenance };
}

/**
 * For each plan-token, find the corresponding `docs/plans/*.md` file and
 * extract its title (first `# Plan: ...` heading) and `## Changelog Summary`
 * section body. Throws on missing file or missing section.
 */
export function loadPlanSummaries(
  tokens: ReadonlySet<string>,
  planDir: string,
): Map<string, PlanSummary> {
  const result = new Map<string, PlanSummary>();
  if (tokens.size === 0) return result;

  if (!existsSync(planDir)) {
    throw new Error(`Plan directory does not exist: ${planDir}`);
  }
  const files = readdirSync(planDir).filter((f) => f.endsWith('.md'));

  for (const token of tokens) {
    let matchedFile: string | null = null;
    let content = '';
    for (const file of files) {
      const path = resolve(planDir, file);
      const text = readFileSync(path, 'utf-8');
      // Match `**Plan Token**: `plan-<token>`` allowing optional surrounding text.
      const tokenRe = new RegExp(
        `^\\*\\*Plan Token\\*\\*:\\s*\`?${token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\`?(\\s|$)`,
        'm',
      );
      if (tokenRe.test(text)) {
        matchedFile = file;
        content = text;
        break;
      }
    }
    if (!matchedFile) {
      throw new MissingPlanFileError(token);
    }

    // Extract title: first line starting with `# ` (after the metadata block).
    const titleMatch = content.match(/^# (.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : token;

    // Extract `## Changelog Summary` section body.
    const sectionRe = /^## Changelog Summary\s*\n([\s\S]*?)(?=\n## |\n---|\n# |$)/m;
    const sectionMatch = content.match(sectionRe);
    if (!sectionMatch || !sectionMatch[1].trim()) {
      throw new MissingChangelogSummaryError(token, matchedFile);
    }
    const summary = sectionMatch[1].trim();
    result.set(token, { title, summary });
  }

  return result;
}

export interface GenerateOptions {
  version: string;
  date: string;
  planSummaries: ReadonlyMap<string, PlanSummary>;
  maintenance: readonly string[];
}

/**
 * Emit a CHANGELOG.md entry in Keep-a-Changelog 1.1.0 format. Each plan-token
 * becomes one paragraph (or `### Added` subsection if the plan summary itself
 * uses Keep-a-Changelog subsections). Maintenance commits go under a
 * `### Maintenance` subsection at the end.
 */
export function generateChangelogEntry(opts: GenerateOptions): string {
  const parts: string[] = [];
  parts.push(`## [${opts.version}] - ${opts.date}\n`);
  parts.push('');

  // Plan summaries, in iteration order
  for (const [, planSum] of opts.planSummaries) {
    parts.push(planSum.summary);
    parts.push('');
  }

  // Maintenance fallback
  if (opts.maintenance.length > 0) {
    parts.push('### Maintenance');
    parts.push('');
    for (const subject of opts.maintenance) {
      parts.push(`- ${subject}`);
    }
    parts.push('');
  }

  return parts.join('\n') + '\n';
}

/**
 * Given a CHANGELOG.md entry body and a set of plan-tokens that should be
 * referenced, return the subset of tokens NOT mentioned in the body.
 * Used by `permissions check-drift` verification + pre-tag gate.
 */
export function findCoverageGaps(
  entryText: string,
  tokens: ReadonlySet<string>,
): string[] {
  const gaps: string[] = [];
  for (const token of tokens) {
    if (!entryText.includes(token)) {
      gaps.push(token);
    }
  }
  return gaps;
}
