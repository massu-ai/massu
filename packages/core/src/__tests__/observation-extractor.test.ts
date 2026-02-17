// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import {
  isNoisyToolCall,
  extractObservationsFromEntries,
  classifyRealTimeToolCall,
  detectPlanProgress,
} from '../observation-extractor.ts';
import type { ParsedToolCall, TranscriptEntry } from '../transcript-parser.ts';

// P7-003: Observation Extractor Tests

describe('Observation Extractor', () => {
  describe('isNoisyToolCall', () => {
    it('filters Glob calls', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({
        toolName: 'Glob', toolUseId: '1', input: { pattern: '**/*.ts' }, result: 'file1.ts\nfile2.ts',
      }, seenReads)).toBe(true);
    });

    it('filters Grep calls', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({
        toolName: 'Grep', toolUseId: '1', input: { pattern: 'test' }, result: 'match',
      }, seenReads)).toBe(true);
    });

    it('filters duplicate Read calls', () => {
      const seenReads = new Set<string>();
      const readCall: ParsedToolCall = {
        toolName: 'Read', toolUseId: '1', input: { file_path: '/path/file.ts' }, result: 'content',
      };
      expect(isNoisyToolCall(readCall, seenReads)).toBe(false); // First read is kept
      expect(isNoisyToolCall({ ...readCall, toolUseId: '2' }, seenReads)).toBe(true); // Duplicate filtered
    });

    it('filters node_modules reads', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({
        toolName: 'Read', toolUseId: '1', input: { file_path: '/path/node_modules/pkg/index.js' }, result: 'code',
      }, seenReads)).toBe(true);
    });

    it('filters trivial Bash commands', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({
        toolName: 'Bash', toolUseId: '1', input: { command: 'ls -la' }, result: 'files',
      }, seenReads)).toBe(true);
      expect(isNoisyToolCall({
        toolName: 'Bash', toolUseId: '2', input: { command: 'pwd' }, result: '/path',
      }, seenReads)).toBe(true);
    });

    it('keeps Edit/Write calls', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({
        toolName: 'Edit', toolUseId: '1', input: { file_path: '/path/file.ts' }, result: 'edited',
      }, seenReads)).toBe(false);
      expect(isNoisyToolCall({
        toolName: 'Write', toolUseId: '2', input: { file_path: '/path/new.ts' }, result: 'written',
      }, seenReads)).toBe(false);
    });

    it('filters empty results', () => {
      const seenReads = new Set<string>();
      expect(isNoisyToolCall({
        toolName: 'Bash', toolUseId: '1', input: { command: 'npm install' }, result: '',
      }, seenReads)).toBe(true);
    });
  });

  describe('classifyRealTimeToolCall', () => {
    it('classifies Edit as file_change', () => {
      const seenReads = new Set<string>();
      const result = classifyRealTimeToolCall('Edit', { file_path: '/path/file.ts' }, 'success', seenReads);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('file_change');
      expect(result!.title).toContain('Edited');
    });

    it('classifies Write as file_change', () => {
      const seenReads = new Set<string>();
      const result = classifyRealTimeToolCall('Write', { file_path: '/path/new.ts' }, 'created', seenReads);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('file_change');
      expect(result!.title).toContain('Created');
    });

    it('classifies npm test as vr_check', () => {
      const seenReads = new Set<string>();
      const result = classifyRealTimeToolCall('Bash', { command: 'npm test' }, 'All 50 tests passed', seenReads);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('vr_check');
      expect(result!.title).toContain('PASS');
    });

    it('classifies git commit as feature/bugfix', () => {
      const seenReads = new Set<string>();
      const result = classifyRealTimeToolCall('Bash', { command: 'git commit -m "feat: add new feature"' }, 'committed', seenReads);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('feature');
    });

    it('returns null for noisy calls', () => {
      const seenReads = new Set<string>();
      const result = classifyRealTimeToolCall('Glob', { pattern: '**/*.ts' }, 'files', seenReads);
      expect(result).toBeNull();
    });
  });

  describe('detectPlanProgress', () => {
    it('detects plan items marked complete', () => {
      const progress = detectPlanProgress('P1-001: COMPLETE\nP2-003: PASS');
      expect(progress.length).toBe(2);
      expect(progress[0].planItem).toBe('P1-001');
      expect(progress[0].status).toBe('complete');
    });

    it('returns empty for no matches', () => {
      const progress = detectPlanProgress('No plan items here');
      expect(progress.length).toBe(0);
    });
  });

  describe('extractObservationsFromEntries', () => {
    it('extracts observations from a mix of entries', () => {
      const entries: TranscriptEntry[] = [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: '/path/new.ts', content: 'code' } },
            ],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'File created successfully' },
            ],
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I decided to use esbuild for better performance.' },
            ],
          },
        },
      ];

      const observations = extractObservationsFromEntries(entries);
      expect(observations.length).toBeGreaterThanOrEqual(2); // file_change + decision
      const types = observations.map(o => o.type);
      expect(types).toContain('file_change');
      expect(types).toContain('decision');
    });
  });
});
