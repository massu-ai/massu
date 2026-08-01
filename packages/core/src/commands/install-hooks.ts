// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu install-hooks` — Standalone hook installation.
 *
 * Installs or updates the canonical Massu hook set in .claude/settings.local.json.
 * Count is sourced from lib/hook-registry.ts SoT; see REGISTERED_HOOKS there.
 * Uses the same logic as `massu init` but only handles hooks.
 */

import { installHooks, materializeMassuRuntime, installMassuShim, getInstallerVersion } from './init.ts';

export async function runInstallHooks(): Promise<void> {
  const projectRoot = process.cwd();

  console.log('');
  console.log('Massu AI - Hook Installation');
  console.log('============================');
  console.log('');

  // plan-2026-08-01 phase B. Install the VERSION-STABLE shim and materialise the runtime
  // BEFORE emitting, so `buildHooksConfig` can resolve the shim and emit the ~9x cheaper
  // form. Order matters: shim first (it is what gets emitted), runtime second (it is what
  // the shim prefers at fire time).
  //
  // Deliberately in the COMMAND layer, not inside `installHooks()`: that function is called
  // by tests and by `init`, and burying a network install inside it would make every caller
  // slow and network-dependent. Both steps are idempotent, never throw, and a false return
  // keeps the emitter on npx — so these lines can only make hooks FASTER, never absent.
  //
  // The shim is REWRITTEN on every run, so a deleted or corrupted shim self-repairs on the
  // next `install-hooks` rather than needing a diagnosis.
  const version = getInstallerVersion();
  const shimOk = installMassuShim();
  const runtimeOk = materializeMassuRuntime(version);
  if (shimOk && runtimeOk) {
    console.log('  Launcher: shim + runtime ready (fast path, ~9x cheaper per hook)');
  } else if (shimOk) {
    console.log('  Launcher: shim ready, runtime unavailable — shim will fall back to npx at fire time');
  } else {
    console.log('  Launcher: npx (shim unavailable — works, ~0.9s slower per hook)');
  }

  const { count } = installHooks(projectRoot);
  console.log(`  Installed ${count} hooks in .claude/settings.local.json`);
  console.log('');
  console.log('Hooks will activate on your next Claude Code session.');
  console.log('');
}
