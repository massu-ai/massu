// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { createReadStream } from 'fs';
import { createInterface } from 'readline';

// ============================================================
// P2-001: JSONL Transcript Parser
// ============================================================

/**
 * Represents a parsed transcript entry.
 */
export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'system' | 'progress' | 'summary' | 'file-history-snapshot' | 'unknown';
  sessionId?: string;
  gitBranch?: string;
  timestamp?: string;
  uuid?: string;
  isMeta?: boolean;
  message?: TranscriptMessage;
  data?: Record<string, unknown>;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'system';
  content: TranscriptContentBlock[];
}

export type TranscriptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | TranscriptContentBlock[]; is_error?: boolean }
  | { type: string; [key: string]: unknown };

/**
 * Parsed tool call with input and result linked.
 */
export interface ParsedToolCall {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  timestamp?: string;
}

/**
 * File operation extracted from tool calls.
 */
export interface FileOperation {
  type: 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'delete';
  filePath: string;
  toolName: string;
}

/**
 * Extracted decision from assistant text.
 */
export interface ExtractedDecision {
  text: string;
  context: string;
}

/**
 * Extracted failed attempt from assistant text.
 */
export interface ExtractedFailedAttempt {
  text: string;
  context: string;
}

/**
 * Parse a JSONL transcript file line-by-line (streaming).
 * Handles 400MB+ files without loading entire file into memory.
 */
export async function parseTranscript(filePath: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      const entry = parseEntry(raw);
      if (entry) {
        entries.push(entry);
      }
    } catch (_e) {
      // Skip unparseable lines - defensive parsing
      continue;
    }
  }

  return entries;
}

/**
 * Parse a single JSONL entry into a TranscriptEntry.
 */
function parseEntry(raw: Record<string, unknown>): TranscriptEntry | null {
  const entryType = raw.type as string | undefined;
  if (!entryType) return null;

  const base: TranscriptEntry = {
    type: (['user', 'assistant', 'system', 'progress', 'summary', 'file-history-snapshot'].includes(entryType)
      ? entryType
      : 'unknown') as TranscriptEntry['type'],
    sessionId: raw.sessionId as string | undefined,
    gitBranch: raw.gitBranch as string | undefined,
    timestamp: raw.timestamp as string | undefined,
    uuid: raw.uuid as string | undefined,
  };

  if (raw.isMeta) {
    base.isMeta = true;
  }

  if (entryType === 'user' || entryType === 'assistant') {
    const msgRaw = raw.message as Record<string, unknown> | undefined;
    if (msgRaw) {
      base.message = {
        role: (msgRaw.role as string ?? entryType) as 'user' | 'assistant',
        content: normalizeContent(msgRaw.content),
      };
    }
  }

  if (entryType === 'progress') {
    base.data = raw.data as Record<string, unknown> | undefined;
  }

  return base;
}

/**
 * Normalize content to array of content blocks.
 */
function normalizeContent(content: unknown): TranscriptContentBlock[] {
  if (!content) return [];
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content.filter((block): block is TranscriptContentBlock =>
      typeof block === 'object' && block !== null && 'type' in block
    );
  }
  return [];
}

// ============================================================
// Extraction utilities
// ============================================================

/**
 * Extract all user messages from transcript entries.
 */
export function extractUserMessages(entries: TranscriptEntry[]): Array<{ text: string; timestamp?: string }> {
  const messages: Array<{ text: string; timestamp?: string }> = [];
  for (const entry of entries) {
    if (entry.type !== 'user' || !entry.message) continue;
    // Skip meta/system messages
    if (entry.isMeta) continue;

    const text = getTextFromContent(entry.message.content);
    if (text.trim()) {
      messages.push({ text: text.trim(), timestamp: entry.timestamp });
    }
  }
  return messages;
}

/**
 * Extract all assistant text messages.
 */
export function extractAssistantMessages(entries: TranscriptEntry[]): Array<{ text: string; timestamp?: string }> {
  const messages: Array<{ text: string; timestamp?: string }> = [];
  for (const entry of entries) {
    if (entry.type !== 'assistant' || !entry.message) continue;
    const text = getTextFromContent(entry.message.content);
    if (text.trim()) {
      messages.push({ text: text.trim(), timestamp: entry.timestamp });
    }
  }
  return messages;
}

/**
 * Extract all tool calls from transcript entries.
 */
export function extractToolCalls(entries: TranscriptEntry[]): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  const toolUseMap = new Map<string, ParsedToolCall>();

  for (const entry of entries) {
    if (!entry.message?.content) continue;

    for (const block of entry.message.content) {
      if (block.type === 'tool_use') {
        const tc: ParsedToolCall = {
          toolName: (block as { name: string }).name,
          toolUseId: (block as { id: string }).id,
          input: (block as { input: Record<string, unknown> }).input ?? {},
          timestamp: entry.timestamp,
        };
        toolCalls.push(tc);
        toolUseMap.set(tc.toolUseId, tc);
      } else if (block.type === 'tool_result') {
        const toolUseId = (block as { tool_use_id: string }).tool_use_id;
        const existing = toolUseMap.get(toolUseId);
        if (existing) {
          existing.result = getToolResultText(block);
          existing.isError = (block as { is_error?: boolean }).is_error ?? false;
        }
      }
    }
  }

  return toolCalls;
}

/**
 * Extract file operations from tool calls.
 */
export function extractFileOperations(toolCalls: ParsedToolCall[]): FileOperation[] {
  const ops: FileOperation[] = [];

  for (const tc of toolCalls) {
    switch (tc.toolName) {
      case 'Read': {
        const filePath = tc.input.file_path as string;
        if (filePath) ops.push({ type: 'read', filePath, toolName: 'Read' });
        break;
      }
      case 'Write': {
        const filePath = tc.input.file_path as string;
        if (filePath) ops.push({ type: 'write', filePath, toolName: 'Write' });
        break;
      }
      case 'Edit': {
        const filePath = tc.input.file_path as string;
        if (filePath) ops.push({ type: 'edit', filePath, toolName: 'Edit' });
        break;
      }
      case 'Glob': {
        ops.push({ type: 'glob', filePath: tc.input.pattern as string ?? '', toolName: 'Glob' });
        break;
      }
      case 'Grep': {
        ops.push({ type: 'grep', filePath: tc.input.path as string ?? '', toolName: 'Grep' });
        break;
      }
    }
  }

  return ops;
}

/**
 * Extract verification commands from tool calls.
 */
export function extractVerificationCommands(toolCalls: ParsedToolCall[]): Array<{
  vrType: string;
  command: string;
  result: string;
  passed: boolean;
}> {
  const verifications: Array<{
    vrType: string;
    command: string;
    result: string;
    passed: boolean;
  }> = [];

  for (const tc of toolCalls) {
    if (tc.toolName !== 'Bash') continue;
    const cmd = tc.input.command as string ?? '';
    const result = tc.result ?? '';

    // Pattern scanner
    if (cmd.includes('pattern-scanner')) {
      verifications.push({
        vrType: 'VR-PATTERN',
        command: cmd,
        result: result.slice(0, 500),
        passed: !result.includes('FAIL') && !result.includes('BLOCKED'),
      });
    }
    // Build
    if (cmd.includes('npm run build')) {
      verifications.push({
        vrType: 'VR-BUILD',
        command: cmd,
        result: result.slice(0, 500),
        passed: !tc.isError && !result.includes('error'),
      });
    }
    // Type check
    if (cmd.includes('tsc --noEmit')) {
      verifications.push({
        vrType: 'VR-TYPE',
        command: cmd,
        result: result.slice(0, 500),
        passed: !tc.isError && !result.includes('error'),
      });
    }
    // Tests
    if (cmd.includes('npm test') || cmd.includes('vitest run') || cmd.includes('vitest ')) {
      verifications.push({
        vrType: 'VR-TEST',
        command: cmd,
        result: result.slice(0, 500),
        passed: !tc.isError && !result.includes('FAIL'),
      });
    }
  }

  return verifications;
}

/**
 * Extract decisions from assistant text (heuristic).
 */
export function extractDecisions(entries: TranscriptEntry[]): ExtractedDecision[] {
  const decisions: ExtractedDecision[] = [];
  const decisionPatterns = /\b(decided|chose|chosen|decision|instead of|opted for|going with|approach:|strategy:)\b/i;

  for (const entry of entries) {
    if (entry.type !== 'assistant' || !entry.message) continue;
    const text = getTextFromContent(entry.message.content);
    if (!text) continue;

    // Split into sentences/paragraphs
    const paragraphs = text.split(/\n\n|\.\s+/);
    for (const para of paragraphs) {
      if (decisionPatterns.test(para) && para.length > 20 && para.length < 500) {
        decisions.push({
          text: para.trim().slice(0, 300),
          context: text.slice(0, 200),
        });
      }
    }
  }

  return decisions;
}

/**
 * Extract failed attempts from assistant text (heuristic).
 */
export function extractFailedAttempts(entries: TranscriptEntry[]): ExtractedFailedAttempt[] {
  const failures: ExtractedFailedAttempt[] = [];
  const failurePatterns = /\b(error|failed|doesn't work|didn't work|reverted|rolled back|bug|broken|issue:|problem:)\b/i;

  for (const entry of entries) {
    if (entry.type !== 'assistant' || !entry.message) continue;
    const text = getTextFromContent(entry.message.content);
    if (!text) continue;

    const paragraphs = text.split(/\n\n|\.\s+/);
    for (const para of paragraphs) {
      if (failurePatterns.test(para) && para.length > 20 && para.length < 500) {
        failures.push({
          text: para.trim().slice(0, 300),
          context: text.slice(0, 200),
        });
      }
    }
  }

  return failures;
}

/**
 * Parse a JSONL transcript file starting from a specific line (for incremental parsing).
 * Skips the first `startLine` lines and returns entries from the rest.
 */
export async function parseTranscriptFrom(filePath: string, startLine: number): Promise<{ entries: TranscriptEntry[]; totalLines: number }> {
  const entries: TranscriptEntry[] = [];
  let lineNumber = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNumber++;
    if (lineNumber <= startLine) continue;

    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      const entry = parseEntry(raw);
      if (entry) {
        entries.push(entry);
      }
    } catch (_e) {
      // Skip unparseable lines
      continue;
    }
  }

  return { entries, totalLines: lineNumber };
}

/**
 * Estimate token count for a text string.
 * Approximation: chars / 4.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Get the last assistant message from entries (useful for session summaries).
 */
export function getLastAssistantMessage(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'assistant' && entries[i].message) {
      const text = getTextFromContent(entries[i].message!.content);
      if (text.trim()) return text.trim();
    }
  }
  return null;
}

// ============================================================
// Helpers
// ============================================================

function getTextFromContent(content: TranscriptContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function getToolResultText(block: TranscriptContentBlock): string {
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
