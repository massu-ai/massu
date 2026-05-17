// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu install-hooks` — Standalone hook installation.
 *
 * Installs or updates the canonical Massu hook set in .claude/settings.local.json.
 * Count is sourced from lib/hook-registry.ts SoT; see REGISTERED_HOOKS there.
 * Uses the same logic as `massu init` but only handles hooks.
 */

import { installHooks } from './init.ts';

export async function runInstallHooks(): Promise<void> {
  const projectRoot = process.cwd();

  console.log('');
  console.log('Massu AI - Hook Installation');
  console.log('============================');
  console.log('');

  const { count } = installHooks(projectRoot);
  console.log(`  Installed ${count} hooks in .claude/settings.local.json`);
  console.log('');
  console.log('Hooks will activate on your next Claude Code session.');
  console.log('');
}
