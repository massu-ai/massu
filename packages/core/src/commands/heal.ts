// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// `massu heal` (P5-001, plan-massu-resilience-layer1).
//
// The MANUAL path for bug #1 (native ABI silent-death, incident 2026-07-12):
// force-rebuild the `better-sqlite3` native binding for the Node this process is
// ACTUALLY running under. The self-heal inside the SSOT loader handles the
// automatic case on the next DB touch; this command lets a user (or a support
// script) do it on demand and see exactly what happened.
//
//   massu heal          rebuild if the binding is broken; report method/ABI/duration
//   massu heal --check  NON-mutating: report running-ABI vs binary-ABI; exit 1 on mismatch
//
// The rebuild is driven with `process.execPath` + an argv array by the loader —
// never a shell string (CR-63 / S5).
// ============================================================

import { attemptNativeHeal, probeMemoryDbUsable } from '../lib/sqlite-loader.ts';

export interface SubcommandResult {
  exitCode: number;
}

export async function runHeal(argv: string[] = []): Promise<SubcommandResult> {
  const check = argv.includes('--check');
  const runningAbi = process.versions.modules;
  // Non-mutating: the SHARED probe constructs `:memory:` + runs `SELECT 1` through the
  // sole `openDatabase` chokepoint (selfHeal:false — a check never rebuilds). Its `detail`
  // carries the raw dlopen message, from which we recover the installed binary's ABI.
  const verdict = probeMemoryDbUsable({ selfHeal: false });
  const abiFrom = (() => {
    const m = /NODE_MODULE_VERSION (\d+)/.exec(verdict.detail ?? '');
    return m ? m[1] : undefined;
  })();
  const probe = { ok: verdict.ok, abiFrom, detail: verdict.detail };

  if (check) {
    if (probe.ok) {
      process.stdout.write(
        `massu heal --check: native engine OK — better-sqlite3 matches this Node ` +
          `(NODE_MODULE_VERSION ${runningAbi}, ${process.version}).\n`,
      );
      return { exitCode: 0 };
    }
    process.stdout.write(
      `massu heal --check: ABI MISMATCH — this Node needs NODE_MODULE_VERSION ${runningAbi} ` +
        `(${process.version})` +
        (probe.abiFrom ? `, the installed binary is ${probe.abiFrom}` : '') +
        `. Run 'massu heal' to rebuild it.\n`,
    );
    return { exitCode: 1 };
  }

  if (probe.ok) {
    process.stdout.write(
      `massu heal: native engine already healthy for ${process.version} ` +
        `(NODE_MODULE_VERSION ${runningAbi}) — nothing to do.\n`,
    );
    return { exitCode: 0 };
  }

  process.stdout.write(
    `massu heal: rebuilding better-sqlite3 for ${process.version} (NODE_MODULE_VERSION ${runningAbi})…\n`,
  );
  // Pass the raw dlopen detail so the heal can recover the installed binary's ABI.
  const result = attemptNativeHeal(probe.detail ? new Error(probe.detail) : undefined);

  if (result.healed) {
    process.stdout.write(
      `massu heal: rebuilt via ${result.method} ` +
        `(ABI ${result.abiFrom ?? '?'} → ${result.abiTo}, ${result.durationMs ?? '?'}ms). ` +
        `Restart your MCP client / Claude Code to pick up the healed engine.\n`,
    );
    return { exitCode: 0 };
  }

  process.stderr.write(
    `massu heal: could not rebuild the native engine (${result.reason}` +
      `${result.detail ? `: ${result.detail}` : ''}).\n` +
      `  Ensure the install directory is writable and either network access (for a ` +
      `compiler-free prebuilt) or a C/C++ toolchain (for a source build) is available, then retry.\n`,
  );
  return { exitCode: 1 };
}
