// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * An upgrade in ONE repo must leave that repo on ONE version, with no old massu entries.
 *
 * 2026-11-09, upgrading a machine's repos to 2.5.6 with `massu install-hooks`:
 *   - every repo's hooks moved to 2.5.6 and every `.mcp.json` stayed on 2.5.2 — the MCP pin was
 *     never refreshed (CR-70 L3-1 says the two must share one launch mechanism);
 *   - one repo kept 16 pre-hook-runner entries (`node .../node_modules/@massu/core/dist/hooks/
 *     <name>.js` behind a walk-up loop) beside the 16 current ones: not recognised as massu-owned,
 *     so never replaced. They resolved to `/` and failed on every tool call.
 * The fixtures below are those exact shapes.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildHooksConfig,
  mergeHooksConfig,
  massuHookIdentity,
  refreshMcpServerPin,
  getInstallerVersion,
  SUPERSEDED_MASSU_HOOKS,
} from '../commands/init.ts';

const LEGACY = (name: string) =>
  `d="$PWD"; while [ "$d" != "/" ] && [ ! -f "$d/node_modules/@massu/core/dist/hooks/${name}.js" ]; do d="$(dirname "$d")"; done; cd "$d" && node node_modules/@massu/core/dist/hooks/${name}.js`;

function commands(cfg: Record<string, Array<{ hooks: Array<{ command: string }> }>>): string[] {
  return Object.values(cfg).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command)));
}

describe('massuHookIdentity recognises every form massu has written', () => {
  it('the legacy node_modules walk-up form is massu-owned, by hook name', () => {
    expect(massuHookIdentity(LEGACY('session-start'))).toBe('session-start');
    expect(massuHookIdentity(LEGACY('security-gate'))).toBe('security-gate');
  });
  it('the current forms still resolve, and a customer hook is still not ours', () => {
    expect(massuHookIdentity('"/Users/example/.massu/bin/massu-hook" 2.5.3 hook-runner pre-tool-use-gate')).toBe('pre-tool-use-gate');
    expect(massuHookIdentity('npx -y @massu/core@2.5.2 hook-runner user-prompt')).toBe('user-prompt');
    expect(massuHookIdentity('node ./scripts/my-own-hook.js')).toBeNull();
    expect(massuHookIdentity('echo hook-runner session-start')).toBeNull();
  });
});

describe('an upgrade replaces every older massu entry and keeps the customer\'s', () => {
  it('legacy + old-version + a customer hook -> exactly the current set plus the customer hook', () => {
    const fresh = buildHooksConfig('', null) as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    const existing = {
      SessionStart: [{ hooks: [{ type: 'command', command: LEGACY('session-start') }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: LEGACY('security-gate') }, { type: 'command', command: 'node ./scripts/my-own-hook.js' }] },
        { matcher: 'Bash|Write', hooks: [{ type: 'command', command: LEGACY('pre-delete-check') }] },
        { matcher: 'Bash|Write|Edit', hooks: [{ type: 'command', command: 'npx -y @massu/core@2.5.3 hook-runner pre-tool-use-gate' }] },
      ],
    };
    const merged = mergeHooksConfig(existing as never, fresh as never) as typeof fresh;
    const all = commands(merged);
    const version = getInstallerVersion();

    const massu = all.filter((c) => massuHookIdentity(c) !== null);
    expect(massu.length, 'one entry per current massu hook').toBe(commands(fresh).length);
    expect(massu.every((c) => c.includes(version)), `every massu entry runs ${version}`).toBe(true);
    expect(all.filter((c) => c.includes('node_modules/@massu/core')), 'no legacy entry survives').toEqual([]);
    for (const old of Object.keys(SUPERSEDED_MASSU_HOOKS)) {
      expect(massu.some((c) => massuHookIdentity(c) === old), `${old} is superseded and must be gone`).toBe(false);
    }
    expect(all, 'the customer hook is kept verbatim').toContain('node ./scripts/my-own-hook.js');
  });
});

describe('refreshMcpServerPin', () => {
  const withMcp = (doc: unknown, fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-pin-'));
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify(doc, null, 2) + '\n');
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const version = getInstallerVersion();

  it('a massu-written pin at an old version is moved to this version; other servers untouched', () => {
    withMcp({ mcpServers: { massu: { type: 'stdio', command: '/Users/example/.massu/bin/massu-hook', args: ['2.5.2'] }, other: { command: 'foo', args: ['1'] } } }, (dir) => {
      expect(refreshMcpServerPin(dir)).toBe('updated');
      const doc = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
      expect(JSON.stringify(doc.mcpServers.massu)).toContain(version);
      expect(JSON.stringify(doc.mcpServers.massu)).not.toContain('2.5.2');
      expect(doc.mcpServers.other).toEqual({ command: 'foo', args: ['1'] });
      expect(refreshMcpServerPin(dir), 'idempotent').toBe('current');
    });
  });

  it('the npx form is refreshed too', () => {
    withMcp({ mcpServers: { massu: { type: 'stdio', command: 'npx', args: ['-y', '@massu/core@2.4.0'] } } }, (dir) => {
      expect(refreshMcpServerPin(dir)).toBe('updated');
      expect(readFileSync(join(dir, '.mcp.json'), 'utf-8')).toContain(version);
    });
  });

  it('a hand-written massu entry is left alone and reported', () => {
    const custom = { mcpServers: { massu: { command: 'bash', args: ['-c', 'exec npx @massu/core@2.4.0'] } } };
    withMcp(custom, (dir) => {
      expect(refreshMcpServerPin(dir)).toBe('custom');
      expect(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'))).toEqual(custom);
    });
  });

  it('no .mcp.json, or no massu entry, is absent — never created here', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-pin-'));
    try {
      expect(refreshMcpServerPin(dir)).toBe('absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    withMcp({ mcpServers: { other: { command: 'foo' } } }, (dir) => expect(refreshMcpServerPin(dir)).toBe('absent'));
  });
});
