#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PostToolUse Hook: Fix Detector
// Detects when a bug fix is being applied during a session by
// analyzing git diffs of edited files. Sets session-level state
// so the auto-learning pipeline can trigger at session end.
//
// Part of the Auto-Learning Pipeline:
//   [Fix Detected] → Incident Report → Rule → Enforcement
//
// Must complete in <1000ms.
// ============================================================

import { execFileSync } from 'child_process';
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getProjectRoot, getConfig } from '../config.ts';
import { writeHookContext, type HookEvent } from './lib/write-hook-message.ts';

/** Registered on PostToolUse. Asserted against `.claude/settings.json` by
 *  `hook-context-delivery-drift-guard.test.ts`, so this constant cannot drift
 *  from the event the hook is actually wired to. */
const HOOK_EVENT: HookEvent = 'PostToolUse';
import { recordHookFailure } from './lib/hook-failure-signal.ts';

interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: { file_path?: string };
}

interface FixSignal {
  file: string;
  signals: string[];
  timestamp: string;
}

// Fix detection heuristics — each returns true if the pattern matches
const FIX_HEURISTICS: Array<{ name: string; test: (diff: string) => boolean }> = [
  {
    name: 'removed_broken_code',
    test: (diff) => /^-.*\b(bug|broken|wrong|incorrect|typo|crash|error|fail|miss|stale)\b/m.test(diff),
  },
  {
    name: 'added_error_handling',
    test: (diff) => {
      const added = (diff.match(/^\+.*(try|except|catch|guard|if.*nil|if.*None|validate|assert|raise|throw)/gm) || []).length;
      return added > 2;
    },
  },
  {
    name: 'method_name_correction',
    test: (diff) => {
      const removed = diff.match(/^-.*\.([a-z_]+)\(/m);
      const added = diff.match(/^\+.*\.([a-z_]+)\(/m);
      return !!(removed && added && removed[1] !== added[1]);
    },
  },
  {
    name: 'auth_fix',
    test: (diff) => /^\+.*(token|auth|header|X-Service|Bearer|credential)/im.test(diff),
  },
  {
    name: 'nil_handling_fix',
    test: (diff) => /^\+.*(= nil|= None|\.isNil|is None|!= nil|is not None|guard let|if let|optional)/m.test(diff) && /^-/m.test(diff),
  },
  {
    name: 'concurrency_fix',
    test: (diff) => /^\+.*(timeout|semaphore|lock|mutex|throttle|rate.limit|max_conn)/im.test(diff),
  },
  {
    name: 'async_pattern_fix',
    test: (diff) => /^\+.*(@MainActor|async with|asyncio\.timeout|\.await)/.test(diff) && /^-/m.test(diff),
  },
  {
    name: 'added_missing_import',
    test: (diff) => /^\+.*(import|from.*import|require)/.test(diff) && !/^-.*(import|from.*import|require)/m.test(diff),
  },
];

function getSessionFlagPath(sessionId: string): string {
  const dir = join(tmpdir(), 'massu-auto-learning');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `fixes-${sessionId.slice(0, 12)}.jsonl`);
}

// P-M-003: cached git work-tree check + per-session auto-disable on slow git.
// Cache path: /tmp/massu-fix-detector-state/{cwd-hash}.json with TTL 1h.
// Disable path: /tmp/massu-fix-detector-state/disabled-{session_id}.flag.
function _stateDir(): string {
  const dir = join(tmpdir(), 'massu-fix-detector-state');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function _cwdHash(cwd: string): string {
  // djb2-ish stable hash; we don't need cryptographic strength, just stability.
  let h = 5381;
  for (let i = 0; i < cwd.length; i++) {
    h = ((h << 5) + h + cwd.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function isGitWorkTreeFast(cwd: string): boolean {
  try {
    const cachePath = join(_stateDir(), `worktree-${_cwdHash(cwd)}.json`);
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as { isWorkTree: boolean; ts: number };
      const ageMs = Date.now() - cached.ts;
      if (ageMs < 3600_000) return cached.isWorkTree;
    }
    let isWorkTree = false;
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 500, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      isWorkTree = true;
    } catch {
      isWorkTree = false;
    }
    try {
      appendFileSync(cachePath, '');
      const fs = require('fs') as typeof import('fs');
      fs.writeFileSync(cachePath, JSON.stringify({ isWorkTree, ts: Date.now() }));
    } catch {
      // Cache write best-effort; on failure, accept fresh probe next time.
    }
    return isWorkTree;
  } catch {
    return false;
  }
}

function _disabledFlagPath(sessionId: string): string {
  return join(_stateDir(), `disabled-${sessionId.slice(0, 12)}.flag`);
}

function isSessionAutoDisabled(sessionId: string): boolean {
  try {
    return existsSync(_disabledFlagPath(sessionId));
  } catch {
    return false;
  }
}

function markSessionAutoDisabled(sessionId: string, elapsedMs: number): void {
  try {
    const fs = require('fs') as typeof import('fs');
    fs.writeFileSync(_disabledFlagPath(sessionId), `disabled: previous git diff took ${elapsedMs}ms\n`);
  } catch {
    // Best-effort; if we can't write the flag the next call will just re-probe slowly.
  }
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const filePath = hookInput.tool_input?.file_path;

    if (!filePath || !existsSync(filePath)) {
      process.exit(0);
      return;
    }

    // Only check code files
    if (!/\.(py|swift|ts|tsx|js|jsx|rs|go|rb|sh)$/.test(filePath)) {
      process.exit(0);
      return;
    }

    // Skip incident/memory/doc files (those ARE pipeline output)
    const config = getConfig();
    const incidentDir = config.autoLearning?.incidentDir ?? 'docs/incidents';
    const memoryDir = config.autoLearning?.memoryDir ?? 'memory';
    if (filePath.includes(incidentDir) || filePath.includes(memoryDir) || filePath.includes('MEMORY.md')) {
      process.exit(0);
      return;
    }

    // Check if auto-learning is enabled
    if (config.autoLearning?.enabled === false || config.autoLearning?.fixDetection?.enabled === false) {
      process.exit(0);
      return;
    }

    // Get git diff for this file.
    // P-M-003 (plan-stage-d-medium-sweep): pre-check git work-tree once with short 500ms
    // budget; cache result in tmpdir; auto-disable for sessions where git-diff exceeded
    // 2000ms previously. Protects against slow git filesystems (WSL, network drives).
    const root = getProjectRoot();
    if (!isGitWorkTreeFast(root) || isSessionAutoDisabled(hookInput.session_id)) {
      process.exit(0);
      return;
    }
    let diff = '';
    try {
      const startMs = Date.now();
      diff = execFileSync('git', ['diff', '--', filePath], { cwd: root, timeout: 3000, encoding: 'utf-8' });
      if (!diff) {
        diff = execFileSync('git', ['diff', 'HEAD', '--', filePath], { cwd: root, timeout: 3000, encoding: 'utf-8' });
      }
      const elapsedMs = Date.now() - startMs;
      if (elapsedMs > 2000) {
        markSessionAutoDisabled(hookInput.session_id, elapsedMs);
      }
    } catch {
      process.exit(0);
      return;
    }

    if (!diff) {
      process.exit(0);
      return;
    }

    // Run fix detection heuristics
    const enabledSignals = new Set(config.autoLearning?.fixDetection?.signals ?? FIX_HEURISTICS.map(h => h.name));
    const detected: string[] = [];
    for (const heuristic of FIX_HEURISTICS) {
      if (enabledSignals.has(heuristic.name) && heuristic.test(diff)) {
        detected.push(heuristic.name);
      }
    }

    if (detected.length === 0) {
      process.exit(0);
      return;
    }

    // Record the fix detection
    const signal: FixSignal = {
      file: filePath,
      signals: detected,
      timestamp: new Date().toISOString(),
    };

    const flagPath = getSessionFlagPath(hookInput.session_id);
    appendFileSync(flagPath, JSON.stringify(signal) + '\n');

    // Count total fixes this session
    const lines = readFileSync(flagPath, 'utf-8').split('\n').filter(Boolean);
    if (lines.length === 1) {
      // First fix detected — output advisory
      writeHookContext(HOOK_EVENT, 
        `[Massu Auto-Learning] Bug fix detected in ${filePath} (signals: ${detected.join(', ')}). ` +
        `The auto-learning pipeline will prompt you at session end to create an incident report, ` +
        `derive a prevention rule, and add enforcement.`
      );
    }
  } catch (err) {
    // G-2: a hook may fail; it may not fail SILENTLY. Exit stays 0 (a Massu
    // bug must never block the user's session) but the failure now leaves a
    // durable trace: .massu/hook-failures.jsonl + stderr + hook_health.
    recordHookFailure('fix-detector', err);
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
