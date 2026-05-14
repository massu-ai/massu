// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu permissions <subcommand>` — MCP permission lifecycle CLI.
 *
 * Subcommands (each is documented at https://massu.ai/docs/reference/cli-reference):
 *   install      Seed `mcp__massu__*` into permissions.allow + propagate global
 *                defaultMode (idempotent, kept-because-edited preservation).
 *   verify       Read-only check; exit 0 if all canonical entries present, else 1.
 *   check-drift  Extended diagnostic (4 drift kinds, severity-mapped exit codes).
 *
 * Exit code matrix for `check-drift` (highest severity wins when multiple kinds present):
 *   0 = clean
 *   1 = missing-allow
 *   2 = invalid-default-mode
 *   3 = unknown-key
 *   4 = strips-global-defaultmode
 *
 * Mirrors the existing `handleConfigSubcommand` dispatch pattern at cli.ts.
 */

import { resolve } from 'path';
import { getConfig } from '../config.ts';
import {
  installPermissions,
  verifyPermissions,
  checkPermissionsDrift,
  type DriftKind,
} from '../permissions.ts';
import { runWithManifest } from './install-commands.ts';

function resolveClaudeDir(): string {
  let claudeDirName = '.claude';
  try {
    claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  } catch {
    claudeDirName = '.claude';
  }
  return resolve(process.cwd(), claudeDirName);
}

const DRIFT_KIND_EXIT_CODE: Record<DriftKind, number> = {
  'missing-allow': 1,
  'invalid-default-mode': 2,
  'unknown-key': 3,
  'strips-global-defaultmode': 4,
};

export async function handlePermissionsSubcommand(
  args: string[],
): Promise<{ exitCode: number }> {
  const sub = args[0];

  switch (sub) {
    case 'install': {
      const claudeDir = resolveClaudeDir();
      const result = runWithManifest(claudeDir, (manifest) =>
        installPermissions(claudeDir, manifest, { silent: false }),
      );
      // Final user-facing summary line on stdout
      if (result.installed > 0) {
        process.stdout.write(
          'Wrote merged permissions block to .claude/settings.local.json.\n',
        );
      } else if (result.skipped > 0) {
        process.stdout.write('Permissions already in sync — no changes.\n');
      } else if (result.kept > 0) {
        process.stdout.write(
          'Operator-edited permissions block preserved. Run `npx massu permissions check-drift` to inspect.\n',
        );
      }
      return { exitCode: 0 };
    }

    case 'verify': {
      const claudeDir = resolveClaudeDir();
      const { missing } = verifyPermissions(claudeDir);
      if (missing.length === 0) {
        process.stdout.write('All MCP allowlist entries present.\n');
        return { exitCode: 0 };
      }
      for (const entry of missing) {
        process.stderr.write(`missing: ${entry}\n`);
      }
      return { exitCode: 1 };
    }

    case 'check-drift': {
      const claudeDir = resolveClaudeDir();
      const { driftItems } = checkPermissionsDrift(claudeDir);
      if (driftItems.length === 0) {
        process.stdout.write('No permission drift detected.\n');
        return { exitCode: 0 };
      }
      // Highest-severity kind wins for exit code
      let highest = 0;
      for (const item of driftItems) {
        const code = DRIFT_KIND_EXIT_CODE[item.kind];
        if (code > highest) highest = code;
        process.stderr.write(
          `drift[${item.kind}]: ${item.detail} — remediation: ${item.remediation}\n`,
        );
      }
      return { exitCode: highest };
    }

    case '--help':
    case '-h':
    case undefined: {
      printPermissionsHelp();
      return { exitCode: 0 };
    }

    default: {
      process.stderr.write(`massu: unknown permissions subcommand: ${sub}\n`);
      printPermissionsHelp();
      return { exitCode: 1 };
    }
  }
}

export function printPermissionsHelp(): void {
  process.stdout.write(`
massu permissions <subcommand>

Subcommands:
  install       Seed mcp__massu__* into .claude/settings.local.json's permissions.allow.
                  Also propagates global defaultMode (from ~/.claude/settings.json) into
                  the project-local file to prevent the merge-replacement trap (see
                  https://massu.ai/docs/reference/cli-reference#permissions-trap).
                  Idempotent. Preserves operator-edited values.

  verify        Read-only check that all canonical MCP allowlist entries are present.
                  Exit 0 if clean, exit 1 with one diagnostic line per missing entry.

  check-drift   Extended diagnostic surfacing 4 drift kinds:
                  - missing-allow             (exit 1) — canonical entries missing
                  - invalid-default-mode      (exit 2) — defaultMode requires launch flag
                  - unknown-key               (exit 3) — undocumented top-level setting
                  - strips-global-defaultmode (exit 4) — project-local would strip global value

Examples:
  npx massu permissions install
  npx massu permissions verify
  npx massu permissions check-drift

Documentation: https://massu.ai/docs/reference/cli-reference#massu-permissions
`);
}
