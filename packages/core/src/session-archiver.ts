// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import type Database from 'better-sqlite3';
import { generateCurrentMd } from './session-state-generator.ts';
import { getProjectRoot } from './config.ts';

// ============================================================
// P5-002: Session Archiver
// ============================================================

const PROJECT_ROOT = getProjectRoot();

/**
 * Archive the current CURRENT.md and generate a new one from memory DB.
 */
export function archiveAndRegenerate(db: Database.Database, sessionId: string): {
  archived: boolean;
  archivePath?: string;
  newContent: string;
} {
  const currentMdPath = resolve(PROJECT_ROOT, '.claude/session-state/CURRENT.md');
  const archiveDir = resolve(PROJECT_ROOT, '.claude/session-state/archive');
  let archived = false;
  let archivePath: string | undefined;

  // 1. Archive existing CURRENT.md if it exists and has content
  if (existsSync(currentMdPath)) {
    const existingContent = readFileSync(currentMdPath, 'utf-8');
    if (existingContent.trim().length > 10) {
      // Extract date and task description for filename
      const { date, slug } = extractArchiveInfo(existingContent);
      archivePath = resolve(archiveDir, `${date}-${slug}.md`);

      // Ensure archive directory exists
      if (!existsSync(archiveDir)) {
        mkdirSync(archiveDir, { recursive: true });
      }

      // Move to archive (rename is atomic on same filesystem)
      try {
        renameSync(currentMdPath, archivePath);
        archived = true;
      } catch (_e) {
        // If rename fails (cross-device), copy+delete
        writeFileSync(archivePath, existingContent);
        archived = true;
      }
    }
  }

  // 2. Generate new CURRENT.md from memory DB
  const newContent = generateCurrentMd(db, sessionId);

  // 3. Write new CURRENT.md
  const dir = dirname(currentMdPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(currentMdPath, newContent, 'utf-8');

  return { archived, archivePath, newContent };
}

/**
 * Extract date and slug from existing CURRENT.md content for archive naming.
 */
function extractArchiveInfo(content: string): { date: string; slug: string } {
  // Try to extract date from "# Session State - January 30, 2026"
  const dateMatch = content.match(/# Session State - (\w+ \d+, \d+)/);
  let date = new Date().toISOString().split('T')[0]; // fallback

  if (dateMatch) {
    const parsed = new Date(dateMatch[1]);
    if (!isNaN(parsed.getTime())) {
      date = parsed.toISOString().split('T')[0];
    }
  }

  // Also try ISO date format "**Last Updated**: 2026-01-30"
  const isoMatch = content.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    date = isoMatch[1];
  }

  // Extract task description for slug
  let slug = 'session';
  const taskMatch = content.match(/\*\*Task\*\*:\s*(.+)/);
  if (taskMatch) {
    slug = taskMatch[1]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }

  // Extract status for slug if no task
  if (slug === 'session') {
    const statusMatch = content.match(/\*\*Status\*\*:\s*\w+\s*-\s*(.+)/);
    if (statusMatch) {
      slug = statusMatch[1]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
    }
  }

  return { date, slug };
}
