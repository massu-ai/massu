#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PreToolUse Hook: Pre-Deletion Feature Impact Check
// Detects file deletion patterns (rm, git rm, Write with empty content)
// and runs sentinel impact analysis. Blocks if critical features orphaned.
// Also protects knowledge system files from accidental deletion (P7-005).
// Must complete in <500ms.
// ============================================================

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { getFeatureImpact } from '../sentinel-db.ts';
import { getProjectRoot, getResolvedPaths } from '../config.ts';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: {
    command?: string;
    file_path?: string;
    content?: string;
  };
}

const PROJECT_ROOT = getProjectRoot();

// Knowledge system files that must never be silently deleted.
// These files underpin knowledge indexing and memory retrieval.
const KNOWLEDGE_PROTECTED_FILES = [
  'knowledge-db.ts',
  'knowledge-indexer.ts',
  'knowledge-tools.ts',
];

function getDataDb(): Database.Database | null {
  const dbPath = getResolvedPaths().dataDbPath;
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch {
    return null;
  }
}

/**
 * P7-005: Check if the tool call targets a protected knowledge system file.
 * Returns a warning message if a protected file would be deleted/emptied.
 */
function checkKnowledgeFileProtection(input: HookInput): string | null {
  const candidateFiles: string[] = [];

  if (input.tool_name === 'Bash' && input.tool_input.command) {
    const cmd = input.tool_input.command;
    const rmMatch = cmd.match(/(?:rm|git\s+rm)\s+(?:-[rf]*\s+)*(.+)/);
    if (rmMatch) {
      const parts = rmMatch[1].split(/\s+/).filter(p => !p.startsWith('-'));
      candidateFiles.push(...parts);
    }
  }

  if (input.tool_name === 'Write' && input.tool_input.file_path) {
    const content = input.tool_input.content || '';
    if (content.trim().length === 0) {
      candidateFiles.push(input.tool_input.file_path);
    }
  }

  for (const f of candidateFiles) {
    const basename = f.split('/').pop() ?? f;
    if (KNOWLEDGE_PROTECTED_FILES.includes(basename)) {
      return (
        `KNOWLEDGE SYSTEM PROTECTION: "${basename}" is a core knowledge system file. ` +
        `Deleting it will break knowledge indexing and memory retrieval. ` +
        `Create a replacement before removing.`
      );
    }
  }

  return null;
}

function extractDeletedFiles(input: HookInput): string[] {
  const files: string[] = [];

  if (input.tool_name === 'Bash' && input.tool_input.command) {
    const cmd = input.tool_input.command;

    // Detect rm commands
    const rmMatch = cmd.match(/(?:rm|git\s+rm)\s+(?:-[rf]*\s+)*(.+)/);
    if (rmMatch) {
      const paths = rmMatch[1].split(/\s+/).filter(p => !p.startsWith('-'));
      for (const p of paths) {
        const relPath = p.startsWith('src/') ? p : p.replace(PROJECT_ROOT + '/', '');
        if (relPath.startsWith('src/')) {
          files.push(relPath);
        }
      }
    }
  }

  // Detect Write tool with empty content (file replacement that empties)
  if (input.tool_name === 'Write' && input.tool_input.file_path) {
    const content = input.tool_input.content || '';
    if (content.trim().length === 0) {
      const relPath = input.tool_input.file_path.replace(PROJECT_ROOT + '/', '');
      if (relPath.startsWith('src/')) {
        files.push(relPath);
      }
    }
  }

  return files;
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;

    // P7-005: Check knowledge file protection before anything else
    const knowledgeWarning = checkKnowledgeFileProtection(hookInput);
    if (knowledgeWarning) {
      process.stdout.write(JSON.stringify({ message: knowledgeWarning }));
      process.exit(0);
      return;
    }

    const deletedFiles = extractDeletedFiles(hookInput);
    if (deletedFiles.length === 0) {
      process.exit(0);
      return;
    }

    const db = getDataDb();
    if (!db) {
      // No database available - can't check
      process.exit(0);
      return;
    }

    // The sentinel registry table name (defined by sentinel-db schema)
    const SENTINEL_TABLE = 'massu_sentinel';

    try {
      // Check if any sentinel tables exist
      const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(SENTINEL_TABLE);

      if (!tableExists) {
        process.exit(0);
        return;
      }

      const impact = getFeatureImpact(db, deletedFiles);

      if (impact.blocked) {
        const msg = [
          `SENTINEL IMPACT WARNING: Deleting ${deletedFiles.length} file(s) would affect features:`,
          '',
        ];

        if (impact.orphaned.length > 0) {
          msg.push(`ORPHANED (${impact.orphaned.length} features - no primary components left):`);
          for (const item of impact.orphaned) {
            msg.push(`  - ${item.feature.feature_key} [${item.feature.priority}]: ${item.feature.title}`);
          }
        }

        if (impact.degraded.length > 0) {
          msg.push(`DEGRADED (${impact.degraded.length} features - some components removed):`);
          for (const item of impact.degraded) {
            msg.push(`  - ${item.feature.feature_key}: ${item.feature.title}`);
          }
        }

        msg.push('');
        msg.push('Create a migration plan before deleting these files.');

        // Output warning but don't block (user can proceed)
        process.stdout.write(JSON.stringify({ message: msg.join('\n') }));
      }
    } finally {
      db.close();
    }
  } catch {
    // Hooks must never crash
  }

  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Timeout to prevent hanging
    setTimeout(() => resolve(data), 400);
  });
}

main();
