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
import { toolResponseText, type RawToolResponse } from './lib/tool-response.ts';
import { recordHookFailure } from './lib/hook-failure-signal.ts';
import { nowIso } from '../lib/timestamps.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  /**
   * S-1 (plan-silent-failure-remediation): was declared `string`. It is an OBJECT
   * 97.6% of the time. Same lie, same silent death as post-tool-use. Normalize via
   * the ONE parser — never narrow this back to `string`.
   */
  tool_response: RawToolResponse;
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
    // S-1: an OBJECT was being passed to estimateTokens — it did not crash, it
    // silently produced a WRONG token count. A quiet wrong number, not a loud failure.
    const estimatedOutputTokens = estimateTokens(toolResponseText(tool_response));

    const db = getMemoryDb();
    try {
      db.prepare(`
        INSERT INTO tool_cost_events (session_id, tool_name, estimated_input_tokens, estimated_output_tokens, model, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(session_id, tool_name, estimatedInputTokens, estimatedOutputTokens, '', nowIso());
    } finally {
      db.close();
    }
  } catch (err) {
    // G-2: a hook may fail; it may not fail SILENTLY. Exit stays 0 (a Massu
    // bug must never block the user's session) but the failure now leaves a
    // durable trace: .massu/hook-failures.jsonl + stderr + hook_health.
    recordHookFailure('cost-tracker', err);
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
