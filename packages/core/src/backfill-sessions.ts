#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P6-001: Backfill Tool
// One-time script to parse existing transcript JSONL files and
// populate the memory DB with historical session data.
// ============================================================

import { readdirSync, statSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { getMemoryDb, createSession, addObservation, addSummary, addUserPrompt, deduplicateFailedAttempt } from './memory-db.ts';
import { parseTranscript, extractUserMessages, getLastAssistantMessage } from './transcript-parser.ts';
import { extractObservationsFromEntries } from './observation-extractor.ts';
import { getProjectRoot } from './config.ts';

/**
 * Auto-detect the Claude Code project transcript directory.
 * Claude Code stores transcripts at ~/.claude/projects/-<escaped-path>/
 */
function findTranscriptDir(): string {
  const home = process.env.HOME ?? '~';
  const projectRoot = getProjectRoot();
  // Claude Code escapes the path by replacing / with -
  const escapedPath = projectRoot.replace(/\//g, '-');
  const candidate = resolve(home, '.claude/projects', escapedPath);
  if (existsSync(candidate)) return candidate;
  // Fallback: scan .claude/projects/ for directories matching the project name
  const projectsDir = resolve(home, '.claude/projects');
  if (existsSync(projectsDir)) {
    try {
      const entries = readdirSync(projectsDir);
      const projectName = basename(projectRoot);
      const match = entries.find(e => e.includes(projectName));
      if (match) return resolve(projectsDir, match);
    } catch {
      // Ignore
    }
  }
  return candidate;
}

const MAX_SESSIONS = 20;

async function main(): Promise<void> {
  console.log('=== Massu Memory Backfill ===');
  const TRANSCRIPT_DIR = findTranscriptDir();
  console.log(`Transcript directory: ${TRANSCRIPT_DIR}`);

  // 1. List JSONL files
  let files: string[];
  try {
    files = readdirSync(TRANSCRIPT_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: resolve(TRANSCRIPT_DIR, f),
        mtime: statSync(resolve(TRANSCRIPT_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)  // Most recent first
      .slice(0, MAX_SESSIONS)
      .map(f => f.path);
  } catch (error) {
    console.error(`Failed to read transcript directory: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }

  console.log(`Found ${files.length} transcript files (processing most recent ${MAX_SESSIONS})`);

  const db = getMemoryDb();
  let totalObservations = 0;
  let totalSessions = 0;

  try {
    for (const filePath of files) {
      const sessionId = filePath.split('/').pop()?.replace('.jsonl', '') ?? 'unknown';
      console.log(`\nProcessing: ${sessionId.slice(0, 8)}...`);

      try {
        // Parse transcript
        const entries = await parseTranscript(filePath);
        if (entries.length === 0) {
          console.log('  Skipped: empty transcript');
          continue;
        }

        // Extract session metadata
        const firstEntry = entries.find(e => e.sessionId);
        const gitBranch = firstEntry?.gitBranch;
        const startTimestamp = firstEntry?.timestamp;

        // Create session (INSERT OR IGNORE for idempotency)
        createSession(db, sessionId, { branch: gitBranch });

        // Update started_at if we have a timestamp
        if (startTimestamp) {
          db.prepare('UPDATE sessions SET started_at = ?, started_at_epoch = ? WHERE session_id = ? AND started_at_epoch = 0')
            .run(startTimestamp, Math.floor(new Date(startTimestamp).getTime() / 1000), sessionId);
        }

        // Extract user prompts
        const userMessages = extractUserMessages(entries);
        for (let i = 0; i < Math.min(userMessages.length, 50); i++) {
          try {
            addUserPrompt(db, sessionId, userMessages[i].text.slice(0, 5000), i + 1);
          } catch (_e) {
            // Skip duplicate prompts
          }
        }

        // Extract observations (with noise filtering applied)
        const observations = extractObservationsFromEntries(entries);
        let sessionObsCount = 0;

        for (const obs of observations) {
          try {
            if (obs.type === 'failed_attempt') {
              deduplicateFailedAttempt(db, sessionId, obs.title, obs.detail, obs.opts);
            } else {
              addObservation(db, sessionId, obs.type, obs.title, obs.detail, obs.opts);
            }
            sessionObsCount++;
          } catch (_e) {
            // Skip on error
          }
        }

        totalObservations += sessionObsCount;
        totalSessions++;
        console.log(`  Extracted: ${sessionObsCount} observations, ${Math.min(userMessages.length, 50)} prompts`);

        // Generate summary from observations
        const completed = observations
          .filter(o => ['feature', 'bugfix', 'refactor'].includes(o.type))
          .map(o => `- ${o.title}`)
          .join('\n');

        const decisions = observations
          .filter(o => o.type === 'decision')
          .map(o => `- ${o.title}`)
          .join('\n');

        const failedAttempts = observations
          .filter(o => o.type === 'failed_attempt')
          .map(o => `- ${o.title}`)
          .join('\n');

        if (observations.length > 0) {
          try {
            addSummary(db, sessionId, {
              request: userMessages[0]?.text?.slice(0, 500),
              completed: completed || undefined,
              decisions: decisions || undefined,
              failedAttempts: failedAttempts || undefined,
            });
          } catch (_e) {
            // Skip summary errors
          }
        }

        // Mark as completed
        db.prepare("UPDATE sessions SET status = 'completed' WHERE session_id = ? AND status = 'active'")
          .run(sessionId);

      } catch (error) {
        console.log(`  Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    db.close();
  }

  console.log('\n=== Backfill Complete ===');
  console.log(`Sessions processed: ${totalSessions}`);
  console.log(`Total observations: ${totalObservations}`);
}

main().catch(console.error);
