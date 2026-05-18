import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const HOOKS_DIR = join(__dirname, '..', 'hooks');

function hookFiles(): string[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(HOOKS_DIR, f));
}

function stripCommentsAndStrings(src: string): string {
  // Strip /* ... */ block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip // line comments
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // Strip "..." and '...' string literals (template literals left in — we only
  // care about identifier-level matches like `console.log(...)`).
  out = out.replace(/"(?:\\.|[^"\\])*"/g, '""');
  out = out.replace(/'(?:\\.|[^'\\])*'/g, "''");
  return out;
}

describe('P-M-004 hooks stdout convention drift-guard', () => {
  it('no compiled hook source uses console.log (must use writeHookMessage helper instead)', () => {
    const offenders: string[] = [];
    for (const file of hookFiles()) {
      const raw = readFileSync(file, 'utf-8');
      const stripped = stripCommentsAndStrings(raw);
      if (/\bconsole\.log\s*\(/.test(stripped)) {
        offenders.push(file);
      }
    }
    expect(offenders, `console.log found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no advisory hook uses process.stdout.write directly (must use writeHookMessage helper)', () => {
    // SessionStart is a special hook type: its output is injected as raw
    // context into the conversation prompt, NOT parsed as advisory JSON.
    // Claude Code's SessionStart contract expects plain text, so session-start
    // is the sole legitimate process.stdout.write caller among hooks.
    const SESSION_START_ALLOWLIST = new Set(['session-start.ts']);
    const offenders: string[] = [];
    for (const file of hookFiles()) {
      if (file.endsWith('write-hook-message.ts')) continue;
      const basename = file.split('/').pop() ?? '';
      if (SESSION_START_ALLOWLIST.has(basename)) continue;
      const raw = readFileSync(file, 'utf-8');
      const stripped = stripCommentsAndStrings(raw);
      if (/process\.stdout\.write\s*\(/.test(stripped)) {
        offenders.push(file);
      }
    }
    expect(offenders, `process.stdout.write found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('writeHookMessage helper exists and emits {"message": ...} JSON', () => {
    const helperPath = join(HOOKS_DIR, 'lib', 'write-hook-message.ts');
    const src = readFileSync(helperPath, 'utf-8');
    expect(src).toMatch(/export function writeHookMessage/);
    expect(src).toMatch(/JSON\.stringify\(\s*\{\s*message\s*\}/);
    expect(src).toMatch(/process\.stdout\.write/);
  });

  it('every hook that emits to stdout imports writeHookMessage', () => {
    const offenders: string[] = [];
    for (const file of hookFiles()) {
      if (file.endsWith('write-hook-message.ts')) continue;
      const raw = readFileSync(file, 'utf-8');
      // If hook references writeHookMessage in code, it must import it.
      if (/\bwriteHookMessage\s*\(/.test(stripCommentsAndStrings(raw))) {
        if (!/from\s+['"]\.\/lib\/write-hook-message(?:\.ts)?['"]/.test(raw)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders, `missing import: ${offenders.join(', ')}`).toEqual([]);
  });
});
