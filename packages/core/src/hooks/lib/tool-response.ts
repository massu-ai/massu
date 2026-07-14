/**
 * THE ONE PARSER for Claude Code's `tool_response` hook field.
 *
 * WHY THIS EXISTS (S-1, the silent-failure class, 2026-07-12):
 * Three hooks independently declared `tool_response: string`. It is not a string.
 * Measured across every real transcript for this repo: **97.6% object, 2.4% string,
 * 0% of calls matched the declared type in the common case.** `observation-extractor`
 * called `.trim()` on it, threw a TypeError, and an outer `catch {}` exited 0.
 * Result: 251,956 tool calls recorded, **0 observations, 0 audit_log rows, 0 ADRs.**
 * Massu's entire learning surface had never once run. Working and totally broken
 * were byte-identical: exit 0, zero bytes on stdout and stderr.
 *
 * The naive fix (`JSON.stringify` the object) stops the crash and replaces it with a
 * QUIETER bug: `parseTestRunOutput` and `detectPlanProgress` would then scan escaped
 * JSON instead of the command's real stdout, and would silently never match again.
 * So this module does not stringify — it EXTRACTS the field that actually carries the
 * text, which differs per tool. The shapes below are CAPTURED FROM REAL RESPONSES
 * (G-5: mocks are captured, never invented), not imagined:
 *
 *   56.6%  Bash        { stdout, stderr, interrupted, isImage, noOutputExpected }
 *   18.7%  Edit        { filePath, oldString, newString, structuredPatch, replaceAll }
 *    6.8%  Read        { type: 'text', file: { filePath, content } }
 *    6.0%  Write       { type: 'create', filePath, content, structuredPatch }
 *    2.4%  (string)    e.g. 'Error: Exit code 1\n…'
 *     ...  MCP tools   [ { type: 'text', text } ]
 *
 * ONE parser, ONE precedence, used by EVERY consumer. A second ad-hoc reader is
 * exactly how the three hooks diverged in the first place (cf. CR-59, CR-61).
 */

/** The real union Claude Code passes. Never narrow this to `string` again. */
export type RawToolResponse =
  | string
  | Record<string, unknown>
  | unknown[]
  | null
  | undefined;

export interface NormalizedToolResponse {
  /** The human/parser-meaningful text this tool produced. Never null. */
  text: string;
  /** True when the tool reported a failure. Previously hardcoded `false` — so the
   *  extractor's failure branches could never fire and errors were logged as passes. */
  isError: boolean;
  /** The top-level runtime shape, for diagnostics and the hook-health signal. */
  shape: 'string' | 'object' | 'array' | 'empty';
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** MCP content-block arrays: [{ type: 'text', text: '…' }] */
function fromContentBlocks(arr: unknown[]): string | null {
  const parts: string[] = [];
  for (const block of arr) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      const t = asString((block as Record<string, unknown>).text);
      if (t) parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Extract the text a parser would actually want, per captured shape.
 * Order matters: the most specific, highest-frequency shapes first.
 */
function textFromObject(o: Record<string, unknown>): string {
  // Bash (56.6%) — stdout is what parseTestRunOutput / scanner excerpts need.
  // stderr is appended so a failing command's message is not invisible.
  if ('stdout' in o || 'stderr' in o) {
    const out = asString(o.stdout);
    const err = asString(o.stderr);
    return err ? (out ? `${out}\n${err}` : err) : out;
  }

  // Read (6.8%) — { type:'text', file:{ content } }
  const file = o.file;
  if (file && typeof file === 'object') {
    const c = asString((file as Record<string, unknown>).content);
    if (c) return c;
  }

  // Write (6.0%) — { type:'create', content }
  const content = o.content;
  if (typeof content === 'string' && content) return content;
  if (Array.isArray(content)) {
    const blocks = fromContentBlocks(content);
    if (blocks) return blocks;
  }

  // Edit (18.7%) — no single text field; synthesize what the consumers look for.
  // The file path matters (audit trail, plan-progress), the diff text does not.
  if ('structuredPatch' in o || 'oldString' in o || 'newString' in o) {
    const path = asString(o.filePath);
    const newStr = asString(o.newString);
    return [path, newStr].filter(Boolean).join('\n');
  }

  // Generic text-bearing fields, in precedence order.
  for (const k of ['text', 'message', 'output', 'result', 'stdout']) {
    const v = asString(o[k]);
    if (v) return v;
  }

  // Unknown object shape: serialize rather than lose it. This is the LAST resort,
  // not the default — a JSON blob is poor parser input, but silence is worse.
  try {
    return JSON.stringify(o);
  } catch {
    // Circular or otherwise unserializable: still never throw out of this module.
    return '';
  }
}

/** Conservative error detection. Under-reporting an error is safer than inventing one. */
function detectError(raw: RawToolResponse, text: string): boolean {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    // Claude Code sets these explicitly when it knows.
    if (o.is_error === true || o.isError === true) return true;
    if (o.interrupted === true) return true;
  }
  // Bash failures surface as a string beginning 'Error: Exit code N'.
  return /^Error: (Exit code \d+|.*failed)/i.test(text.trimStart());
}

/**
 * Normalize any real `tool_response` into text + error-ness.
 *
 * TOTAL FUNCTION: never throws, for any input, ever. A hook on the hot path must not
 * be able to die on an unexpected shape — that is precisely the bug this closes.
 */
export function normalizeToolResponse(raw: RawToolResponse): NormalizedToolResponse {
  if (raw === null || raw === undefined || raw === '') {
    return { text: '', isError: false, shape: 'empty' };
  }

  let text: string;
  let shape: NormalizedToolResponse['shape'];

  if (typeof raw === 'string') {
    text = raw;
    shape = 'string';
  } else if (Array.isArray(raw)) {
    shape = 'array';
    const blocks = fromContentBlocks(raw);
    if (blocks !== null) {
      text = blocks;
    } else {
      try {
        text = JSON.stringify(raw);
      } catch {
        text = '';
      }
    }
  } else if (typeof raw === 'object') {
    shape = 'object';
    try {
      text = textFromObject(raw as Record<string, unknown>);
    } catch {
      text = '';
    }
  } else {
    // number | boolean | symbol | bigint — not observed, but must not throw.
    shape = 'string';
    text = String(raw);
  }

  return { text, isError: detectError(raw, text), shape };
}

/** Convenience for the many call sites that only want the text. */
export function toolResponseText(raw: RawToolResponse): string {
  return normalizeToolResponse(raw).text;
}
