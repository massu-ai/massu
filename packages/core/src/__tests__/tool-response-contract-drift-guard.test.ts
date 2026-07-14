/**
 * DRIFT-GUARD — S-1: the `tool_response` contract.
 *
 * THE BUG THIS MAKES IMPOSSIBLE (2026-07-12):
 * Three hooks declared `tool_response: string`. Claude Code passes an OBJECT 97.6% of
 * the time. `.trim()` on it threw a TypeError; an empty `catch {}` ate it; the hook
 * exited 0. Result: 251,956 tool calls -> 0 observations, 0 audit_log rows, 0 ADRs.
 * Massu's entire learning surface had never run, and every gate stayed green.
 *
 * WHY THE EXISTING TESTS DID NOT CATCH IT — and why this file is written differently:
 * `observation-extractor.test.ts` passed STRING literals ('success', 'created', …).
 * Those tests were green. They asserted the bug. And because the interface DECLARED
 * `string`, `tsc` was satisfied too. The type was the lie, so the type-checker and the
 * tests agreed with each other and both were wrong about the world.
 *
 * So this guard does NOT test with hand-written strings. It tests with the REAL SHAPES,
 * captured from live transcripts (G-5: mocks are captured, never invented), and it reads
 * the SOURCE to ensure no hook can re-narrow the type.
 *
 * THE KILLER QUESTION (applied to this file): if the real integration were 100% broken,
 * would these tests still pass? No — case 1 fails on the exact TypeError that started
 * this, and case 3 fails the moment anyone writes `tool_response: string` again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { normalizeToolResponse, toolResponseText } from '../hooks/lib/tool-response.ts';
import { classifyRealTimeToolCall, detectPlanProgress } from '../observation-extractor.ts';

const HOOKS_DIR = join(__dirname, '..', 'hooks');

/**
 * REAL shapes, captured from this repo's live Claude Code transcripts on 2026-07-13,
 * with their measured frequencies. NOT invented.
 */
const CAPTURED = {
  bash: {
    stdout: 'Test Files  3 passed (3)\n     Tests  47 passed (47)',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  }, // 56.6%
  edit: {
    filePath: '/repo/src/a.ts',
    oldString: 'a',
    newString: 'b',
    structuredPatch: [],
    replaceAll: false,
  }, // 18.7%
  read: { type: 'text', file: { filePath: '/repo/src/a.ts', content: 'export const x = 1;' } }, // 6.8%
  write: { type: 'create', filePath: '/repo/src/a.ts', content: 'export const x = 1;' }, // 6.0%
  str: 'The file has been updated successfully.', // 2.4%
  mcpBlocks: [{ type: 'text', text: 'PASS: Check 30' }], // MCP tools
};

describe('S-1 drift-guard: the tool_response contract', () => {
  it('case 1: normalizing every REAL shape never throws (this is the TypeError that killed the hook)', () => {
    for (const [name, shape] of Object.entries(CAPTURED)) {
      expect(() => normalizeToolResponse(shape as never), `shape: ${name}`).not.toThrow();
    }
    // And the degenerate inputs a hot path must survive.
    for (const junk of [null, undefined, '', 0, false, [], {}]) {
      expect(() => normalizeToolResponse(junk as never)).not.toThrow();
    }
  });

  it('case 2: it EXTRACTS the real text, it does not JSON.stringify it', () => {
    // This is the subtle half of the bug. Stringifying would stop the crash and
    // silently feed escaped JSON to parseTestRunOutput/detectPlanProgress, which would
    // then never match again — a louder bug traded for a quieter one.
    const bash = toolResponseText(CAPTURED.bash);
    expect(bash).toContain('Tests  47 passed');
    expect(bash).not.toContain('\\n'); // not an escaped JSON blob
    expect(bash).not.toContain('"stdout"');

    expect(toolResponseText(CAPTURED.read)).toBe('export const x = 1;');
    expect(toolResponseText(CAPTURED.write)).toBe('export const x = 1;');
    expect(toolResponseText(CAPTURED.mcpBlocks)).toBe('PASS: Check 30');
    expect(toolResponseText(CAPTURED.edit)).toContain('/repo/src/a.ts');
  });

  it('case 3: NO hook may declare `tool_response: string` ever again', () => {
    // The type WAS the lie. A comment cannot enforce this; the source can.
    const offenders: string[] = [];
    for (const f of readdirSync(HOOKS_DIR).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(HOOKS_DIR, f), 'utf-8');
      // Strip block comments so the explanatory prose in the fixed hooks (which quotes
      // the old declaration) cannot itself trip the guard. A check that a COMMENT can
      // satisfy or violate is exactly the symbol-grep anti-pattern (T-3).
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/tool_response\s*:\s*string\s*;/.test(code)) offenders.push(f);
    }
    expect(offenders, `these hooks re-narrowed tool_response to \`string\`: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('case 4: the extractor survives a real OBJECT — the exact call that used to throw', () => {
    const seen = new Set<string>();
    expect(() =>
      classifyRealTimeToolCall('Bash', { command: 'npm test' }, CAPTURED.bash as never, seen),
    ).not.toThrow();

    // And it produces a REAL observation, not null. "Didn't crash" is not "worked".
    const obs = classifyRealTimeToolCall(
      'Bash',
      { command: 'npm test' },
      CAPTURED.bash as never,
      new Set(),
    );
    expect(obs).not.toBeNull();
    expect(obs!.title).toContain('PASS');
  });

  it('case 5: detectPlanProgress reads plan items out of a real Bash dict', () => {
    const progress = detectPlanProgress({
      stdout: 'P3-002: COMPLETE\nP3-003: PASS',
      stderr: '',
    } as never);
    expect(progress.map((p) => p.planItem)).toEqual(['P3-002', 'P3-003']);
  });

  it('case 6: a failing command is recorded as a FAILURE (isError was hardcoded false)', () => {
    // Every failing command used to be logged as a pass, because `isError: false` was
    // a literal. The extractor's failure branches could never fire.
    expect(normalizeToolResponse('Error: Exit code 1\nsomething broke').isError).toBe(true);
    expect(normalizeToolResponse({ ...CAPTURED.bash, interrupted: true }).isError).toBe(true);
    expect(normalizeToolResponse(CAPTURED.bash).isError).toBe(false);
  });
});
