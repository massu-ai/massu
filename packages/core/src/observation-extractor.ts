// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import type { ParsedToolCall, TranscriptEntry, ExtractedDecision, ExtractedFailedAttempt } from './transcript-parser.ts';
import {
  extractToolCalls,
  extractDecisions,
  extractFailedAttempts,
  extractFileOperations,
  extractVerificationCommands,
  extractUserMessages,
  estimateTokens,
} from './transcript-parser.ts';
import type { AddObservationOpts } from './memory-db.ts';
import { assignImportance } from './memory-db.ts';
import { detectDecisionPatterns } from './adr-generator.ts';
import { getProjectRoot, getConfig, getResolvedPaths } from './config.ts';
import { homedir } from 'os';

// ============================================================
// P2-002: Observation Extractor
// ============================================================

/**
 * Visibility classification for observations.
 * - 'public': Safe to share across teams and sync to cloud (no secrets, no absolute paths)
 * - 'private': Contains potentially sensitive data (file paths, env vars, credentials)
 */
export type ObservationVisibility = 'public' | 'private';

/**
 * A structured observation ready for DB insertion.
 */
export interface ExtractedObservation {
  type: string;
  title: string;
  detail: string | null;
  visibility: ObservationVisibility;
  opts: AddObservationOpts;
}

/**
 * Patterns that indicate private/sensitive content.
 * If any of these match the observation title or detail, it is classified as 'private'.
 */
const PRIVATE_PATTERNS = [
  /\/Users\/\w+/,              // Absolute macOS paths
  /\/home\/\w+/,               // Absolute Linux paths
  /[A-Z]:\\/,                  // Windows paths
  /\b(api[_-]?key|secret|token|password|credential|dsn)\b/i,  // Secrets
  /\b(STRIPE_|SUPABASE_|SENTRY_|AWS_|DATABASE_URL)\b/,        // Env var names
  /\.(env|pem|key|cert)\b/,   // Sensitive file extensions
  /Bearer\s+\S+/,             // Auth tokens
  /sk_live_|sk_test_|whsec_/, // Stripe keys
];

/**
 * Classify whether an observation is safe for public sharing or should remain private.
 */
export function classifyVisibility(title: string, detail: string | null): ObservationVisibility {
  const text = `${title} ${detail ?? ''}`;
  for (const pattern of PRIVATE_PATTERNS) {
    if (pattern.test(text)) return 'private';
  }
  return 'public';
}

/**
 * Noise filtering rules - these tool calls add no memory value.
 */
export function isNoisyToolCall(tc: ParsedToolCall, seenReads: Set<string>): boolean {
  // Glob/Grep tool calls (search operations, not actions)
  if (tc.toolName === 'Glob' || tc.toolName === 'Grep') return true;

  // Duplicate Read calls to the same file within same session
  if (tc.toolName === 'Read') {
    const filePath = tc.input.file_path as string ?? '';
    if (seenReads.has(filePath)) return true;
    seenReads.add(filePath);

    // Read of node_modules files
    if (filePath.includes('node_modules')) return true;
  }

  // Bash with trivial commands
  if (tc.toolName === 'Bash') {
    const cmd = (tc.input.command as string ?? '').trim();
    const trivialPatterns = /^(ls|pwd|echo|cat\s|head\s|tail\s|wc\s)/;
    if (trivialPatterns.test(cmd)) return true;
  }

  // Empty or error-only tool responses
  if (!tc.result || tc.result.trim() === '') return true;

  return false;
}

/**
 * Extract all observations from transcript entries.
 * This is the main entry point for both real-time (P3-002) and backfill (P6-001).
 */
export function extractObservationsFromEntries(entries: TranscriptEntry[]): ExtractedObservation[] {
  const observations: ExtractedObservation[] = [];
  const seenReads = new Set<string>();

  // 1. Extract from tool calls
  const toolCalls = extractToolCalls(entries);
  for (const tc of toolCalls) {
    if (isNoisyToolCall(tc, seenReads)) continue;
    const obs = classifyToolCall(tc);
    if (obs) observations.push(obs);
  }

  // 2. Extract decisions from assistant text
  const decisions = extractDecisions(entries);
  for (const decision of decisions) {
    const title = decision.text.slice(0, 200);
    const detail = decision.context;
    observations.push({
      type: 'decision',
      title,
      detail,
      visibility: classifyVisibility(title, detail),
      opts: {
        importance: assignImportance('decision'),
        originalTokens: estimateTokens(decision.text + decision.context),
      },
    });
  }

  // 3. Extract failed attempts from assistant text
  const failures = extractFailedAttempts(entries);
  for (const failure of failures) {
    const title = failure.text.slice(0, 200);
    const detail = failure.context;
    observations.push({
      type: 'failed_attempt',
      title,
      detail,
      visibility: classifyVisibility(title, detail),
      opts: {
        importance: assignImportance('failed_attempt'),
        originalTokens: estimateTokens(failure.text + failure.context),
      },
    });
  }

  // 4. Extract verification commands
  const verifications = extractVerificationCommands(toolCalls);
  for (const vr of verifications) {
    const title = `${vr.vrType}: ${vr.passed ? 'PASS' : 'FAIL'}`;
    const detail = vr.command;
    observations.push({
      type: 'vr_check',
      title,
      detail,
      visibility: classifyVisibility(title, detail),
      opts: {
        vrType: vr.vrType,
        evidence: vr.result,
        importance: assignImportance('vr_check', vr.passed ? 'PASS' : 'FAIL'),
        originalTokens: estimateTokens(vr.result),
      },
    });
  }

  return observations;
}

/**
 * Classify a single tool call into an observation (or null if not observation-worthy).
 */
function classifyToolCall(tc: ParsedToolCall): ExtractedObservation | null {
  const result = tc.result ?? '';

  switch (tc.toolName) {
    case 'Write': {
      const filePath = tc.input.file_path as string ?? 'unknown';
      const title = `Created/wrote: ${shortenPath(filePath)}`;
      return {
        type: 'file_change',
        title,
        detail: null,
        visibility: classifyVisibility(title, filePath),
        opts: {
          filesInvolved: [filePath],
          importance: assignImportance('file_change'),
          originalTokens: estimateTokens(result),
          ...extractLinkedReferences(result + filePath),
        },
      };
    }

    case 'Edit': {
      const filePath = tc.input.file_path as string ?? 'unknown';
      const title = `Edited: ${shortenPath(filePath)}`;
      return {
        type: 'file_change',
        title,
        detail: null,
        visibility: classifyVisibility(title, filePath),
        opts: {
          filesInvolved: [filePath],
          importance: assignImportance('file_change'),
          originalTokens: estimateTokens(result),
          ...extractLinkedReferences(result + filePath),
        },
      };
    }

    case 'Read': {
      const filePath = tc.input.file_path as string ?? 'unknown';
      // Only keep reads of interesting files (plan files, knowledge source files, etc.)
      const knowledgeSourceFiles = getConfig().conventions?.knowledgeSourceFiles ?? ['CLAUDE.md', 'MEMORY.md', 'corrections.md'];
      const plansDir = getResolvedPaths().plansDir;
      if (filePath.includes(plansDir) || knowledgeSourceFiles.some(f => filePath.includes(f))) {
        const title = `Read: ${shortenPath(filePath)}`;
        return {
          type: 'discovery',
          title,
          detail: null,
          visibility: classifyVisibility(title, filePath),
          opts: {
            filesInvolved: [filePath],
            importance: assignImportance('discovery'),
            originalTokens: estimateTokens(result),
          },
        };
      }
      return null;
    }

    case 'Bash': {
      const cmd = (tc.input.command as string ?? '').trim();

      // Git commit
      if (cmd.includes('git commit')) {
        const commitMsg = extractCommitMessage(cmd);
        const isfix = commitMsg.toLowerCase().includes('fix');
        const title = `Commit: ${commitMsg.slice(0, 150)}`;
        return {
          type: isfix ? 'bugfix' : 'feature',
          title,
          detail: cmd,
          visibility: classifyVisibility(title, cmd),
          opts: {
            importance: assignImportance(isfix ? 'bugfix' : 'feature'),
            originalTokens: estimateTokens(result),
          },
        };
      }

      // Pattern scanner
      if (cmd.includes('pattern-scanner')) {
        const passed = !result.includes('FAIL') && !result.includes('BLOCKED');
        const title = `Pattern Scanner: ${passed ? 'PASS' : 'FAIL'}`;
        const detail = result.slice(0, 500);
        return {
          type: 'pattern_compliance',
          title,
          detail,
          visibility: classifyVisibility(title, detail),
          opts: {
            evidence: result.slice(0, 500),
            importance: assignImportance('pattern_compliance', passed ? 'PASS' : 'FAIL'),
            originalTokens: estimateTokens(result),
          },
        };
      }

      // npm test / vitest
      if (cmd.includes('npm test') || cmd.includes('vitest')) {
        const passed = !tc.isError && !result.includes('FAIL');
        const title = `Tests: ${passed ? 'PASS' : 'FAIL'}`;
        return {
          type: 'vr_check',
          title,
          detail: cmd,
          visibility: classifyVisibility(title, cmd),
          opts: {
            vrType: 'VR-TEST',
            evidence: result.slice(0, 500),
            importance: assignImportance('vr_check', passed ? 'PASS' : 'FAIL'),
            originalTokens: estimateTokens(result),
          },
        };
      }

      // npm run build / tsc
      if (cmd.includes('npm run build') || cmd.includes('tsc --noEmit')) {
        const vrType = cmd.includes('tsc') ? 'VR-TYPE' : 'VR-BUILD';
        const passed = !tc.isError && !result.includes('error');
        const title = `${vrType}: ${passed ? 'PASS' : 'FAIL'}`;
        return {
          type: 'vr_check',
          title,
          detail: cmd,
          visibility: classifyVisibility(title, cmd),
          opts: {
            vrType,
            evidence: result.slice(0, 500),
            importance: assignImportance('vr_check', passed ? 'PASS' : 'FAIL'),
            originalTokens: estimateTokens(result),
          },
        };
      }

      return null;
    }

    default:
      return null;
  }
}

/**
 * Extract CR rule, VR type, and plan item references from text.
 */
function extractLinkedReferences(text: string): Partial<AddObservationOpts> {
  const result: Partial<AddObservationOpts> = {};

  const crMatch = text.match(/CR-(\d+)/);
  if (crMatch) result.crRule = `CR-${crMatch[1]}`;

  const vrMatch = text.match(/VR-([A-Z_]+)/);
  if (vrMatch) result.vrType = `VR-${vrMatch[1]}`;

  const planMatch = text.match(/P(\d+)-(\d+)/);
  if (planMatch) result.planItem = `P${planMatch[1]}-${planMatch[2]}`;

  return result;
}

/**
 * Extract commit message from a git commit command.
 */
function extractCommitMessage(cmd: string): string {
  // Match -m "message" or -m 'message'
  const match = cmd.match(/-m\s+["'](.+?)["']/);
  if (match) return match[1];

  // Match heredoc pattern
  const heredocMatch = cmd.match(/<<['"]?EOF['"]?\s*\n?([\s\S]*?)EOF/);
  if (heredocMatch) return heredocMatch[1].trim().split('\n')[0];

  return 'Unknown commit';
}

/**
 * Shorten a file path for display.
 */
function shortenPath(filePath: string): string {
  // Remove project root prefix, then common home dir prefix
  const root = getProjectRoot();
  if (filePath.startsWith(root + '/')) {
    return filePath.slice(root.length + 1);
  }
  const home = homedir();
  if (filePath.startsWith(home + '/')) {
    return '~/' + filePath.slice(home.length + 1);
  }
  return filePath;
}

/**
 * Classify a single tool call for real-time capture (used by PostToolUse hook P3-002).
 * Applies noise filtering.
 */
export function classifyRealTimeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: string,
  seenReads: Set<string>
): ExtractedObservation | null {
  const tc: ParsedToolCall = {
    toolName,
    toolUseId: '',
    input: toolInput,
    result: toolResponse,
    isError: false,
  };

  if (isNoisyToolCall(tc, seenReads)) return null;

  // P2-003: Detect architecture decision patterns in tool responses
  if (toolResponse && detectDecisionPatterns(toolResponse)) {
    const firstLine = toolResponse.split('\n')[0].slice(0, 200);
    const title = `Architecture decision: ${firstLine}`;
    const detail = toolResponse.slice(0, 1000);
    return {
      type: 'decision',
      title,
      detail,
      visibility: classifyVisibility(title, detail),
      opts: {
        importance: assignImportance('decision'),
        originalTokens: estimateTokens(toolResponse),
        ...extractLinkedReferences(toolResponse),
      },
    };
  }

  return classifyToolCall(tc);
}

/**
 * Detect plan progress references in tool responses.
 * Returns plan items that appear to be completed.
 */
export function detectPlanProgress(toolResponse: string): Array<{ planItem: string; status: string }> {
  const results: Array<{ planItem: string; status: string }> = [];
  const progressPattern = /(P\d+-\d+)\s*[:\-]?\s*(COMPLETE|PASS|DONE|complete|pass|done)/g;
  let match;
  while ((match = progressPattern.exec(toolResponse)) !== null) {
    results.push({ planItem: match[1], status: 'complete' });
  }
  return results;
}
