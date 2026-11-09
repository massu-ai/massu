// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * WHICH PART OF AN ADDED LINE IS CODE?
 *
 * The auto-learning detectors score a git diff for fix-shaped lines (`try`, `catch`,
 * `raise`, …). Matched against RAW text, the keyword is found wherever it appears,
 * including inside string literals and comments. Measured 2026-11-08 on another
 * repository: the one file that tripped the Stop hook was a slide-deck builder, and half
 * of its hits were slide copy inside Python strings (`"The catch"`). Nothing in a raw
 * regex can tell `raise ValueError(...)` from `"…and raise the bar"`.
 *
 * So this is a LEXER, not a regex. It walks each line with a small state machine (quote
 * character, escapes, triple quotes, template literals and their `${…}` holes, block
 * comments, JS regex literals, Rust char-vs-lifetime) and replaces every non-code
 * character with a space. The projection keeps the line's LENGTH and its word boundaries,
 * so a keyword regex run over it matches exactly the keywords that sit in code.
 *
 * State carries ACROSS lines, because a docstring or a template literal does. When the
 * caller can supply the whole post-image file, every line is classified exactly. When it
 * cannot, each hunk is lexed on its own from a code-state start — see {@link DiffFileView.mode}.
 *
 * Unknown languages are NOT guessed at. A path whose extension has no {@link LexSpec}
 * returns its lines unchanged (the behaviour before this module existed) and is reported
 * as `mode: 'raw'`, so the caller can say which files were judged without a lexer.
 *
 * The lexer does not carry: heredocs, Rust raw strings (`r#"…"#`), C# verbatim strings,
 * Ruby `=begin` blocks, or nested Swift block comments. Each degrades to "this span is
 * code", which is the pre-existing behaviour, never to "this code is a string".
 */

import { extname } from 'path';

interface StringRule {
  readonly open: string;
  readonly close: string;
  readonly escapes: boolean;
  /** Does an unterminated string continue onto the next line? */
  readonly multiline: boolean;
  /** `${` opens a code hole inside the string (JS template literals). */
  readonly interpolation?: boolean;
}

export interface LexSpec {
  readonly id: string;
  readonly lineComments: readonly string[];
  readonly blockComments: readonly (readonly [string, string])[];
  /** Ordered: the longest opener must come first, so `"""` is tried before `"`. */
  readonly strings: readonly StringRule[];
  /** Shell: `#` starts a comment only at a word start (`${#x}` and `$#` are code). */
  readonly hashNeedsBoundary?: boolean;
  /** JS: a `/` in operand position starts a regex literal. */
  readonly regexLiterals?: boolean;
  /** Rust: `'x'` is a char literal, `'a` is a lifetime. */
  readonly rustChars?: boolean;
}

const DQ: StringRule = { open: '"', close: '"', escapes: true, multiline: false };
const SQ: StringRule = { open: "'", close: "'", escapes: true, multiline: false };
const C_COMMENTS = { lineComments: ['//'], blockComments: [['/*', '*/']] as const } as const;

const JS: LexSpec = {
  id: 'js',
  ...C_COMMENTS,
  strings: [DQ, SQ, { open: '`', close: '`', escapes: true, multiline: true, interpolation: true }],
  regexLiterals: true,
};
const C: LexSpec = { id: 'c', ...C_COMMENTS, strings: [DQ, SQ] };
const GO: LexSpec = {
  id: 'go',
  ...C_COMMENTS,
  strings: [DQ, SQ, { open: '`', close: '`', escapes: false, multiline: true }],
};
const JVM: LexSpec = {
  id: 'jvm',
  ...C_COMMENTS,
  strings: [{ open: '"""', close: '"""', escapes: true, multiline: true }, DQ, SQ],
};
const SWIFT: LexSpec = {
  id: 'swift',
  ...C_COMMENTS,
  strings: [{ open: '"""', close: '"""', escapes: true, multiline: true }, DQ],
};
const RUST: LexSpec = {
  id: 'rust',
  ...C_COMMENTS,
  strings: [{ open: '"', close: '"', escapes: true, multiline: true }],
  rustChars: true,
};
const PYTHON: LexSpec = {
  id: 'python',
  lineComments: ['#'],
  blockComments: [],
  strings: [
    { open: '"""', close: '"""', escapes: true, multiline: true },
    { open: "'''", close: "'''", escapes: true, multiline: true },
    DQ,
    SQ,
  ],
};
const SHELL: LexSpec = {
  id: 'shell',
  lineComments: ['#'],
  blockComments: [],
  strings: [
    { open: '"', close: '"', escapes: true, multiline: true },
    { open: "'", close: "'", escapes: false, multiline: true },
  ],
  hashNeedsBoundary: true,
};
const RUBY: LexSpec = {
  id: 'ruby',
  lineComments: ['#'],
  blockComments: [],
  strings: [
    { open: '"', close: '"', escapes: true, multiline: true },
    { open: "'", close: "'", escapes: true, multiline: true },
  ],
};

/**
 * Extension → lexer. A table of LANGUAGE SYNTAX, which is a fact about each language and
 * not about this repository; it grows only when a language is added, and an extension
 * missing from it is reported (`mode: 'raw'`), never silently treated as some other language.
 */
export const LEX_SPECS: Readonly<Record<string, LexSpec>> = Object.freeze({
  '.ts': JS, '.tsx': JS, '.mts': JS, '.cts': JS, '.js': JS, '.jsx': JS, '.mjs': JS, '.cjs': JS,
  '.c': C, '.h': C, '.cc': C, '.cpp': C, '.hpp': C, '.cs': C, '.dart': C, '.m': C, '.mm': C,
  '.go': GO,
  '.java': JVM, '.kt': JVM, '.kts': JVM, '.scala': JVM, '.groovy': JVM,
  '.swift': SWIFT,
  '.rs': RUST,
  '.py': PYTHON, '.pyi': PYTHON,
  '.sh': SHELL, '.bash': SHELL, '.zsh': SHELL,
  '.rb': RUBY,
});

/** The lexer for `path`, or `null` when its language is not one this module knows. */
export function lexSpecFor(path: string): LexSpec | null {
  const ext = extname(path).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEX_SPECS, ext) ? LEX_SPECS[ext] : null;
}

type Mode =
  | { kind: 'code' }
  | { kind: 'string'; rule: StringRule }
  | { kind: 'block'; close: string };

/** Lexer state that survives a line break. */
interface LexState {
  mode: Mode;
  /** One entry per open `${` hole; the number is the `{` depth inside that hole. */
  holes: number[];
  /** The last non-space CODE character seen, for the regex-vs-division decision. */
  lastSig: string;
}

const RUST_CHAR_RE = /^'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/;
const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;
const SHELL_WORD_BREAK = new Set([' ', '\t', ';', '|', '&', '(', ')']);

/** Keywords after which a `/` begins a regex literal even though an identifier precedes it. */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'yield', 'await', 'else', 'do',
]);

/** Length of a JS regex literal starting at `i`, or 0 when the `/` there is division. */
function regexLiteralLength(line: string, i: number, lastSig: string): number {
  if (lastSig === ')' || lastSig === ']') return 0;
  if (lastSig !== '' && IDENT_CHAR_RE.test(lastSig)) {
    const m = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(line.slice(0, i));
    if (!m || !REGEX_AFTER_KEYWORD.has(m[1])) return 0;
  }
  let inClass = false;
  for (let j = i + 1; j < line.length; j++) {
    const ch = line[j];
    if (ch === '\\') { j++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '/') return j - i + 1;
  }
  return 0; // unterminated on this line: not a regex literal after all
}

function projectLine(line: string, spec: LexSpec, st: LexState): string {
  const out = line.split('');
  const blank = (from: number, len: number): void => {
    for (let k = from; k < from + len && k < out.length; k++) out[k] = ' ';
  };

  let i = 0;
  while (i < line.length) {
    const mode = st.mode;

    if (mode.kind === 'block') {
      if (line.startsWith(mode.close, i)) {
        blank(i, mode.close.length);
        i += mode.close.length;
        st.mode = { kind: 'code' };
      } else {
        blank(i, 1);
        i++;
      }
      continue;
    }

    if (mode.kind === 'string') {
      const r = mode.rule;
      if (r.escapes && line[i] === '\\') { blank(i, 2); i += 2; continue; }
      if (r.interpolation && line.startsWith('${', i)) {
        blank(i, 2);
        i += 2;
        st.holes.push(0);
        st.mode = { kind: 'code' };
        st.lastSig = '';
        continue;
      }
      if (line.startsWith(r.close, i)) {
        blank(i, r.close.length);
        i += r.close.length;
        st.mode = { kind: 'code' };
        st.lastSig = '"'; // a string is an operand: a following `/` is division
        continue;
      }
      blank(i, 1);
      i++;
      continue;
    }

    // ── code ──
    const ch = line[i];

    if (st.holes.length > 0) {
      const top = st.holes.length - 1;
      if (ch === '{') st.holes[top]++;
      else if (ch === '}') {
        if (st.holes[top] === 0) {
          st.holes.pop();
          blank(i, 1);
          i++;
          st.mode = { kind: 'string', rule: spec.strings.find((s) => s.interpolation)! };
          continue;
        }
        st.holes[top]--;
      }
    }

    const lc = spec.lineComments.find((m) => line.startsWith(m, i));
    if (lc && (!spec.hashNeedsBoundary || i === 0 || SHELL_WORD_BREAK.has(line[i - 1]))) {
      blank(i, line.length - i);
      break;
    }

    const bc = spec.blockComments.find(([open]) => line.startsWith(open, i));
    if (bc) {
      blank(i, bc[0].length);
      i += bc[0].length;
      st.mode = { kind: 'block', close: bc[1] };
      continue;
    }

    if (spec.rustChars && ch === "'") {
      const m = RUST_CHAR_RE.exec(line.slice(i));
      if (m) {
        blank(i, m[0].length);
        i += m[0].length;
        st.lastSig = "'";
        continue;
      }
      i++; // a lifetime: code
      continue;
    }

    const sr = spec.strings.find((s) => line.startsWith(s.open, i));
    if (sr) {
      blank(i, sr.open.length);
      i += sr.open.length;
      st.mode = { kind: 'string', rule: sr };
      continue;
    }

    if (spec.regexLiterals && ch === '/') {
      const len = regexLiteralLength(line, i, st.lastSig);
      if (len > 0) {
        blank(i, len);
        i += len;
        st.lastSig = '/';
        continue;
      }
    }

    if (ch !== ' ' && ch !== '\t') st.lastSig = ch;
    i++;
  }

  // A single-line string that did not close by end of line is over (or was never a string).
  if (st.mode.kind === 'string' && !st.mode.rule.multiline) st.mode = { kind: 'code' };
  return out.join('');
}

/**
 * Project consecutive lines of one file onto their CODE characters.
 *
 * Every character inside a string literal or a comment becomes a space; everything else is
 * returned unchanged, so `result[n].length === lines[n].length` for every `n`.
 */
export function projectCode(lines: readonly string[], spec: LexSpec): string[] {
  const st: LexState = { mode: { kind: 'code' }, holes: [], lastSig: '' };
  return lines.map((l) => projectLine(l, spec, st));
}

// ── Diff view ─────────────────────────────────────────────────────────────────────────

export interface AddedLine {
  /** 1-based line number in the post-image. */
  readonly lineNo: number;
  /** The line as added, without its `+` marker. */
  readonly raw: string;
  /** {@link raw} with every non-code character blanked. Equal to `raw` when `mode` is `'raw'`. */
  readonly code: string;
}

export interface DiffFileView {
  /** The post-image path (`b/…` side). Empty for a headerless fragment. */
  readonly path: string;
  /**
   * How {@link AddedLine.code} was derived:
   *   - `'post-image'` — the whole file was lexed, so every line's state is exact;
   *   - `'hunk'` — each hunk was lexed alone from a code-state start (no post-image, or it
   *     did not match the diff), so a hunk that BEGINS inside a multi-line string is misread;
   *   - `'raw'` — no lexer for this language; `code === raw` (the pre-lexer behaviour).
   */
  readonly mode: 'post-image' | 'hunk' | 'raw';
  readonly added: readonly AddedLine[];
  /** Removed lines, without their `-` marker. Never projected: see the pipeline's REMOVED_BROKEN_RE. */
  readonly removed: readonly string[];
}

interface MutableFile {
  path: string;
  hunks: Array<{ newSide: string[]; addedAt: Array<{ idx: number; lineNo: number }> }>;
  removed: string[];
}

function unquoteGitPath(p: string): string {
  const s = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return s.startsWith('b/') ? s.slice(2) : s;
}

/**
 * Parse a unified diff (one or many files) and classify each added line's code spans.
 *
 * @param postImage optional reader for a file's current contents. When it returns text
 *   whose lines match the diff's added lines, the whole file is lexed (exact state).
 */
export function diffCodeView(
  diff: string,
  opts: { postImage?: (path: string) => string | null } = {},
): DiffFileView[] {
  const files: MutableFile[] = [];
  let cur: MutableFile | null = null;
  let hunk: MutableFile['hunks'][number] | null = null;
  let newLine = 0;
  let inHeader = false;

  const startFile = (path: string): MutableFile => {
    const f: MutableFile = { path, hunks: [], removed: [] };
    files.push(f);
    return f;
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = startFile('');
      hunk = null;
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (cur) cur.path = p === '/dev/null' ? '' : unquoteGitPath(p);
      continue;
    }
    if (inHeader && (line.startsWith('--- ') || !line.startsWith('@@'))) continue;

    const hh = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hh) {
      inHeader = false;
      if (!cur) cur = startFile('');
      hunk = { newSide: [], addedAt: [] };
      cur.hunks.push(hunk);
      newLine = parseInt(hh[1], 10);
      continue;
    }

    // A headerless fragment (`+  try {` on its own): one anonymous, unlexable file.
    if (!cur) cur = startFile('');
    if (!hunk) {
      hunk = { newSide: [], addedAt: [] };
      cur.hunks.push(hunk);
      newLine = 1;
    }

    if (line.startsWith('+')) {
      hunk.addedAt.push({ idx: hunk.newSide.length, lineNo: newLine });
      hunk.newSide.push(line.slice(1));
      newLine++;
    } else if (line.startsWith('-')) {
      cur.removed.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      hunk.newSide.push(line.slice(1));
      newLine++;
    }
    // `\ No newline at end of file` and anything else: not a line of either side.
  }

  return files.map((f): DiffFileView => {
    const spec = f.path ? lexSpecFor(f.path) : null;
    const rawAdded = f.hunks.flatMap((h) =>
      h.addedAt.map((a) => ({ lineNo: a.lineNo, raw: h.newSide[a.idx] })),
    );

    if (!spec) {
      return { path: f.path, mode: 'raw', added: rawAdded.map((a) => ({ ...a, code: a.raw })), removed: f.removed };
    }

    const text = opts.postImage ? opts.postImage(f.path) : null;
    if (text !== null && text !== undefined) {
      const post = text.split(/\r\n|\n|\r/);
      if (rawAdded.every((a) => post[a.lineNo - 1] === a.raw)) {
        const proj = projectCode(post, spec);
        return {
          path: f.path,
          mode: 'post-image',
          added: rawAdded.map((a) => ({ ...a, code: proj[a.lineNo - 1] })),
          removed: f.removed,
        };
      }
    }

    const added: AddedLine[] = [];
    for (const h of f.hunks) {
      const proj = projectCode(h.newSide, spec);
      for (const a of h.addedAt) added.push({ lineNo: a.lineNo, raw: h.newSide[a.idx], code: proj[a.idx] });
    }
    return { path: f.path, mode: 'hunk', added, removed: f.removed };
  });
}
