// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P1-001 (plan-living-memory-slice-2a-embedder): pure-JS WordPiece tokenizer.
 * Verifies canonical BERT-uncased ids, ## continuation, special tokens.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { loadVocab, encode } from '../memory-embedder-tokenizer.ts';

const vocabPath = resolve(__dirname, '..', '..', 'assets', 'embedder', 'vocab.txt');
const vocab = loadVocab(vocabPath);

describe('P1-001: WordPiece tokenizer', () => {
  it('loads the standard BERT vocab with correct special-token ids', () => {
    expect(vocab.get('[PAD]')).toBe(0);
    expect(vocab.get('[UNK]')).toBe(100);
    expect(vocab.get('[CLS]')).toBe(101);
    expect(vocab.get('[SEP]')).toBe(102);
    expect(vocab.get('[MASK]')).toBe(103);
    expect(vocab.size).toBe(30522);
  });

  it('"hello world" → canonical ids [101,7592,2088,102]', () => {
    const { input_ids } = encode('hello world', vocab);
    expect(input_ids).toEqual([101, 7592, 2088, 102]);
  });

  it('produces matching attention_mask / token_type_ids', () => {
    const { input_ids, attention_mask, token_type_ids } = encode('hello world', vocab);
    expect(attention_mask).toEqual(input_ids.map(() => 1));
    expect(token_type_ids).toEqual(input_ids.map(() => 0));
  });

  it('"unbelievably" uses ## WordPiece continuation', () => {
    const { tokens } = encode('unbelievably', vocab);
    // strip [CLS]/[SEP]
    const pieces = tokens.slice(1, -1);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0]).toBe('un');
    // every non-first piece is a ## continuation
    expect(pieces.slice(1).every((p) => p.startsWith('##'))).toBe(true);
  });

  it('lowercases + splits punctuation as its own token', () => {
    const { tokens } = encode('Quarterly Financial Report!', vocab);
    expect(tokens[0]).toBe('[CLS]');
    expect(tokens[tokens.length - 1]).toBe('[SEP]');
    expect(tokens).toContain('quarterly');
    expect(tokens).toContain('!');
  });

  it('always wraps with [CLS] … [SEP]', () => {
    const { tokens } = encode('anything at all', vocab);
    expect(tokens[0]).toBe('[CLS]');
    expect(tokens[tokens.length - 1]).toBe('[SEP]');
  });

  it('truncates to maxLen leaving room for the two special tokens', () => {
    const long = Array.from({ length: 500 }, () => 'word').join(' ');
    const { input_ids } = encode(long, vocab, { maxLen: 16 });
    expect(input_ids.length).toBe(16);
    expect(input_ids[0]).toBe(101);
    expect(input_ids[input_ids.length - 1]).toBe(102);
  });
});
