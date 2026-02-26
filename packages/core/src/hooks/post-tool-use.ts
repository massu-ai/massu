#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-002: PostToolUse Observation Hook
// Captures tool usage as observations (lightweight, no AI needed).
// Must complete in <500ms.
// ============================================================

import { getMemoryDb, addObservation, createSession, deduplicateFailedAttempt, addSummary } from '../memory-db.ts';
import { classifyRealTimeToolCall, detectPlanProgress } from '../observation-extractor.ts';
import { logAuditEntry } from '../audit-trail.ts';
import { trackModification } from '../regression-detector.ts';
import { validateFile, storeValidationResult } from '../validation-engine.ts';
import { scoreFileSecurity, storeSecurityScore } from '../security-scorer.ts';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
}

// In-memory dedup for Read calls within this session
const seenReads = new Set<string>();
let currentSessionId: string | null = null;

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, tool_name, tool_input, tool_response } = hookInput;

    // Reset seen reads if session changed
    if (currentSessionId !== session_id) {
      seenReads.clear();
      currentSessionId = session_id;
    }

    const db = getMemoryDb();
    try {
      // Ensure session exists
      createSession(db, session_id);

      // Classify and filter
      const observation = classifyRealTimeToolCall(tool_name, tool_input, tool_response, seenReads);
      if (!observation) {
        process.exit(0);
        return;
      }

      // Deduplicate failed attempts
      if (observation.type === 'failed_attempt') {
        deduplicateFailedAttempt(db, session_id, observation.title, observation.detail, observation.opts);
      } else {
        addObservation(db, session_id, observation.type, observation.title, observation.detail, observation.opts);
      }

      // Auto-detect plan progress
      if (tool_response) {
        const progress = detectPlanProgress(tool_response);
        if (progress.length > 0) {
          // Update plan_progress in session summary
          updatePlanProgress(db, session_id, progress);
        }
      }

      // Audit trail logging for file changes
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          logAuditEntry(db, {
            sessionId: session_id,
            eventType: 'code_change',
            actor: 'ai',
            filePath,
            changeType: tool_name === 'Write' ? 'create' : 'edit',
          });

          // Track modification for regression detection
          if (filePath) {
            const featureMatch = filePath.match(/(?:routers|components|app\/\(([^)]+)\))\/([^/.]+)/);
            if (featureMatch) {
              const featureKey = featureMatch[1] ?? featureMatch[2];
              trackModification(db, featureKey);
            }
          }
        }
      } catch (_auditErr) {
        // Best-effort: never block post-tool-use
      }

      // Real-time validation for Edit/Write
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          if (filePath && (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))) {
            const projectRoot = hookInput.cwd;
            const checks = validateFile(filePath, projectRoot);
            const violations = checks.filter(c => c.severity === 'error' || c.severity === 'critical');
            if (violations.length > 0) {
              storeValidationResult(db, filePath, checks, session_id);
            }
          }
        }
      } catch (_validationErr) {
        // Best-effort: never block post-tool-use
      }

      // Auto-security scoring for router/API files
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          if (filePath && (filePath.includes('routers/') || filePath.includes('api/'))) {
            const projectRoot = hookInput.cwd;
            const { riskScore, findings } = scoreFileSecurity(filePath, projectRoot);
            if (findings.length > 0) {
              storeSecurityScore(db, session_id, filePath, riskScore, findings);
            }
          }
        }
      } catch (_securityErr) {
        // Best-effort: never block post-tool-use
      }

      // MEMORY.md integrity check on write
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          if (filePath && filePath.endsWith('MEMORY.md') && filePath.includes('/memory/')) {
            const issues = checkMemoryFileIntegrity(filePath);
            if (issues.length > 0) {
              addObservation(db, session_id, 'incident_near_miss',
                'MEMORY.md integrity issue detected',
                issues.join('; '),
                { importance: 4 }
              );
            }
          }
        }
      } catch (_memoryErr) {
        // Best-effort: never block post-tool-use
      }

      // Knowledge index staleness check on knowledge file edits
      try {
        if (tool_name === 'Edit' || tool_name === 'Write') {
          const filePath = (tool_input.file_path as string) ?? '';
          if (filePath && isKnowledgeSourceFile(filePath)) {
            addObservation(db, session_id, 'discovery',
              'Knowledge source file modified - index may be stale',
              `Edited ${filePath.split('/').pop() ?? filePath}. Run knowledge re-index to update.`,
              { importance: 3 }
            );
          }
        }
      } catch (_knowledgeErr) {
        // Best-effort: never block post-tool-use
      }
    } finally {
      db.close();
    }
  } catch (_e) {
    // Best-effort: never block Claude Code
  }
  process.exit(0);
}

function updatePlanProgress(db: import('better-sqlite3').Database, sessionId: string, progress: Array<{ planItem: string; status: string }>): void {
  // Get or create latest summary's plan_progress
  const existing = db.prepare(
    'SELECT id, plan_progress FROM session_summaries WHERE session_id = ? ORDER BY created_at_epoch DESC LIMIT 1'
  ).get(sessionId) as { id: number; plan_progress: string } | undefined;

  if (existing) {
    try {
      const currentProgress = JSON.parse(existing.plan_progress) as Record<string, string>;
      for (const p of progress) {
        currentProgress[p.planItem] = p.status;
      }
      db.prepare('UPDATE session_summaries SET plan_progress = ? WHERE id = ?')
        .run(JSON.stringify(currentProgress), existing.id);
    } catch (_e) {
      // Skip if JSON parse fails
    }
  } else {
    // Create a minimal summary with plan progress
    const progressMap: Record<string, string> = {};
    for (const p of progress) {
      progressMap[p.planItem] = p.status;
    }
    addSummary(db, sessionId, { planProgress: progressMap });
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

/**
 * Read the conventions section from massu.config.yaml directly.
 * Hooks are compiled with esbuild and cannot use getConfig() from config.ts.
 * Falls back to sensible defaults if the config file is not found.
 */
function readConventions(cwd?: string): {
  knowledgeSourceFiles: string[];
  claudeDirName: string;
} {
  const defaults = {
    knowledgeSourceFiles: ['CLAUDE.md', 'MEMORY.md', 'corrections.md'],
    claudeDirName: '.claude',
  };
  try {
    const projectRoot = cwd ?? process.cwd();
    const configPath = join(projectRoot, 'massu.config.yaml');
    if (!existsSync(configPath)) return defaults;
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return defaults;
    const conventions = parsed.conventions as Record<string, unknown> | undefined;
    if (!conventions || typeof conventions !== 'object') return defaults;
    return {
      knowledgeSourceFiles: Array.isArray(conventions.knowledgeSourceFiles)
        ? conventions.knowledgeSourceFiles as string[]
        : defaults.knowledgeSourceFiles,
      claudeDirName: typeof conventions.claudeDirName === 'string'
        ? conventions.claudeDirName
        : defaults.claudeDirName,
    };
  } catch {
    return defaults;
  }
}

/**
 * Check if a file path is a knowledge source file (CLAUDE.md, corrections.md,
 * memory files, or knowledge system source files).
 * When these are edited, the knowledge index may become stale.
 */
function isKnowledgeSourceFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? '';
  const conventions = readConventions();
  const knowledgeSourcePatterns = [
    ...conventions.knowledgeSourceFiles,
    'file-index.md',
    'knowledge-db.ts',
    'knowledge-indexer.ts',
    'knowledge-tools.ts',
  ];
  return knowledgeSourcePatterns.some(p => basename === p) ||
    filePath.includes('/memory/') ||
    filePath.includes(conventions.claudeDirName + '/');
}

/**
 * Check MEMORY.md file integrity after a write.
 * Verifies: file exists, has expected structure, and is under line limit.
 * Returns array of issue descriptions (empty = all good).
 */
function checkMemoryFileIntegrity(filePath: string): string[] {
  const issues: string[] = [];

  try {
    if (!existsSync(filePath)) {
      issues.push('MEMORY.md file does not exist after write');
      return issues;
    }

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check line count (CLAUDE.md truncates after ~200 lines)
    const MAX_LINES = 200;
    if (lines.length > MAX_LINES) {
      issues.push(`MEMORY.md exceeds ${MAX_LINES} lines (currently ${lines.length}). Consider archiving old entries.`);
    }

    // Check required structure sections
    const requiredSections = ['# Massu Memory', '## Key Learnings', '## Common Gotchas'];
    for (const section of requiredSections) {
      if (!content.includes(section)) {
        issues.push(`Missing required section: "${section}"`);
      }
    }
  } catch (_e) {
    // Graceful degradation: don't report issues if we can't check
  }

  return issues;
}

main();
