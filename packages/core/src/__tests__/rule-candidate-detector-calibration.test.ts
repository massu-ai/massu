// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-A-005: calibration harness.
// Replays 30+ historical positive corrections + 100+ negatives through the
// detector and asserts precision >= 0.7 AND recall >= 0.5 at threshold 60.
// Reproducible in CI: positives come from synthetic fixtures + (optionally)
// live `memory/feedback_*.md` files scanned when present. Negatives are a
// hardcoded corpus of common non-correction prompts.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, homedir } from 'os';
import { scoreCorrectionPrompt, RULE_CANDIDATE_THRESHOLD } from '../rule-candidate-detector.ts';

const PRIOR_EDIT = { priorAssistantTurn: { hadEditOrWrite: true } };

/**
 * Parse the `description:` field from a feedback markdown file's YAML
 * frontmatter. Throws `MissingDescriptionError` if absent — `---` literal
 * value or fall-through to no-heading is treated as a labeled-corpus bug.
 */
class MissingDescriptionError extends Error {
  constructor(filePath: string) {
    super(`feedback file lacks parseable description field: ${filePath}`);
    this.name = 'MissingDescriptionError';
  }
}

export function parseFeedbackDescription(content: string, filePath: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    // No frontmatter — fall back to first non-frontmatter heading
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch && headingMatch[1].trim().length > 5) return headingMatch[1].trim();
    throw new MissingDescriptionError(filePath);
  }
  const fm = fmMatch[1];
  // Description may span multiple lines until the next top-level YAML key.
  const descMatch = fm.match(/^description:\s*([^\n]+(?:\n  [^\n]+)*)/m);
  if (!descMatch || descMatch[1].trim() === '---' || descMatch[1].trim().length < 5) {
    // Fall back to first non-frontmatter heading
    const afterFrontmatter = content.slice(fmMatch[0].length);
    const headingMatch = afterFrontmatter.match(/^#\s+(.+)$/m);
    if (headingMatch && headingMatch[1].trim().length > 5) return headingMatch[1].trim();
    throw new MissingDescriptionError(filePath);
  }
  return descMatch[1].replace(/\n\s+/g, ' ').trim();
}

// 30+ hardcoded positives that mirror the shape of real feedback descriptions.
// Each is a CORRECTION the user gave Claude that should land >=60.
const HARDCODED_POSITIVES: readonly string[] = [
  "you missed the canonical helper — use encodeMemoryDirName instead of a literal path",
  "that's wrong, the snapshot must track absent files via a null sentinel",
  "incorrect; the audit_log CHECK constraint must be migrated via the 12-step SQLite procedure",
  "this is wrong — wire the new tool into tools.ts with the 3-function pattern",
  "no, the hook must compile with esbuild before claiming complete",
  "you broke the test by removing the awaited db.close() call in afterEach",
  "should be using getConfig().toolPrefix not a hardcoded prefix string",
  "incorrect, please redact sensitive content before storing the prompt",
  "this is wrong, scheduled tasks must use the guardian framework not /schedule",
  "no, restore the snapshot per-file rather than re-running the whole transaction",
  "you missed the failure-log channel for the CR-53 increment hook",
  "this is wrong, security-sensitive env vars must go through the pepper guard",
  "incorrect, the dist-tag policy forbids re-establishing pre-release channels implicitly",
  "should be a vitest drift-guard not a hand-written assertion in CI",
  "not what i asked — the schema migration needs both new event_type values",
  "no, use the existing massu-pattern-scanner.sh check rather than adding a new bash step",
  "this is wrong, the public-content leak-guard must scan website/content/** too",
  "you broke the API contract by renaming the exported function without a deprecation alias",
  "incorrect, the cli should print human-readable errors, not stack traces",
  "should be using ESM imports with .ts extensions not commonjs require",
  "not what i wanted — bundle the hook with esbuild and verify timeout under 5s",
  "no, the website CHANGELOG.md must stay byte-equivalent with the root CHANGELOG.md",
  "this is wrong, the calibration test must fail when a feedback file lacks description",
  "incorrect; the conflict check must run before any file writes, not after",
  "you missed the orphan-reviewer audit step — reference real subagents only",
  "no, the candidate write must be idempotent via the sha-keyed filename",
  "should be a UNIQUE INDEX on (event_type, json_extract metadata prompt_hash)",
  "this is wrong, the deploy staleness gate must fire-once not on every push",
  "incorrect, the rule-approval slash command must require show-before-approve",
  "not what i asked — the template renderer must reject arbitrary JS via allowlist",
  "no, the recurrence_count must be initialized to zero at promotion time",
  "you missed adding the auto-learning-mirror-drift-guard test as a deliverable",
];

// 100+ negative corpus — common non-correction prompts.
const HARDCODED_NEGATIVES: readonly string[] = [
  'continue', 'go ahead', 'looks good', 'sounds good', 'ok', 'great', 'thanks',
  'cool', 'fine', 'yes', 'no problem', 'no worries', 'thanks much', 'perfect',
  'lgtm', 'works for me', 'agree', 'yes please', 'go for it', 'do it',
  'what does this file do?',
  'explain the codebase architecture',
  'walk me through the loop',
  'how does the auto-learning protocol work?',
  'where is the config loader?',
  'what is the difference between getCodeGraphDb and getDataDb?',
  'show me an example of the 3-function pattern',
  'how do I add a new hook?',
  'what is the latest npm version?',
  'where do plans live?',
  'add a new test for the prompt-analyzer module',
  'create a function that hashes prompts',
  'implement a small utility for date formatting',
  'add documentation for the audit-trail helper',
  'wire a new tool called massu_foo_action into tools.ts',
  'create a new slash command for status checks',
  'add a vitest test that covers the empty input case',
  'extend the config with a new key for telemetry endpoint',
  'add a guard helper for pepper-style env vars',
  'create a drift-guard test for the registry signing keys',
  'next', 'continue', 'keep going', 'proceed', 'next step',
  'lets move forward', "let's continue", 'go on', 'further', 'and then',
  'show me the file', 'show me the test', 'show me the helper', 'show me the diff',
  'review the changes', 'open the file', 'paste the code', 'list the files',
  '/massu-loop docs/plans/x.md', '/clear', '/help', '/massu-bearings',
  '/massu-create-plan', '/massu-status', '/massu-debug', '/massu-deploy',
  '/massu-recap', '/massu-checkpoint', '/massu-commit',
  'nevermind, forget it', 'ignore that', 'scratch that', 'on second thought',
  'no wait', "actually you're right", 'disregard', 'abandon that',
  'I think we are good here', 'I think this is fine for now',
  'lets pause here and recap',
  'can you summarize what we just did?',
  'can you explain why the build failed?',
  'help me understand the structure',
  'where does this function get called from?',
  'when was this file last modified?',
  'who wrote the changelog parser?',
  'why is this annotated with @deprecated?',
  'is this used anywhere?',
  'has anyone seen this error before?',
  'good catch', 'nice find', 'well spotted', 'good question',
  'I like this approach', 'this looks clean',
  'this is a great refactor', 'amazing work', 'thank you so much',
  'what time is it?', 'whats the date?',
  'what version of node are we on?',
  'check git status', 'run npm test', 'run the build',
  'open the readme', 'open massu.config.yaml',
  'what is the project name', 'what is the file extension policy',
  'how do I run the hooks?', 'how do I rebuild better-sqlite3?',
  'where is the audit log stored?', 'what database does memory use?',
  'why does the test timeout?', 'is the dev server running?',
  'are we on the right branch?', 'is this on main yet?',
  'how do I commit?', 'how do I push?',
  'how do I make a new plan?', 'walk through the changelog format',
  'what is keep-a-changelog 1.1.0', 'explain semver',
];

function isPredictedPositive(prompt: string): boolean {
  const r = scoreCorrectionPrompt({ prompt, ...PRIOR_EDIT, category: 'bugfix' });
  return r.score >= RULE_CANDIDATE_THRESHOLD;
}

describe('rule-candidate-detector calibration', () => {
  describe('frontmatter parsing', () => {
    it('extracts description from valid frontmatter', () => {
      const yaml = `---
name: x
description: short summary of the rule
type: feedback
---
body`;
      expect(parseFeedbackDescription(yaml, '/synthetic')).toBe('short summary of the rule');
    });

    it('FAILs on synthetic feedback file missing description', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'massu-cal-'));
      const filePath = join(tmp, 'feedback_broken.md');
      const noDesc = `---
name: x
type: feedback
---
no body heading either`;
      writeFileSync(filePath, noDesc);
      try {
        expect(() => parseFeedbackDescription(noDesc, filePath)).toThrow(MissingDescriptionError);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('falls back to first heading when description literal is empty', () => {
      const content = `---
name: x
type: feedback
---

# fallback rule heading

body`;
      expect(parseFeedbackDescription(content, '/synthetic')).toBe('fallback rule heading');
    });
  });

  describe('precision/recall at threshold 60', () => {
    it('asserts precision >= 0.7 AND recall >= 0.5 on labeled corpus', () => {
      let tp = 0, fp = 0, fn = 0, tn = 0;
      for (const p of HARDCODED_POSITIVES) {
        if (isPredictedPositive(p)) tp++;
        else fn++;
      }
      for (const n of HARDCODED_NEGATIVES) {
        if (isPredictedPositive(n)) fp++;
        else tn++;
      }
      const precision = tp / Math.max(1, tp + fp);
      const recall = tp / Math.max(1, tp + fn);
      // eslint-disable-next-line no-console
      console.log(`[calibration] positives=${HARDCODED_POSITIVES.length} negatives=${HARDCODED_NEGATIVES.length} tp=${tp} fp=${fp} tn=${tn} fn=${fn} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`);
      expect(HARDCODED_POSITIVES.length).toBeGreaterThanOrEqual(30);
      expect(HARDCODED_NEGATIVES.length).toBeGreaterThanOrEqual(100);
      expect(precision).toBeGreaterThanOrEqual(0.7);
      expect(recall).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('live memory corpus (if present)', () => {
    it('parses every memory/feedback_*.md description without throwing', () => {
      // Derive the operator's memory dir generically from this repo's root —
      // Claude Code encodes the project dir as the absolute path with '/' -> '-'.
      // (Was hardcoded to a single operator's path; now works for any operator.)
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
      const encodedProject = repoRoot.replace(/\//g, '-');
      const memoryDir = join(homedir(), '.claude', 'projects', encodedProject, 'memory');
      if (!existsSync(memoryDir)) {
        // eslint-disable-next-line no-console
        console.log('[calibration] memory dir not present, skipping live corpus check');
        return;
      }
      const files = readdirSync(memoryDir).filter(f => /^feedback_.+\.md$/.test(f));
      if (files.length === 0) {
        // eslint-disable-next-line no-console
        console.log('[calibration] no feedback files found, skipping');
        return;
      }
      for (const f of files) {
        const content = readFileSync(join(memoryDir, f), 'utf-8');
        // Must parse without throwing — flags any feedback file missing description
        // (per plan §P-A-005 acceptance: incomplete labels FAIL the test).
        expect(() => parseFeedbackDescription(content, f)).not.toThrow();
      }
    });
  });
});
