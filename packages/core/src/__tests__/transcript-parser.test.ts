// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  parseTranscript,
  extractUserMessages,
  extractAssistantMessages,
  extractToolCalls,
  extractFileOperations,
  extractVerificationCommands,
  extractDecisions,
  extractFailedAttempts,
  estimateTokens,
  getLastAssistantMessage,
} from '../transcript-parser.ts';

// P7-002: Transcript Parser Tests

const TEST_JSONL = resolve(__dirname, '../test-transcript.jsonl');

function writeTestTranscript(entries: Record<string, unknown>[]): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n');
  writeFileSync(TEST_JSONL, content, 'utf-8');
}

function cleanup(): void {
  if (existsSync(TEST_JSONL)) unlinkSync(TEST_JSONL);
}

describe('Transcript Parser', () => {
  afterEach(cleanup);

  describe('parseTranscript', () => {
    it('parses JSONL entries', async () => {
      writeTestTranscript([
        { type: 'user', sessionId: 'sess-1', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
        { type: 'assistant', sessionId: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] } },
      ]);

      const entries = await parseTranscript(TEST_JSONL);
      expect(entries.length).toBe(2);
      expect(entries[0].type).toBe('user');
      expect(entries[1].type).toBe('assistant');
    });

    it('handles malformed lines gracefully', async () => {
      writeFileSync(TEST_JSONL, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"valid"}]}}\n{invalid json\n', 'utf-8');
      const entries = await parseTranscript(TEST_JSONL);
      expect(entries.length).toBe(1);
    });

    it('handles file-history-snapshot entries', async () => {
      writeTestTranscript([
        { type: 'file-history-snapshot', snapshot: {} },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      ]);
      const entries = await parseTranscript(TEST_JSONL);
      expect(entries.length).toBe(2);
      expect(entries[0].type).toBe('file-history-snapshot');
    });
  });

  describe('extractUserMessages', () => {
    it('extracts user messages, skipping meta', async () => {
      writeTestTranscript([
        { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'meta msg' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'real message' }] } },
      ]);
      const entries = await parseTranscript(TEST_JSONL);
      const messages = extractUserMessages(entries);
      expect(messages.length).toBe(1);
      expect(messages[0].text).toBe('real message');
    });
  });

  describe('extractToolCalls', () => {
    it('extracts tool_use and tool_result', async () => {
      writeTestTranscript([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'All tests passed', is_error: false },
            ],
          },
        },
      ]);
      const entries = await parseTranscript(TEST_JSONL);
      const toolCalls = extractToolCalls(entries);
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].toolName).toBe('Bash');
      expect(toolCalls[0].result).toBe('All tests passed');
      expect(toolCalls[0].isError).toBe(false);
    });
  });

  describe('extractFileOperations', () => {
    it('extracts file operations from tool calls', () => {
      const ops = extractFileOperations([
        { toolName: 'Read', toolUseId: '1', input: { file_path: '/path/file.ts' } },
        { toolName: 'Write', toolUseId: '2', input: { file_path: '/path/new.ts' } },
        { toolName: 'Edit', toolUseId: '3', input: { file_path: '/path/edit.ts' } },
        { toolName: 'Glob', toolUseId: '4', input: { pattern: '**/*.ts' } },
      ]);
      expect(ops.length).toBe(4);
      expect(ops[0].type).toBe('read');
      expect(ops[1].type).toBe('write');
      expect(ops[2].type).toBe('edit');
      expect(ops[3].type).toBe('glob');
    });
  });

  describe('extractVerificationCommands', () => {
    it('detects verification commands', () => {
      const verifications = extractVerificationCommands([
        { toolName: 'Bash', toolUseId: '1', input: { command: 'npm run build' }, result: 'Build succeeded' },
        { toolName: 'Bash', toolUseId: '2', input: { command: 'npm test' }, result: 'All passed', isError: false },
        { toolName: 'Bash', toolUseId: '3', input: { command: './scripts/pattern-scanner.sh' }, result: 'PASS' },
      ]);
      expect(verifications.length).toBe(3);
      expect(verifications[0].vrType).toBe('VR-BUILD');
      expect(verifications[0].passed).toBe(true);
      expect(verifications[1].vrType).toBe('VR-TEST');
      expect(verifications[2].vrType).toBe('VR-PATTERN');
    });
  });

  describe('extractDecisions', () => {
    it('extracts decision-like text', async () => {
      writeTestTranscript([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I decided to use esbuild instead of tsc for better performance.' }],
          },
        },
      ]);
      const entries = await parseTranscript(TEST_JSONL);
      const decisions = extractDecisions(entries);
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions[0].text).toContain('decided');
    });
  });

  describe('extractFailedAttempts', () => {
    it('extracts failure-like text', async () => {
      writeTestTranscript([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'The regex approach failed because it cannot handle nested braces properly.' }],
          },
        },
      ]);
      const entries = await parseTranscript(TEST_JSONL);
      const failures = extractFailedAttempts(entries);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0].text).toContain('failed');
    });
  });

  describe('estimateTokens', () => {
    it('approximates tokens as chars/4', () => {
      expect(estimateTokens('hello')).toBe(2); // 5/4 = 1.25 -> ceil = 2
      expect(estimateTokens('a'.repeat(100))).toBe(25);
    });
  });

  describe('getLastAssistantMessage', () => {
    it('returns last assistant text', async () => {
      writeTestTranscript([
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Final response' }] } },
      ]);
      const entries = await parseTranscript(TEST_JSONL);
      const last = getLastAssistantMessage(entries);
      expect(last).toBe('Final response');
    });
  });
});
