// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4-004 — Installer launch-symmetry drift-guard (Layer 3, CR-70).
 *
 * THE ASYMMETRY THIS LOCKS OUT (incident 2026-07-22-native-abi-hooks-bare-node-launch): the
 * MCP server was hand-wrapped to a compatible Node while the hooks ran BARE. massu's own two
 * emitters — `registerMcpServer()` (.mcp.json server command) and `hookCmd()` /
 * `buildHooksConfig()` (hook commands) — must share ONE launch mechanism, so a hand-wrap on
 * one side can never silently reintroduce the drift.
 *
 * AMENDED by plan-2026-08-01 phase B. This guard used to assert the LITERAL `'npx'` on both
 * sides. That pinned an implementation detail rather than the property (G28 — a gate's scope
 * predicate must BE the property, not a correlate), with two consequences:
 *
 *   1. it would go RED on a CORRECT change (the node-direct launch this plan ships), and
 *   2. it would stay GREEN on a WRONG one that happened to use npx on both sides.
 *
 * It now asserts the invariant that actually matters — BOTH EMITTERS AGREE, whatever the
 * mechanism — and exercises BOTH supported mechanisms explicitly rather than depending on
 * whichever runtime happens to exist on the machine running the tests.
 *
 * G-6 anti-vacuity: a hand-wrapped hook command MUST make the symmetry check go RED.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { registerMcpServer, buildHooksConfig } from '../commands/init.ts';

/**
 * Reduce a launch command to its comparable MECHANISM.
 *
 * `kind` is the invariant both emitters must agree on:
 *   'npx'  -> `npx -y @massu/core@<ver> …`
 *   'node' -> `node <abs path to massu cli.js> …`
 * Anything else (a `node@22` wrapper, a `bash -c` shim) is `other`, which can never equal
 * the peer's kind — that is what makes a hand-wrap detectable.
 *
 * `pin` is the version-identifying payload, ignoring any trailing `hook-runner <name>` —
 * the one legitimate difference between the hook and server commands.
 */
function deriveMechanism(command: string, argv?: string[]): { kind: string; pin: string } {
  const tokens = argv ? [command, ...argv] : (command.trim().match(/"[^"]*"|\S+/g) ?? []);
  const binary = tokens[0] ?? '';
  const strip = (s: string): string => s.replace(/^"|"$/g, '');

  if (binary === 'npx') {
    const yIdx = tokens.indexOf('-y');
    return { kind: 'npx', pin: yIdx >= 0 ? strip(tokens[yIdx + 1] ?? '') : '' };
  }
  if (/massu-hook"?$/.test(binary)) {
    // Phase B shim form: `"<shim>" <version> hook-runner <name>` / server `<shim>` + [version].
    // The pin is the VERSION, which both emitters must agree on.
    return { kind: 'shim', pin: strip(tokens[1] ?? '') };
  }
  if (binary === 'node') {
    // The pin is the resolved cli path, minus any trailing hook-runner subcommand.
    return { kind: 'node', pin: strip(tokens[1] ?? '') };
  }
  return { kind: 'other', pin: binary };
}

function firstHookCommand(): string {
  const cfg = buildHooksConfig();
  const cmd = cfg.SessionStart?.[0]?.hooks?.[0]?.command;
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

/** Both emitters, derived under whatever mode is currently forced. */
function bothMechanisms(): { hook: ReturnType<typeof deriveMechanism>; srv: ReturnType<typeof deriveMechanism> } {
  const hook = deriveMechanism(firstHookCommand());
  const s = serverCommand();
  return { hook, srv: deriveMechanism(s.command, s.args) };
}

const ORIGINAL_NO_DIRECT = process.env.MASSU_NO_NODE_DIRECT;
afterEach(() => {
  if (ORIGINAL_NO_DIRECT === undefined) delete process.env.MASSU_NO_NODE_DIRECT;
  else process.env.MASSU_NO_NODE_DIRECT = ORIGINAL_NO_DIRECT;
});

describe('P4-004 installer launch-symmetry drift-guard (Layer 3, CR-70)', () => {
  it('THE INVARIANT: both emitters agree on mechanism AND pin, under the ambient mode', () => {
    const { hook, srv } = bothMechanisms();
    expect(hook.kind, 'hook and server launch mechanisms diverged').toBe(srv.kind);
    expect(hook.pin, 'hook and server point at different massu payloads').toBe(srv.pin);
    // Whatever they agreed on must be a mechanism massu actually emits.
    expect(['npx', 'shim']).toContain(hook.kind);
  });

  it('npx mode (forced): both emitters emit the pinned npx form', () => {
    process.env.MASSU_NO_NODE_DIRECT = '1';
    const { hook, srv } = bothMechanisms();
    expect(hook.kind).toBe('npx');
    expect(srv.kind).toBe('npx');
    expect(hook.pin).toBe(srv.pin);
    expect(hook.pin).toMatch(/^@massu\/core@/);
  });

  it('the hook command differs from the server command ONLY by a trailing `hook-runner <name>`', () => {
    process.env.MASSU_NO_NODE_DIRECT = '1'; // deterministic: compare like with like
    const hookCmd = firstHookCommand();
    const srv = serverCommand();
    const serverAsString = `${srv.command} ${srv.args.join(' ')}`;
    expect(hookCmd.startsWith(serverAsString)).toBe(true);
    expect(hookCmd.slice(serverAsString.length)).toMatch(/^\s+hook-runner\s+\S+$/);
  });

  it('P4-004 (win32): the emitters stay platform-NEUTRAL and still agree', () => {
    process.env.MASSU_NO_NODE_DIRECT = '1';
    const orig = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const { hook, srv } = bothMechanisms();
      expect(hook.kind).toBe(srv.kind);
      expect(hook.pin).toBe(srv.pin);
      expect(hook.kind).toBe('npx');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('node-direct mode: the derived mechanism is `node` + an absolute cli path', () => {
    // Exercises the phase-B branch WITHOUT requiring a materialised runtime on this machine,
    // so the assertion is about the derivation contract both emitters share.
    const hook = deriveMechanism('node "/Users/example/.massu/runtime/2.4.0/node_modules/@massu/core/dist/cli.js" hook-runner session-start');
    const srv = deriveMechanism('node', ['/Users/example/.massu/runtime/2.4.0/node_modules/@massu/core/dist/cli.js']);
    expect(hook.kind).toBe('node');
    expect(srv.kind).toBe('node');
    expect(hook.kind).toBe(srv.kind);
    expect(hook.pin).toBe(srv.pin); // same resolved cli on both sides
  });

  it('G-6 anti-vacuity: a hand-wrapped hook command makes the symmetry check go RED', () => {
    process.env.MASSU_NO_NODE_DIRECT = '1';
    const s = serverCommand();
    const srvMech = deriveMechanism(s.command, s.args);

    // The exact drift found LIVE in one workspace on 2026-08-01:
    // server wrapped in `bash -c "export PATH=…node@22…; exec npx …"` vs bare-npx hooks.
    const wrapped = deriveMechanism('node@22 npx -y @massu/core@2.4.0 hook-runner session-start');
    expect(wrapped.kind).toBe('other');
    expect(wrapped.kind).not.toBe(srvMech.kind);
    expect(() => expect(wrapped.kind).toBe(srvMech.kind)).toThrow();

    // And a bash-shim wrapper is equally detectable.
    const shimmed = deriveMechanism('bash', ['-c', 'export PATH=/opt/homebrew/opt/node@22/bin:$PATH; exec npx -y @massu/core@2.0.0']);
    expect(shimmed.kind).toBe('other');
    expect(() => expect(shimmed.kind).toBe(srvMech.kind)).toThrow();
  });

  it('G-6 anti-vacuity: MIXED mechanisms (one npx, one node) go RED', () => {
    // The failure this whole guard exists for, in its phase-B form: if only ONE emitter were
    // migrated to node-direct, they would disagree and this must catch it.
    const npxSide = deriveMechanism('npx -y @massu/core@2.4.0 hook-runner session-start');
    const nodeSide = deriveMechanism('node', ['/Users/example/.massu/runtime/2.4.0/node_modules/@massu/core/dist/cli.js']);
    expect(npxSide.kind).not.toBe(nodeSide.kind);
    expect(() => expect(npxSide.kind).toBe(nodeSide.kind)).toThrow();
  });
});
