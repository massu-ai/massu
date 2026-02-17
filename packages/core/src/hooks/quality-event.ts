#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PostToolUse Hook: Quality Event Recorder
// Parses tool responses for quality signals (test failures,
// type errors, build failures) and records them for analytics.
// Must complete in <500ms.
// ============================================================

import { getMemoryDb } from '../memory-db.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
}

interface QualitySignal {
  event_type: string;
  details: string;
}

const TEST_FAILURE_PATTERNS: RegExp[] = [
  /\bFAIL\b/,
  /✗/,
  /\bfailed\b/i,
  /\bError:/,
];

const TYPE_ERROR_PATTERNS: RegExp[] = [
  /error TS\d+/,
  /\btsc\b.*error/i,
];

const BUILD_FAILURE_PATTERNS: RegExp[] = [
  /Build failed/i,
  /\besbuild\b.*error/i,
  /\besbuild\b.*failed/i,
];

function detectQualitySignals(toolResponse: string): QualitySignal[] {
  const signals: QualitySignal[] = [];
  const response = toolResponse ?? '';

  for (const pattern of TEST_FAILURE_PATTERNS) {
    if (pattern.test(response)) {
      const match = response.match(pattern);
      signals.push({
        event_type: 'test_failure',
        details: match ? match[0].slice(0, 500) : 'Test failure detected',
      });
      break; // One signal per category
    }
  }

  for (const pattern of TYPE_ERROR_PATTERNS) {
    if (pattern.test(response)) {
      const match = response.match(pattern);
      signals.push({
        event_type: 'type_error',
        details: match ? match[0].slice(0, 500) : 'TypeScript error detected',
      });
      break;
    }
  }

  for (const pattern of BUILD_FAILURE_PATTERNS) {
    if (pattern.test(response)) {
      const match = response.match(pattern);
      signals.push({
        event_type: 'build_failure',
        details: match ? match[0].slice(0, 500) : 'Build failure detected',
      });
      break;
    }
  }

  return signals;
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, tool_name, tool_response } = hookInput;

    const signals = detectQualitySignals(tool_response);
    if (signals.length === 0) {
      process.exit(0);
      return;
    }

    const db = getMemoryDb();
    try {
      const stmt = db.prepare(`
        INSERT INTO quality_events (session_id, event_type, tool_name, details)
        VALUES (?, ?, ?, ?)
      `);
      for (const signal of signals) {
        stmt.run(session_id, signal.event_type, tool_name, signal.details);
      }
    } finally {
      db.close();
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
