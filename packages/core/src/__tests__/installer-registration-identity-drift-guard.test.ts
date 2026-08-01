/**
 * A-003 — installer registration identity drift-guard (plan-2026-08-01, phase A).
 *
 * REPRODUCES THE INCIDENT. `mergeHookEntries` used to dedup by EXACT COMMAND STRING, so a
 * version bump or a launch-mechanism change ADDED a second registration instead of replacing
 * the first. Measured live: one workspace carried 1.15.5 x16 + 1.15.2 x15 with 15 hook names
 * firing twice per event; the fleet stayed stranded on a pre-2.0.0 version because upgrading
 * duplicated, and another accumulated 26,119 NODE_MODULE_VERSION failures.
 * Incident (internal): 2026-08-01-installer-adds-hook-registrations-instead-of-replacing
 *
 * These tests drive the REAL `installHooks()` over a REAL temp project (CR-72: a fixture-only
 * mutation test is a regression test in disguise). Case (d) is the explicit can-fail proof —
 * it runs the OLD exact-command algorithm over the same input and asserts it DUPLICATES, so a
 * silent revert of the fix cannot leave this file green.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks, massuHookIdentity } from '../commands/init.js';

interface HookEntry { type: string; command: string; timeout?: number }
interface HookGroup { matcher?: string; hooks: HookEntry[] }
type HooksConfig = Record<string, HookGroup[]>;

let projectRoot: string;

function settingsPath(): string {
  return join(projectRoot, '.claude', 'settings.local.json');
}

function readHooks(): HooksConfig {
  return JSON.parse(readFileSync(settingsPath(), 'utf-8')).hooks as HooksConfig;
}

function allEntries(h: HooksConfig): HookEntry[] {
  return Object.values(h).flatMap((groups) => groups.flatMap((g) => g.hooks ?? []));
}

/** Count Massu registrations per hook identity across the whole config. */
function identityCounts(h: HooksConfig): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of allEntries(h)) {
    const id = massuHookIdentity(e.command);
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function seedSettings(hooks: HooksConfig): void {
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ hooks, permissions: { allow: [] } }, null, 2));
}

const CUSTOMER_HOOK: HookEntry = {
  type: 'command',
  command: 'bash "$CLAUDE_PROJECT_DIR/scripts/my-own-hook.sh"',
  timeout: 5,
};

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'massu-identity-guard-'));
});

afterEach(() => {
  if (projectRoot && existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
});

describe('A-003 installer registration identity', () => {
  it('(a) an OLDER-VERSION Massu block is REPLACED, not added alongside', () => {
    seedSettings({
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: 'npx -y @massu/core@1.16.2 hook-runner user-prompt', timeout: 5 },
            { type: 'command', command: 'npx -y @massu/core@1.16.2 hook-runner memory-recall', timeout: 10 },
          ],
        },
      ],
    });

    installHooks(projectRoot);
    const counts = identityCounts(readHooks());

    // THE INVARIANT: exactly one registration per hook name.
    for (const [name, n] of counts) {
      expect(n, `hook '${name}' is registered ${n} times — duplication has returned`).toBe(1);
    }
    // And the surviving entries must not be the stale version.
    const stale = allEntries(readHooks()).filter((e) => e.command.includes('@massu/core@1.16.2'));
    expect(stale, 'a 1.16.2 registration survived the merge').toHaveLength(0);
  });

  it('(b) a NODE-DIRECT Massu block is REPLACED, not added alongside (phase B forward-compat)', () => {
    // Phase B changes the launch mechanism entirely; identity must survive that too.
    seedSettings({
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/Users/someone/.massu/runtime/2.3.0/node_modules/@massu/core/dist/cli.js" hook-runner user-prompt',
              timeout: 5,
            },
          ],
        },
      ],
    });

    installHooks(projectRoot);
    const counts = identityCounts(readHooks());
    expect(counts.get('user-prompt'), 'node-direct + npx forms both registered').toBe(1);
  });

  it('(c) a CUSTOMER hook survives byte-identical and is never deduped away', () => {
    seedSettings({
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: 'npx -y @massu/core@1.16.2 hook-runner user-prompt', timeout: 5 },
            CUSTOMER_HOOK,
          ],
        },
      ],
    });

    installHooks(projectRoot);
    const survivors = allEntries(readHooks()).filter((e) => e.command === CUSTOMER_HOOK.command);
    expect(survivors, 'the customer hook was destroyed by the merge').toHaveLength(1);
    expect(survivors[0]).toEqual(CUSTOMER_HOOK);
  });

  it('(c2) two DISTINCT customer hooks both survive (identity must not over-collapse)', () => {
    const other: HookEntry = { type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/scripts/other.sh"', timeout: 5 };
    seedSettings({ UserPromptSubmit: [{ hooks: [CUSTOMER_HOOK, other] }] });

    installHooks(projectRoot);
    const cmds = allEntries(readHooks()).map((e) => e.command);
    expect(cmds).toContain(CUSTOMER_HOOK.command);
    expect(cmds).toContain(other.command);
  });

  it('(d) CAN-FAIL PROOF: the OLD exact-command algorithm duplicates on the same input', () => {
    // Verbatim reproduction of the pre-fix mergeHookEntries. If someone reverts the fix,
    // the real installer starts behaving like this — and (a) goes red. This case proves the
    // input genuinely discriminates, so (a) passing is a measurement and not a vacuous truth.
    const oldMerge = (existing: HookEntry[], additions: HookEntry[]): HookEntry[] => {
      const seen = new Set<string>();
      const result: HookEntry[] = [];
      for (const entry of additions ?? []) {
        if (!entry || typeof entry.command !== 'string') continue;
        if (seen.has(entry.command)) continue;
        seen.add(entry.command);
        result.push(entry);
      }
      for (const entry of existing ?? []) {
        if (!entry || typeof entry.command !== 'string') continue;
        if (seen.has(entry.command)) continue;
        seen.add(entry.command);
        result.push(entry);
      }
      return result;
    };

    const existing: HookEntry[] = [
      { type: 'command', command: 'npx -y @massu/core@1.16.2 hook-runner user-prompt', timeout: 5 },
    ];
    const additions: HookEntry[] = [
      { type: 'command', command: 'npx -y @massu/core@2.4.0 hook-runner user-prompt', timeout: 5 },
    ];

    const merged = oldMerge(existing, additions);
    const dupes = merged.filter((e) => massuHookIdentity(e.command) === 'user-prompt');
    expect(dupes, 'the old algorithm did NOT duplicate — this fixture no longer reproduces the bug').toHaveLength(2);
  });

  it('(e) identity extraction: Massu forms yield a name, foreign commands yield null', () => {
    expect(massuHookIdentity('npx -y @massu/core@2.4.0 hook-runner user-prompt')).toBe('user-prompt');
    expect(massuHookIdentity('npx -y @massu/core@1.15.2 hook-runner post-tool-use')).toBe('post-tool-use');
    expect(massuHookIdentity('node "/x/.massu/runtime/2.4.0/n_m/@massu/core/dist/cli.js" hook-runner session-end')).toBe('session-end');
    // NOT ours: a customer script that merely mentions the words.
    expect(massuHookIdentity('bash ./scripts/my-hook-runner wrapper')).toBeNull();
    expect(massuHookIdentity('bash "$CLAUDE_PROJECT_DIR/scripts/my-own-hook.sh"')).toBeNull();
  });

  it('(f) IDEMPOTENT: a second install changes nothing', () => {
    seedSettings({});
    installHooks(projectRoot);
    const first = readFileSync(settingsPath(), 'utf-8');
    installHooks(projectRoot);
    const second = readFileSync(settingsPath(), 'utf-8');
    expect(second, 'a second install mutated the file').toBe(first);
  });
});
