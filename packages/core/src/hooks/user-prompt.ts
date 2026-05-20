#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-004: UserPromptSubmit Hook
// Captures user prompts for search and context.
// ============================================================

import { getMemoryDb, createSession, addUserPrompt, linkSessionToTask, autoDetectTaskId, addObservation } from '../memory-db.ts';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { getResolvedPaths } from '../config.ts';
import { scoreCorrectionPrompt } from '../rule-candidate-detector.ts';
import { categorizePrompt, hashPrompt } from '../prompt-analyzer.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  prompt: string;
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, prompt } = hookInput;

    if (!prompt || !prompt.trim()) {
      process.exit(0);
      return;
    }

    const db = getMemoryDb();
    try {
      // 1. Create session if not exists
      const gitBranch = await getGitBranch();
      createSession(db, session_id, { branch: gitBranch });

      // 2. Scan prompt for plan file references
      const planFileMatch = prompt.match(/([^\s]+docs\/plans\/[^\s]+\.md)/);
      if (planFileMatch) {
        const planFile = planFileMatch[1];
        db.prepare('UPDATE sessions SET plan_file = ? WHERE session_id = ?').run(planFile, session_id);

        // Auto-detect and link task_id
        const taskId = autoDetectTaskId(planFile);
        if (taskId) {
          linkSessionToTask(db, session_id, taskId);
        }
      }

      // 3. Get current prompt count for this session
      const countResult = db.prepare(
        'SELECT COUNT(*) as count FROM user_prompts WHERE session_id = ?'
      ).get(session_id) as { count: number };
      const promptNumber = countResult.count + 1;

      // 4. Insert prompt
      addUserPrompt(db, session_id, prompt.trim(), promptNumber);

      // 5. Knowledge-aware prompt enrichment: detect file references and check knowledge index
      try {
        const fileRefs = extractFileReferences(prompt);
        if (fileRefs.length > 0) {
          const knowledgeDbPath = getResolvedPaths().knowledgeDbPath;
          if (knowledgeDbPath && existsSync(knowledgeDbPath)) {
            const Database = (await import('better-sqlite3')).default;
            const kdb = new Database(knowledgeDbPath, { readonly: true });
            try {
              const placeholders = fileRefs.map(() => '?').join(',');
              const matches = kdb.prepare(
                `SELECT DISTINCT file_path FROM knowledge_documents WHERE file_path IN (${placeholders}) LIMIT 10000`
              ).all(...fileRefs) as Array<{ file_path: string }>;
              if (matches.length > 0) {
                addObservation(db, session_id, 'discovery',
                  `Knowledge entries exist for referenced files`,
                  `Files with knowledge context: ${matches.map(m => m.file_path).join(', ')}`,
                  { importance: 2 }
                );
              }
            } finally {
              kdb.close();
            }
          }
        }
      } catch (_knowledgeErr) {
        // Best-effort: never block prompt capture
      }
      // 6. Memory enforcement: nag when significant work detected but no memory ingestion
      try {
        const significantSignals = ['fix', 'implement', 'migrate', 'refactor', 'debug', 'decision', 'chose', 'architecture', 'redesign', 'rewrite'];
        const promptLower = prompt.toLowerCase();
        const signalCount = significantSignals.filter(s => promptLower.includes(s)).length;

        if (signalCount >= 2) {
          const memoryFileCount = db.prepare(
            "SELECT COUNT(*) as count FROM observations WHERE session_id = ? AND title LIKE '[memory-file] %'"
          ).get(session_id) as { count: number };

          if (memoryFileCount.count === 0) {
            process.stderr.write(
              '\n[MEMORY REMINDER] Significant work detected but no memory files have been written.\n' +
              'Consider saving learnings to memory/*.md files for future sessions.\n\n'
            );
          }
        }
      } catch (_memoryNagErr) {
        // Best-effort: never block prompt capture
      }

      // 7. Rule-candidate detector (plan-v0.2-interactive-rule-approval P-A-002 / P-A-006).
      // Emits candidate JSON sidecars + a one-line stderr nudge when count grows.
      try {
        const priorTurn = detectPriorAssistantTurn(hookInput.transcript_path);
        const lastOutcome = db.prepare(
          'SELECT corrections_needed FROM prompt_outcomes WHERE session_id = ? ORDER BY id DESC LIMIT 1'
        ).get(session_id) as { corrections_needed: number } | undefined;
        const blacklist = readSignalBlacklist(db);

        const scoreResult = scoreCorrectionPrompt({
          prompt,
          priorAssistantTurn: { hadEditOrWrite: priorTurn.hadEditOrWrite },
          priorOutcomes: lastOutcome ? { lastCorrectionsNeeded: lastOutcome.corrections_needed } : undefined,
          category: categorizePrompt(prompt),
          blacklist,
        });

        const candidateDir = join(hookInput.cwd, '.massu', 'rule-candidates');
        if (scoreResult.emitCandidate) {
          mkdirSync(candidateDir, { recursive: true });
          const promptHash = hashPrompt(prompt);
          const candidatePath = join(candidateDir, `${promptHash}.json`);
          // Sha-keyed file naming → idempotent on retry (plan §5 idempotency).
          if (!existsSync(candidatePath)) {
            writeFileSync(candidatePath, JSON.stringify({
              prompt,
              prompt_hash: promptHash,
              score: scoreResult.score,
              signals: scoreResult.signals,
              prior_turn_files: priorTurn.files,
              timestamp: new Date().toISOString(),
              session_id,
            }, null, 2));
          }
        }

        // P-A-006: stderr nudge when candidate count grows since last-surfaced.
        if (existsSync(candidateDir)) {
          const candidates = readdirSync(candidateDir).filter(
            f => f.endsWith('.json') && !f.startsWith('.')
          );
          const candidateCount = candidates.length;
          const surfacedPath = join(candidateDir, '.last-surfaced');
          let lastSurfaced = 0;
          if (existsSync(surfacedPath)) {
            const raw = readFileSync(surfacedPath, 'utf-8').trim();
            const parsed = parseInt(raw, 10);
            if (!Number.isNaN(parsed)) lastSurfaced = parsed;
          }
          if (candidateCount > lastSurfaced) {
            process.stderr.write(
              `\n[RULE CANDIDATE] ${candidateCount} rule candidate(s) pending (\`/massu-rule list\`)\n\n`
            );
            writeFileSync(surfacedPath, String(candidateCount));
          }
        }
      } catch (candidateErr) {
        // ARCH-07 fix: best-effort, never block prompt capture, BUT
        // surface in-hook errors to the same dual-channel observability
        // surface used by the CR-53 increment hook. Symmetry — neither
        // detector swallow can fail silently in production.
        try {
          const dir = join(hookInput.cwd, '.massu', 'rule-candidates');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const logPath = join(dir, '.detector-failures.jsonl');
          const pre = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
          const sep = pre && !pre.endsWith('\n') ? '\n' : '';
          writeFileSync(logPath, pre + sep + JSON.stringify({
            session_id,
            prompt_excerpt: prompt.slice(0, 200),
            error: candidateErr instanceof Error ? candidateErr.message : String(candidateErr),
            timestamp: new Date().toISOString(),
          }) + '\n', 'utf-8');
        } catch { /* truly best-effort */ }
      }
    } finally {
      db.close();
    }
  } catch (_e) {
    // Best-effort: never block Claude Code
  }
  process.exit(0);
}

/**
 * Walk the most recent assistant turn in the JSONL transcript and detect whether
 * it contained an Edit / Write / NotebookEdit tool call, or a Bash command that
 * wrote to a file (sed -i, tee, cat > x, printf > x, append redirection).
 * Reads only the tail (~200KB) to stay inside the 5s hook budget on long sessions.
 */
function detectPriorAssistantTurn(transcriptPath: string): { hadEditOrWrite: boolean; files: string[] } {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return { hadEditOrWrite: false, files: [] };
    }
    // SEC-05: bind the transcript path to the known Claude Code projects
    // tree. The hook input is user-controlled via Claude Code — refuse
    // any path outside the expected prefix so a malicious transcript
    // can't be pointed at a file we shouldn't be reading.
    if (!transcriptPath.includes('/.claude/projects/')) {
      return { hadEditOrWrite: false, files: [] };
    }
    const fd = openSync(transcriptPath, 'r');
    let buf: Buffer;
    try {
      const stats = fstatSync(fd);
      const readLen = Math.min(stats.size, 200 * 1024);
      const offset = stats.size - readLen;
      buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, offset);
    } finally {
      closeSync(fd);
    }

    const lines = buf.toString('utf-8').split('\n').filter(Boolean);
    const files: string[] = [];
    let hadEditOrWrite = false;
    let foundAssistant = false;
    const WRITE_BASH = /\b(sed\s+-i|tee\s|printf\s.*?>|cat\s+<<.*?>|>>?\s*['"\w/.-]+)/;

    type TranscriptEntry = { type?: string; message?: { content?: unknown } };
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: TranscriptEntry | null = null;
      try { entry = JSON.parse(lines[i]) as TranscriptEntry; } catch { continue; }
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'user' && foundAssistant) break;
      if (entry.type !== 'assistant') continue;

      foundAssistant = true;
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
        if (b.type !== 'tool_use') continue;
        const name = String(b.name ?? '');
        if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
          hadEditOrWrite = true;
          const fp = b.input?.file_path;
          if (typeof fp === 'string') files.push(fp);
        } else if (name === 'Bash') {
          const cmd = String(b.input?.command ?? '');
          if (WRITE_BASH.test(cmd)) hadEditOrWrite = true;
        }
      }
    }
    return { hadEditOrWrite, files: [...new Set(files)] };
  } catch (_e) {
    return { hadEditOrWrite: false, files: [] };
  }
}

/**
 * Read the signal blacklist used by the rule-candidate detector. Table is created
 * lazily by Phase C migrations; pre-migration we return an empty map.
 */
function readSignalBlacklist(db: Database.Database): ReadonlyMap<string, number> {
  try {
    // LIMIT 10000 per P-DG-001; realistic max is ~9 (one per SignalName).
    const rows = db.prepare(
      'SELECT signal, dismissal_count FROM prompt_outcomes_signal_blacklist LIMIT 10000'
    ).all() as Array<{ signal: string; dismissal_count: number }>;
    return new Map(rows.map(r => [r.signal, r.dismissal_count]));
  } catch (_e) {
    return new Map();
  }
}

/**
 * Extract file path references from user prompt text.
 * Matches patterns like src/foo/bar.ts, packages/core/src/x.ts, etc.
 */
function extractFileReferences(prompt: string): string[] {
  const filePattern = /(?:^|\s)((?:src|packages|lib)\/[\w./-]+\.(?:ts|tsx|js|jsx|md))/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(prompt)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)];
}

async function getGitBranch(): Promise<string | undefined> {
  try {
    const { spawnSync } = await import('child_process');
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status !== 0 || result.error) return undefined;
    return result.stdout.trim();
  } catch (_e) {
    return undefined;
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

main();
