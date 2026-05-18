// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-012 drift-guard test: `installHooks` MUST NOT wholesale-replace a
 * customer's pre-existing `hooks` block. Customer-defined hook entries
 * (audit hooks, custom matchers, third-party integrations) must survive
 * every reinstall.
 *
 * The structural class this closes: same as the permissions trap fixed
 * in plan-1.8.0-mcp-permission-seeding (SHA 4351fb7) — wholesale assignment
 * silently destroyed customer-defined values on every install. The fix
 * here mirrors that pattern: deep-merge with the existing block, keyed
 * by event-name + matcher, deduplicating hook entries by command string.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { installHooks, mergeHooksConfig } from '../commands/init.ts';

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(resolve(tmpdir(), 'massu-hooks-merge-'));
});

afterEach(() => {
  if (existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('P-012: installHooks merges with customer hooks (no wholesale replace)', () => {
  it('preserves a customer-defined PreToolUse audit hook across installHooks', () => {
    // Seed: customer's existing settings.local.json with a custom PreToolUse hook.
    const claudeDir = resolve(fixtureDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = resolve(claudeDir, 'settings.local.json');
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          customerSetting: 'must-survive',
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash|Write|Edit',
                hooks: [
                  {
                    type: 'command',
                    command: '/customer/bin/audit-log.sh',
                    timeout: 3,
                  },
                ],
              },
            ],
            // Customer-only event Massu never touches.
            Custom: [
              {
                hooks: [
                  { type: 'command', command: '/customer/bin/never-touched.sh', timeout: 1 },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    // Act: run installHooks (this is the operation that historically destroyed
    // customer hooks via wholesale `settings.hooks = hooksConfig` assignment).
    installHooks(fixtureDir);

    // Assert: customer audit hook is still present.
    const merged = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(merged.customerSetting).toBe('must-survive');
    expect(merged.hooks).toBeDefined();
    expect(merged.hooks.PreToolUse).toBeDefined();

    // The customer's audit hook command MUST appear somewhere in PreToolUse.
    const allPreToolUseCommands: string[] = [];
    for (const group of merged.hooks.PreToolUse) {
      for (const entry of group.hooks) {
        allPreToolUseCommands.push(entry.command);
      }
    }
    expect(allPreToolUseCommands).toContain('/customer/bin/audit-log.sh');

    // The customer's Custom event group MUST be preserved entirely.
    expect(merged.hooks.Custom).toBeDefined();
    expect(merged.hooks.Custom[0].hooks[0].command).toBe('/customer/bin/never-touched.sh');

    // Massu's canonical hooks are also installed alongside.
    // P-E-019 (1.12.0): security-gate + pre-delete-check are consolidated
    // into pre-tool-use-gate. New installs emit only the consolidated
    // hook.
    const allCommands = JSON.stringify(merged.hooks);
    expect(allCommands).toContain('hook-runner pre-tool-use-gate');
  });

  it('is idempotent — repeated installHooks does not duplicate Massu entries', () => {
    installHooks(fixtureDir);
    installHooks(fixtureDir);
    installHooks(fixtureDir);

    const settingsPath = resolve(fixtureDir, '.claude/settings.local.json');
    const merged = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // P-E-019 (1.12.0): canonical PreToolUse hook is now pre-tool-use-gate.
    // Count occurrences of the canonical command — must be exactly 1 even
    // after 3 installs.
    const raw = JSON.stringify(merged.hooks);
    const matches = raw.match(/hook-runner pre-tool-use-gate/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('mergeHooksConfig unit: coalesces groups by matcher key', () => {
    const existing = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command' as const, command: '/customer/bash-only.sh', timeout: 3 }],
        },
      ],
    };
    const additions = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command' as const, command: 'npx -y @massu/core@1.9.4 hook-runner security-gate', timeout: 5 }],
        },
      ],
    };

    const merged = mergeHooksConfig(existing, additions);

    // Must be a single Bash group (not two).
    expect(merged.PreToolUse).toHaveLength(1);
    expect(merged.PreToolUse[0].matcher).toBe('Bash');

    // Both entries must be present.
    const commands = merged.PreToolUse[0].hooks.map((h) => h.command);
    expect(commands).toContain('/customer/bash-only.sh');
    expect(commands).toContain('npx -y @massu/core@1.9.4 hook-runner security-gate');
  });

  it('mergeHooksConfig unit: customer event not touched by Massu is preserved', () => {
    const existing = {
      Custom: [
        {
          hooks: [{ type: 'command' as const, command: '/customer/handler.sh', timeout: 5 }],
        },
      ],
    };
    const additions = {
      SessionStart: [
        {
          hooks: [{ type: 'command' as const, command: 'npx -y @massu/core@1.9.4 hook-runner session-start', timeout: 10 }],
        },
      ],
    };

    const merged = mergeHooksConfig(existing, additions);

    expect(merged.Custom).toBeDefined();
    expect(merged.Custom[0].hooks[0].command).toBe('/customer/handler.sh');
    expect(merged.SessionStart).toBeDefined();
    expect(merged.SessionStart[0].hooks[0].command).toContain('hook-runner session-start');
  });
});
