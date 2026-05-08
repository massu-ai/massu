/**
 * Drift-guard test (Plan 3c Phase 3.5 iter-6 structural fix).
 *
 * The iter-1 → iter-6 audit loop discovered the SAME class of finding
 * three times (in install-tracking.ts InstallEntrySchema, in
 * local-fingerprint.ts FingerprintSentinelSchema, in manifest-cache.ts
 * CacheWrapperSchema): a `z.string().min(1)` field on a schema that
 * (a) is parsed from operator-influenced on-disk state in `~/.massu/`
 *     OR from operator-influenced node_modules state, AND
 * (b) flows into a reason / warning / stderr / stdout render path,
 * permits an attacker to embed ANSI escape sequences (or other control
 * characters) in the field, log-injecting via the eventual CLI emit.
 *
 * Per Rule 0 / CR-46, the fix at sibling-schema-closure level isn't
 * enough — a future contributor adding a fourth schema to security/
 * with the same bare `z.string().min(1)` shape would silently regress.
 * This test is the structural drift-prevention: it greps every Zod
 * object schema declared inside `packages/core/src/security/` for bare
 * `z.string().min(1)` fields AND fails if any are found WITHOUT being
 * on the explicit allowlist below.
 *
 * The allowlist names every field that's deliberately bare (e.g.,
 * because it's NEVER rendered to operator output, or because it's
 * already constrained by another regex). Adding a new schema field
 * that's later rendered to CLI without using PrintableAsciiStringSchema
 * fails this test; the resolution is either (a) tighten to
 * PrintableAsciiStringSchema, OR (b) add the field to ALLOWLIST below
 * with a docstring explaining why bare-string is safe for that
 * specific case.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SECURITY_DIR = resolve(__dirname, '../security');

/**
 * Allowlist of `<schemaSymbolName>.<fieldName>` pairs that are
 * deliberately bare `z.string().min(1)` (not PrintableAsciiStringSchema).
 * Adding to this list requires citing a justification — typically:
 * - the field is never rendered in CLI output (operator-invisible)
 * - the field is constrained by a separate regex (sha256, base64, hex)
 * - the field's downstream validators provide equivalent log-safety
 */
const ALLOWLIST = new Set<string>([
  // ManifestBodySchema.issued_at: per iter-4 red-team check #4, not
  // rendered in CLI output paths. Loader uses it for staleness math
  // only.
  'ManifestBodySchema.issued_at',
  // EnvelopeSchema.signed_at: same — not rendered in CLI output paths.
  'EnvelopeSchema.signed_at',
]);

/** Walk a directory recursively, returning all .ts files (no tests, no .d.ts). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fp = join(dir, entry);
    const st = statSync(fp);
    if (st.isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...listTsFiles(fp));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.d.ts')) continue;
    if (entry.endsWith('.generated.ts')) continue; // generated files are out of scope
    out.push(fp);
  }
  return out;
}

/**
 * Match `<fieldName>: z.string().min(1)` patterns inside a Zod object
 * literal. Captures the field name. Stops short of `.regex(`/`.refine(`/
 * `.transform(`/`.email()`/`PrintableAsciiStringSchema`-named refs which
 * indicate the value IS additionally constrained. The match is
 * deliberately string-literal-based (no full TS AST parser) for two
 * reasons: (a) keeps the test dependency-free, (b) the regex's
 * conservative shape means false-positives (overly strict matches) are
 * the failure mode — a contributor can address by either tightening
 * the schema (the right move) or extending this regex if a legitimate
 * exception arises.
 */
const BARE_Z_STRING_MIN_1 = /(\w+):\s*z\.string\(\)\.min\(1\)(?!\.[a-z])/g;

/**
 * Best-effort enclosing-schema name. Walks backwards through the line
 * sequence looking for `const <SchemaName>Schema = z.object({` or
 * `export const <SchemaName>Schema = z.object({`. Returns the schema
 * name. If we can't find one, returns the basename of the file.
 */
function findEnclosingSchemaName(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i--) {
    const m = lines[i]?.match(/(?:export\s+)?const\s+(\w+Schema)\s*=\s*z\.object\(\{/);
    if (m) return m[1] ?? '?';
  }
  return '?';
}

describe('security/* schemas drift-guard (CR-9 iter-6 LOW-NEW6-1 + structural prevention)', () => {
  it('no bare z.string().min(1) field flows into operator-rendered output without being allowlisted', () => {
    const files = listTsFiles(SECURITY_DIR);
    const violations: Array<{ file: string; field: string; schema: string; line: number }> = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      let lineCursor = 0;
      let charCursor = 0;
      while (charCursor < content.length) {
        const slice = content.slice(charCursor);
        BARE_Z_STRING_MIN_1.lastIndex = 0;
        const m = BARE_Z_STRING_MIN_1.exec(slice);
        if (!m) break;
        // Resolve to absolute line number.
        const matchAbsoluteCharIdx = charCursor + (m.index ?? 0);
        let runningChars = 0;
        let lineNumber = 0;
        for (let i = 0; i < lines.length; i++) {
          runningChars += lines[i].length + 1; // +1 for the \n
          if (runningChars > matchAbsoluteCharIdx) {
            lineNumber = i;
            break;
          }
        }
        const fieldName = m[1] ?? '?';
        const schemaName = findEnclosingSchemaName(lines, lineNumber);
        const allowlistKey = `${schemaName}.${fieldName}`;
        if (!ALLOWLIST.has(allowlistKey)) {
          violations.push({
            file: file.slice(SECURITY_DIR.length + 1),
            field: fieldName,
            schema: schemaName,
            line: lineNumber + 1,
          });
        }
        // Advance cursor past this match to avoid infinite loop.
        charCursor = matchAbsoluteCharIdx + m[0].length;
        lineCursor = lineNumber;
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} — ${v.schema}.${v.field}: z.string().min(1)`)
        .join('\n');
      throw new Error(
        `\n\nFound ${violations.length} bare \`z.string().min(1)\` field(s) in ` +
        `packages/core/src/security/ that are NOT on the ALLOWLIST:\n\n${report}\n\n` +
        `Per CR-9 iter-3/5/6 audit findings, fields like these — when rendered to ` +
        `operator-visible output (stderr / stdout / log files) — let attackers ` +
        `embed ANSI escape sequences for log injection.\n\n` +
        `Resolution:\n` +
        `  1. (preferred) Tighten the schema field to PrintableAsciiStringSchema:\n` +
        `       <field>: PrintableAsciiStringSchema\n` +
        `     Imported from \`./manifest-schema.js\` (or relative path equivalent).\n\n` +
        `  2. (allow-list, only if the field is NEVER rendered in CLI output)\n` +
        `     Add \`<SchemaName>.<fieldName>\` to ALLOWLIST in this test file ` +
        `with a comment explaining why bare-string is safe.\n`,
      );
    }
  });
});
