// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P1-001 (plan-living-memory-slice-2a-embedder): pure-JS BERT WordPiece
// tokenizer. ZERO dependencies.
//
// Implements the standard BERT uncased pipeline:
//   1. BasicTokenizer: clean text, handle CJK, split on whitespace +
//      punctuation, lowercase, strip accents.
//   2. WordpieceTokenizer: greedy longest-match-first against the vocab, with
//      "##" continuation for subword pieces.
//   3. Add [CLS] ... [SEP]; produce input_ids / attention_mask / token_type_ids.
//
// This is the Tier-1 (bundled pure-WASM) embedder's tokenizer — it must add NO
// native module. The vocab is loaded from the bundled asset dir (vocab.txt).
// ============================================================

import { readFileSync } from 'fs';

const UNK = '[UNK]';
const CLS = '[CLS]';
const SEP = '[SEP]';

export type Vocab = Map<string, number>;

export interface EncodeResult {
  tokens: string[];
  input_ids: number[];
  attention_mask: number[];
  token_type_ids: number[];
}

/** Load a BERT vocab.txt (one token per line; line index = token id). */
export function loadVocab(vocabPath: string): Vocab {
  const lines = readFileSync(vocabPath, 'utf-8').split('\n');
  const vocab: Vocab = new Map();
  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i].replace(/\r$/, '');
    if (tok.length === 0 && i === lines.length - 1) continue; // trailing newline
    vocab.set(tok, i);
  }
  return vocab;
}

// --- character classification helpers (mirror HF BasicTokenizer) ---
function isWhitespace(ch: string): boolean {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return true;
  const cp = ch.codePointAt(0)!;
  return (
    cp === 0x00a0 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000 ||
    cp === 0xfeff
  );
}

function isControl(ch: string): boolean {
  if (ch === '\t' || ch === '\n' || ch === '\r') return false;
  const cp = ch.codePointAt(0)!;
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  // ASCII punctuation ranges treated as punctuation by BERT
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  )
    return true;
  // Unicode punctuation / symbol via regex property
  return /\p{P}|\p{S}/u.test(ch);
}

function isCJK(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function stripAccents(text: string): string {
  // NFD then drop combining marks (Mn) — BERT do_lower_case strips accents.
  return text.normalize('NFD').replace(/\p{Mn}/gu, '');
}

function basicTokenize(text: string): string[] {
  // 1. clean: remove control chars & replacement char, normalize whitespace;
  //    add spaces around CJK characters.
  let cleaned = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
    if (isWhitespace(ch)) {
      cleaned += ' ';
      continue;
    }
    if (isCJK(cp)) {
      cleaned += ' ' + ch + ' ';
      continue;
    }
    cleaned += ch;
  }
  // 2. whitespace split
  const rawTokens = cleaned.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let tok of rawTokens) {
    // lowercase + strip accents (uncased model)
    tok = stripAccents(tok.toLowerCase());
    // 3. split on punctuation, keeping punctuation as its own token
    let cur = '';
    for (const ch of tok) {
      if (isPunctuation(ch)) {
        if (cur) {
          out.push(cur);
          cur = '';
        }
        out.push(ch);
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function wordpieceTokenize(token: string, vocab: Vocab, maxChars = 100): string[] {
  if (token.length > maxChars) return [UNK];
  const chars = Array.from(token);
  const subTokens: string[] = [];
  let start = 0;
  let bad = false;
  while (start < chars.length) {
    let end = chars.length;
    let curSub: string | null = null;
    while (start < end) {
      let substr = chars.slice(start, end).join('');
      if (start > 0) substr = '##' + substr;
      if (vocab.has(substr)) {
        curSub = substr;
        break;
      }
      end -= 1;
    }
    if (curSub === null) {
      bad = true;
      break;
    }
    subTokens.push(curSub);
    start = end;
  }
  return bad ? [UNK] : subTokens;
}

/**
 * Encode a string into BERT input tensors (WordPiece). Adds [CLS] and [SEP],
 * truncates to `maxLen` (default 256) leaving room for the two special tokens.
 */
export function encode(text: string, vocab: Vocab, opts: { maxLen?: number } = {}): EncodeResult {
  const maxLen = opts.maxLen ?? 256;
  const basic = basicTokenize(text);
  const wpTokens: string[] = [];
  for (const t of basic) {
    for (const sub of wordpieceTokenize(t, vocab)) wpTokens.push(sub);
  }
  // truncate to leave room for [CLS] and [SEP]
  const truncated = wpTokens.slice(0, maxLen - 2);
  const tokens = [CLS, ...truncated, SEP];
  const unkId = vocab.get(UNK) ?? 100;
  const input_ids = tokens.map((t) => vocab.get(t) ?? unkId);
  const attention_mask = tokens.map(() => 1);
  const token_type_ids = tokens.map(() => 0);
  return { tokens, input_ids, attention_mask, token_type_ids };
}
