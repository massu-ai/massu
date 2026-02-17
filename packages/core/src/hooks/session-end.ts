#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-003: Stop (Session End) Hook
// Generates session summary and archives CURRENT.md.
// Dependencies: P1-002, P5-001, P5-002
// ============================================================

import { getMemoryDb, endSession, addSummary, getRecentObservations, createSession, addConversationTurn, addToolCallDetail, getLastProcessedLine, setLastProcessedLine } from '../memory-db.ts';
import { generateCurrentMd } from '../session-state-generator.ts';
import { archiveAndRegenerate } from '../session-archiver.ts';
import { parseTranscriptFrom, extractUserMessages, extractAssistantMessages, extractToolCalls, estimateTokens } from '../transcript-parser.ts';
import { syncToCloud, drainSyncQueue } from '../cloud-sync.ts';
import type { SyncPayload } from '../cloud-sync.ts';
import type { SessionSummary } from '../memory-db.ts';
import type { TranscriptEntry, TranscriptContentBlock } from '../transcript-parser.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id } = hookInput;

    const db = getMemoryDb();
    try {
      // Ensure session exists
      createSession(db, session_id);

      // 1. Get all observations for this session
      const observations = db.prepare(
        'SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC'
      ).all(session_id) as Array<Record<string, unknown>>;

      // 2. Get user prompts
      const prompts = db.prepare(
        'SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC'
      ).all(session_id) as Array<{ prompt_text: string }>;

      // 3. Generate structured summary from observations
      const summary = buildSummaryFromObservations(observations, prompts);

      // 4. Insert summary
      addSummary(db, session_id, summary);

      // 4.5. Capture conversation turns and tool call details from transcript (P2-002)
      try {
        await captureConversationData(db, session_id, hookInput.transcript_path);
      } catch (_captureErr) {
        // Best-effort: never block session end
      }

      // 5. Mark session as completed
      endSession(db, session_id, 'completed');

      // 6. Auto-generate CURRENT.md and archive old one
      archiveAndRegenerate(db, session_id);

      // 7. Cloud sync (if enabled)
      // Order: drain pending queue first, then sync current session
      try {
        // 7a. Drain pending sync queue
        await drainSyncQueue(db);

        // 7b. Sync current session data
        const syncPayload = buildSyncPayload(session_id, observations, summary);
        const result = await syncToCloud(db, syncPayload);
        if (!result.success && result.error) {
          // Payload already enqueued by syncToCloud on failure
        }
      } catch (_syncErr) {
        // Non-blocking: sync failure never blocks session end
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
 * Build a sync payload from the current session data.
 */
function buildSyncPayload(
  sessionId: string,
  observations: Array<Record<string, unknown>>,
  summary: SessionSummary
): SyncPayload {
  return {
    sessions: [{
      local_session_id: sessionId,
      summary: summary.request ?? undefined,
      started_at: undefined, // Will be filled from session data if available
      ended_at: new Date().toISOString(),
      turns: 0,
      tokens_used: 0,
      estimated_cost: 0,
      tools_used: [],
    }],
    observations: observations.map((o, idx) => ({
      local_observation_id: `${sessionId}_obs_${idx}`,
      session_id: sessionId,
      type: o.type as string,
      content: (o.title as string) + (o.detail ? `: ${o.detail}` : ''),
      importance: (o.importance as number) ?? 3,
      file_path: undefined,
    })),
  };
}

function buildSummaryFromObservations(
  observations: Array<Record<string, unknown>>,
  prompts: Array<{ prompt_text: string }>
): SessionSummary {
  // request = first user prompt
  const request = prompts[0]?.prompt_text?.slice(0, 500) ?? undefined;

  // investigated = discovery observations
  const discoveries = observations
    .filter(o => o.type === 'discovery')
    .map(o => (o.title as string))
    .join('; ');

  // decisions = decision observations
  const decisions = observations
    .filter(o => o.type === 'decision')
    .map(o => `- ${o.title}`)
    .join('\n');

  // completed = feature/bugfix/refactor observations
  const completed = observations
    .filter(o => ['feature', 'bugfix', 'refactor'].includes(o.type as string))
    .map(o => `- ${o.title}`)
    .join('\n');

  // failed_attempts = failed_attempt observations
  const failedAttempts = observations
    .filter(o => o.type === 'failed_attempt')
    .map(o => `- ${o.title}`)
    .join('\n');

  // next_steps = observations from last 10% if no completion markers
  const lastTenPercent = observations.slice(Math.floor(observations.length * 0.9));
  const hasCompletion = completed.length > 0;
  const nextSteps = hasCompletion ? undefined : lastTenPercent
    .map(o => `- [${o.type}] ${o.title}`)
    .join('\n');

  // files created/modified
  const filesCreated: string[] = [];
  const filesModified: string[] = [];
  for (const o of observations) {
    if (o.type !== 'file_change') continue;
    const files = safeParseJson(o.files_involved as string, []) as string[];
    const title = o.title as string;
    if (title.startsWith('Created') || title.startsWith('Created/wrote')) {
      filesCreated.push(...files);
    } else if (title.startsWith('Edited')) {
      filesModified.push(...files);
    }
  }

  // verification results
  const verificationResults: Record<string, string> = {};
  for (const o of observations) {
    if (o.type !== 'vr_check') continue;
    const vrType = o.vr_type as string;
    const passed = (o.title as string).includes('PASS');
    if (vrType) verificationResults[vrType] = passed ? 'PASS' : 'FAIL';
  }

  // plan progress
  const planProgress: Record<string, string> = {};
  for (const o of observations) {
    if (!o.plan_item) continue;
    planProgress[o.plan_item as string] = 'in_progress';
  }

  return {
    request,
    investigated: discoveries || undefined,
    decisions: decisions || undefined,
    completed: completed || undefined,
    failedAttempts: failedAttempts || undefined,
    nextSteps,
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    verificationResults,
    planProgress,
  };
}

function safeParseJson(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
}

/**
 * Capture conversation turns and tool call details from the JSONL transcript.
 * Uses incremental parsing to only process new lines since last invocation.
 * P2-002 + P2-003: Stop hook conversation capture with state tracking.
 */
async function captureConversationData(
  db: import('better-sqlite3').Database,
  sessionId: string,
  transcriptPath: string
): Promise<void> {
  if (!transcriptPath) return;

  // P2-003: Incremental parsing - only process new lines
  const lastLine = getLastProcessedLine(db, sessionId);
  const { entries, totalLines } = await parseTranscriptFrom(transcriptPath, lastLine);

  if (entries.length === 0) {
    setLastProcessedLine(db, sessionId, totalLines);
    return;
  }

  // Group entries into turns (user prompt -> assistant response(s) with tool calls)
  const turns = groupEntriesIntoTurns(entries);

  // Use a transaction for batch insert (P4-002: performance safeguard)
  const insertTurns = db.transaction(() => {
    // Determine starting turn number (continue from existing turns)
    const existingMax = db.prepare(
      'SELECT MAX(turn_number) as max_turn FROM conversation_turns WHERE session_id = ?'
    ).get(sessionId) as { max_turn: number | null };
    let turnNumber = (existingMax.max_turn ?? 0) + 1;

    for (const turn of turns) {
      const toolCallSummaries = turn.toolCalls.map(tc => ({
        name: tc.toolName,
        input_summary: summarizeToolInput(tc.toolName, tc.input).slice(0, 200),
        is_error: tc.isError ?? false,
      }));

      // P4-001: assistant_response capped at 10000 chars
      const assistantText = turn.assistantText?.slice(0, 10000) ?? null;

      addConversationTurn(
        db, sessionId, turnNumber,
        turn.userPrompt,
        assistantText,
        toolCallSummaries.length > 0 ? JSON.stringify(toolCallSummaries) : null,
        turn.toolCalls.length,
        estimateTokens(turn.userPrompt),
        assistantText ? estimateTokens(assistantText) : 0
      );

      // Insert tool call details for this turn (all tools, no filtering)
      for (const tc of turn.toolCalls) {
        const inputStr = JSON.stringify(tc.input);
        const outputStr = tc.result ?? '';
        const files = extractFilesFromToolCall(tc.toolName, tc.input);

        addToolCallDetail(
          db, sessionId, turnNumber,
          tc.toolName,
          summarizeToolInput(tc.toolName, tc.input),
          inputStr.length,
          outputStr.length,
          !(tc.isError ?? false),
          files.length > 0 ? files : undefined
        );
      }

      turnNumber++;
    }
  });

  insertTurns();

  // Update last processed line
  setLastProcessedLine(db, sessionId, totalLines);
}

interface ConversationTurn {
  userPrompt: string;
  assistantText: string | null;
  toolCalls: Array<{
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  }>;
}

/**
 * Group transcript entries into conversation turns.
 * A turn starts with a user message and includes all subsequent assistant messages
 * and tool calls until the next user message.
 */
function groupEntriesIntoTurns(entries: TranscriptEntry[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;
  const toolUseMap = new Map<string, { toolName: string; toolUseId: string; input: Record<string, unknown>; result?: string; isError?: boolean }>();

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message && !entry.isMeta) {
      // Start a new turn
      if (currentTurn) {
        turns.push(currentTurn);
      }
      const text = getTextFromBlocks(entry.message.content);
      if (text.trim()) {
        currentTurn = {
          userPrompt: text.trim(),
          assistantText: null,
          toolCalls: [],
        };
      }
    } else if (entry.type === 'assistant' && entry.message && currentTurn) {
      // Add assistant text
      const text = getTextFromBlocks(entry.message.content);
      if (text.trim()) {
        currentTurn.assistantText = currentTurn.assistantText
          ? currentTurn.assistantText + '\n' + text.trim()
          : text.trim();
      }

      // Extract tool calls from this assistant message
      for (const block of entry.message.content) {
        if (block.type === 'tool_use') {
          const tc = {
            toolName: (block as { name: string }).name,
            toolUseId: (block as { id: string }).id,
            input: (block as { input: Record<string, unknown> }).input ?? {},
          };
          currentTurn.toolCalls.push(tc);
          toolUseMap.set(tc.toolUseId, tc);
        } else if (block.type === 'tool_result') {
          const toolUseId = (block as { tool_use_id: string }).tool_use_id;
          const existing = toolUseMap.get(toolUseId);
          if (existing) {
            existing.result = getToolResultFromBlock(block);
            existing.isError = (block as { is_error?: boolean }).is_error ?? false;
          }
        }
      }
    }
  }

  // Push the last turn
  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}

function getTextFromBlocks(content: TranscriptContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function getToolResultFromBlock(block: TranscriptContentBlock): string {
  const content = (block as { content: string | TranscriptContentBlock[] }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => typeof b === 'object' && b !== null && b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Create a concise summary of tool input for the tool_input_summary column.
 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `Read ${input.file_path ?? ''}`;
    case 'Write':
      return `Write ${input.file_path ?? ''}`;
    case 'Edit':
      return `Edit ${input.file_path ?? ''}`;
    case 'Bash':
      return `$ ${(input.command as string ?? '').slice(0, 200)}`;
    case 'Grep':
      return `Grep "${input.pattern ?? ''}" in ${input.path ?? '.'}`;
    case 'Glob':
      return `Glob "${input.pattern ?? ''}" in ${input.path ?? '.'}`;
    case 'Task':
      return `Task: ${(input.description as string ?? '').slice(0, 100)}`;
    case 'WebFetch':
      return `Fetch ${input.url ?? ''}`;
    case 'WebSearch':
      return `Search "${input.query ?? ''}"`;
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 200)}`;
  }
}

/**
 * Extract file paths from a tool call input.
 */
function extractFilesFromToolCall(toolName: string, input: Record<string, unknown>): string[] {
  const filePath = input.file_path as string | undefined;
  if (filePath) return [filePath];

  const path = input.path as string | undefined;
  if (path && !path.startsWith('.') && toolName !== 'Grep') return [path];

  return [];
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 5000);
  });
}

main();
