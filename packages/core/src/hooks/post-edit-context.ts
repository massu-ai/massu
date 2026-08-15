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

import { openDatabase } from '../db-driver.ts';
import { matchRules } from '../rules.ts';
import { isInMiddlewareTree } from '../middleware-tree.ts';
import { getResolvedPaths, getProjectRoot } from '../config.ts';
import { isUnderSourceDir } from '../lib/source-layout.ts';
import { writeHookContext, type HookEvent } from './lib/write-hook-message.ts';

/** Registered on PostToolUse. Asserted against `.claude/settings.json` by
 *  `hook-context-delivery-drift-guard.test.ts`, so this constant cannot drift
 *  from the event the hook is actually wired to. */
const HOOK_EVENT: HookEvent = 'PostToolUse';
import { recordHookFailure } from './lib/hook-failure-signal.ts';
import { isDirectInvocation } from './lib/is-direct-invocation.ts';

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

    // Only process files under a DECLARED source dir. This was `src/`, which in
    // any layout that is not single-package matches nothing — so the hook exited
    // silently on every edit and looked exactly like a hook with nothing to say.
    if (!isUnderSourceDir(rel) && !rel.endsWith('.py')) {
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
      const dataDb = openDatabase(getResolvedPaths().dataDbPath, { readonly: true, selfHeal: false });
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
      writeHookContext(HOOK_EVENT, `[Massu] ${warnings.join(' | ')}`);
    }
  } catch (err) {
    // G-2: a hook may fail; it may not fail SILENTLY. Exit stays 0 (a Massu
    // bug must never block the user's session) but the failure now leaves a
    // durable trace: .massu/hook-failures.jsonl + stderr + hook_health.
    recordHookFailure('post-edit-context', err);
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

// Run main() only when this file IS the process entry point. Written bare,
// `main()` at module scope means IMPORTING this module RUNS the hook: it reads
// stdin, does its work, and exits the host process.
if (isDirectInvocation(import.meta.url)) {
  main();
}
