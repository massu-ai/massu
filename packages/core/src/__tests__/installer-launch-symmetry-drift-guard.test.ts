// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-004 — Installer launch-symmetry drift-guard (Layer 3, CR-70).
 *
 * THE ASYMMETRY THIS LOCKS OUT (incident 2026-07-22-native-abi-hooks-bare-node-launch): the
 * MCP server was hand-wrapped to a compatible Node while the hooks ran BARE. massu's own two
 * emitters — `registerMcpServer()` (.mcp.json server command) and `hookCmd()` /
 * `buildHooksConfig()` (hook commands) — are ALREADY symmetric (both `npx -y @massu/core@<ver>`,
 * the hook merely appending `hook-runner <name>`). This guard LOCKS that symmetry so a
 * hand-wrap on one side can never silently reintroduce the drift.
 *
 * G-6 anti-vacuity: a mutated hook command wrapped in `node@22` MUST make the symmetry check
 * go RED — proving the guard can fail (CR-64).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { registerMcpServer, buildHooksConfig } from '../commands/init.ts';

/**
 * Reduce a launch command to its comparable MECHANISM: the binary + the pinned
 * `-y @massu/core@<version>` prefix, IGNORING any trailing `hook-runner <name>` (the one
 * legitimate difference between the hook and server commands). Any extra wrapper (e.g.
 * `node@22 npx …`) changes `binary`, so a wrapped command is NOT symmetric.
 */
function deriveMechanism(command: string, argv?: string[]): { binary: string; pin: string } {
  const tokens = argv ? [command, ...argv] : command.trim().split(/\s+/);
  const binary = tokens[0];
  // Find `-y` `@massu/core@<ver>` (adjacent) — the pinned-install prefix.
  const yIdx = tokens.indexOf('-y');
  const pkg = yIdx >= 0 ? tokens[yIdx + 1] : '';
  return { binary, pin: `-y ${pkg}` };
}

function firstHookCommand(): string {
  const cfg = buildHooksConfig();
  const group = cfg.SessionStart?.[0];
  const cmd = group?.hooks?.[0]?.command;
  if (!cmd) throw new Error('buildHooksConfig() emitted no SessionStart hook command');
  return cmd;
}

function serverCommand(): { command: string; args: string[] } {
  const dir = mkdtempSync(resolve(tmpdir(), 'massu-symmetry-'));
  try {
    registerMcpServer(dir);
    const mcp = JSON.parse(readFileSync(resolve(dir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { massu: { command: string; args: string[] } };
    };
    return { command: mcp.mcpServers.massu.command, args: mcp.mcpServers.massu.args };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('P4-004 installer launch-symmetry drift-guard (Layer 3, CR-70)', () => {
  it('the hook launcher and the .mcp.json server launcher share ONE mechanism (same binary + version pin)', () => {
    const hookMech = deriveMechanism(firstHookCommand());
    const srv = serverCommand();
    const srvMech = deriveMechanism(srv.command, srv.args);

    expect(srvMech.binary).toBe('npx');
    expect(hookMech.binary).toBe('npx');
    expect(hookMech.binary).toBe(srvMech.binary);
    // Same pinned @massu/core@<version> on both sides — no unpinned / divergent version.
    expect(hookMech.pin).toBe(srvMech.pin);
    expect(hookMech.pin).toMatch(/^-y @massu\/core@/);
  });

  it('the hook command differs from the server command ONLY by a trailing `hook-runner <name>`', () => {
    const hookCmd = firstHookCommand();
    const srv = serverCommand();
    const serverAsString = `${srv.command} ${srv.args.join(' ')}`;
    expect(hookCmd.startsWith(serverAsString)).toBe(true);
    expect(hookCmd.slice(serverAsString.length)).toMatch(/^\s+hook-runner\s+\S+$/);
  });

  it('P4-004 (win32): the emitters stay `npx -y @massu/core@<v>` on win32 (platform-neutral, Layer 3-W)', () => {
    // Fast local mirror of the windows-latest CI leg (P4-003): assert the two emitters are
    // platform-NEUTRAL — with process.platform forced to win32 they still produce the SAME
    // `npx -y @massu/core@<ver>` mechanism, never a hand-wrapped divergence.
    const orig = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const hookMech = deriveMechanism(firstHookCommand());
      const srv = serverCommand();
      const srvMech = deriveMechanism(srv.command, srv.args);
      expect(hookMech.binary).toBe('npx');
      expect(srvMech.binary).toBe('npx');
      expect(hookMech.pin).toBe(srvMech.pin);
      expect(hookMech.pin).toMatch(/^-y @massu\/core@/);
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('G-6 anti-vacuity: a `node@22`-wrapped hook command makes the symmetry check go RED', () => {
    const srv = serverCommand();
    const srvMech = deriveMechanism(srv.command, srv.args);

    // Simulate the exact drift the incident introduced: wrap the hook side in a Node pin.
    const wrappedHook = `node@22 ${firstHookCommand()}`;
    const wrappedMech = deriveMechanism(wrappedHook);

    // The wrapped command's binary is `node@22`, NOT `npx` → NOT symmetric. The real
    // symmetry assertion (binary equality) would therefore FAIL for this mutant, proving the
    // guard is not vacuous.
    expect(wrappedMech.binary).toBe('node@22');
    expect(wrappedMech.binary).not.toBe(srvMech.binary);
    expect(() => expect(wrappedMech.binary).toBe(srvMech.binary)).toThrow();
  });
});
