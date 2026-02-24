#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PostToolUse Context Hook
// Surfaces applicable CLAUDE.md rules and warnings when editing
// src/ files. Uses matchRules() and isInMiddlewareTree() from
// the codegraph index - no MCP server HTTP call needed.
// Must complete in <500ms.
// ============================================================

import Database from 'better-sqlite3';
import { matchRules } from '../rules.ts';
import { isInMiddlewareTree } from '../middleware-tree.ts';
import { getResolvedPaths, getProjectRoot } from '../config.ts';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: { file_path?: string };
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const filePath = hookInput.tool_input?.file_path;

    if (!filePath) {
      process.exit(0);
      return;
    }

    // Convert absolute path to relative
    const root = getProjectRoot();
    const rel = filePath.startsWith(root + '/') ? filePath.slice(root.length + 1) : filePath;

    // Only process src/ files
    if (!rel.startsWith('src/')) {
      process.exit(0);
      return;
    }

    const warnings: string[] = [];

    // 1. Check applicable rules (uses rules.ts PATTERN_RULES)
    const rules = matchRules(rel);
    for (const rule of rules) {
      if (rule.severity === 'CRITICAL' || rule.severity === 'HIGH') {
        for (const r of rule.rules) {
          warnings.push(`[${rule.severity}] ${r}`);
        }
      }
    }

    // 2. Check middleware tree membership
    try {
      const dataDb = new Database(getResolvedPaths().dataDbPath, { readonly: true });
      try {
        if (isInMiddlewareTree(dataDb, rel)) {
          warnings.push('[CRITICAL] This file is in the middleware import tree. No Node.js deps allowed.');
        }
      } finally {
        dataDb.close();
      }
    } catch (_e) {
      // DB may not exist yet - skip middleware check
    }

    // 3. Output warnings if any
    if (warnings.length > 0) {
      console.log(`[Massu] ${warnings.join(' | ')}`);
    }
  } catch (_e) {
    // Best-effort: never block Claude Code
  }
  process.exit(0);
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
