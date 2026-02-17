#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// PostToolUse Hook: Cost Tracker
// Estimates token usage from tool input/output sizes and
// records cost events for per-session cost intelligence.
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

// Approximate: 4 characters per token (industry rule of thumb)
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, tool_name, tool_input, tool_response } = hookInput;

    const inputStr = JSON.stringify(tool_input);
    const estimatedInputTokens = estimateTokens(inputStr);
    const estimatedOutputTokens = estimateTokens(tool_response ?? '');

    const db = getMemoryDb();
    try {
      db.prepare(`
        INSERT INTO tool_cost_events (session_id, tool_name, estimated_input_tokens, estimated_output_tokens, model)
        VALUES (?, ?, ?, ?, ?)
      `).run(session_id, tool_name, estimatedInputTokens, estimatedOutputTokens, '');
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
