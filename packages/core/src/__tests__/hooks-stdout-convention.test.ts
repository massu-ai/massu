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
  it('no compiled hook source uses console.log (must use the writeHookContext helper instead)', () => {
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

  it('no advisory hook uses process.stdout.write directly (must use the writeHookContext helper)', () => {
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

  // ── INVERTED 2026-08-08 (P6-004). This assertion used to REQUIRE the
  //    `{"message": …}` shape, which is why the delivery defect was stable rather
  //    than drifting back: the guard was pinning the convention that does not
  //    deliver. `message` is not a documented output field at all — the schema
  //    carries additionalContext / systemMessage / terminalSequence / decision /
  //    permissionDecision / updatedInput. A property that MOVED needs its guard
  //    inverted, never dropped.
  it('the emit helper produces hookSpecificOutput.additionalContext, NOT {"message"}', () => {
    const helperPath = join(HOOKS_DIR, 'lib', 'write-hook-message.ts');
    const src = readFileSync(helperPath, 'utf-8');
    expect(src).toMatch(/export function writeHookContext/);
    expect(src).toMatch(/hookSpecificOutput/);
    expect(src).toMatch(/additionalContext/);
    expect(src).toMatch(/process\.stdout\.write/);

    // The emitted OBJECT must not carry a `message` key. Checked on the code that
    // builds the payload, not on prose — the header explains the old shape at
    // length and must stay quotable.
    const stripped = stripCommentsAndStrings(src);
    expect(
      /JSON\.stringify\(\s*\{\s*message\s*\}/.test(stripped),
      'helper emits the undeliverable {"message"} shape',
    ).toBe(false);
  });

  it('NO hook emits the undeliverable {"message"} shape, and the old helper is GONE', () => {
    // Deleted rather than deprecated: a regression is a COMPILE error, not a
    // silent no-op. This asserts the identifier is absent from every hook source.
    const offenders: string[] = [];
    for (const file of hookFiles()) {
      if (/\bwriteHookMessage\b/.test(stripCommentsAndStrings(readFileSync(file, 'utf-8')))) {
        offenders.push(file);
      }
    }
    expect(offenders, `writeHookMessage still called in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every hook that emits context declares a VALID event (closed vocabulary)', () => {
    const { HOOK_EVENTS } = require('../hooks/lib/write-hook-message.ts') as {
      HOOK_EVENTS: readonly string[];
    };
    let declarations = 0;
    const bad: string[] = [];
    for (const file of hookFiles()) {
      const src = readFileSync(file, 'utf-8');
      if (!/writeHookContext\(/.test(stripCommentsAndStrings(src))) continue;
      const m = src.match(/const HOOK_EVENT:\s*HookEvent\s*=\s*'([^']+)'/);
      if (!m) {
        bad.push(`${file}: calls writeHookContext but declares no HOOK_EVENT`);
        continue;
      }
      declarations += 1;
      if (!HOOK_EVENTS.includes(m[1])) bad.push(`${file}: unknown event '${m[1]}'`);
    }
    // M1 — "scanned 0, found 0" is never a pass.
    expect(declarations, 'hooks declaring HOOK_EVENT — zero means this test is dead').toBeGreaterThan(
      8,
    );
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('the spec cap is a MEASURED constant, and output is truncated to it', () => {
    const { writeHookContext, ADDITIONAL_CONTEXT_MAX_CHARS } =
      require('../hooks/lib/write-hook-message.ts') as {
        writeHookContext: (e: string, m: string) => void;
        ADDITIONAL_CONTEXT_MAX_CHARS: number;
      };
    expect(ADDITIONAL_CONTEXT_MAX_CHARS).toBe(10_000);

    const chunks: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      chunks.push(s);
      return true;
    };
    try {
      writeHookContext('UserPromptSubmit', 'x'.repeat(ADDITIONAL_CONTEXT_MAX_CHARS + 5_000));
    } finally {
      (process.stdout as unknown as { write: typeof real }).write = real;
    }
    // POSITIVE CONTROL: the capture itself must have worked, or this asserts nothing.
    expect(chunks.length, 'stdout capture produced nothing — the probe is blind').toBe(1);
    const payload = JSON.parse(chunks[0]) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(payload.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(
      ADDITIONAL_CONTEXT_MAX_CHARS,
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain('truncated');
  });

  it('an unrecognised event emits NOTHING on stdout and says why on stderr', () => {
    const { writeHookContext } = require('../hooks/lib/write-hook-message.ts') as {
      writeHookContext: (e: string, m: string) => void;
    };
    const out: string[] = [];
    const err: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      out.push(s);
      return true;
    };
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      err.push(s);
      return true;
    };
    try {
      writeHookContext('NotAnEvent', 'should not be emitted');
    } finally {
      (process.stdout as unknown as { write: typeof realOut }).write = realOut;
      (process.stderr as unknown as { write: typeof realErr }).write = realErr;
    }
    expect(out, 'a malformed payload is worse than none').toEqual([]);
    expect(err.join('')).toContain('unrecognised hook event');
  });

  it('every hook that emits context imports the helper — and the check is NOT vacuous', () => {
    // Was keyed on `writeHookMessage(`, which after the 2026-08-08 rename matched
    // NOTHING and passed over an empty set — a blind gate created by the rename
    // itself. The denominator is asserted below so that cannot recur silently.
    const offenders: string[] = [];
    let emitters = 0;
    for (const file of hookFiles()) {
      if (file.endsWith('write-hook-message.ts')) continue;
      const raw = readFileSync(file, 'utf-8');
      if (/\bwriteHookContext\s*\(/.test(stripCommentsAndStrings(raw))) {
        emitters += 1;
        if (!/from\s+['"]\.\/lib\/write-hook-message(?:\.ts)?['"]/.test(raw)) {
          offenders.push(file);
        }
      }
    }
    expect(emitters, 'hooks emitting context — 0 would make this check vacuous').toBeGreaterThan(8);
    expect(offenders, `missing import: ${offenders.join(', ')}`).toEqual([]);
  });
});
