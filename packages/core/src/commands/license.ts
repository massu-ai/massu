// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu license <subcommand>` — license/tier-gate CLI.
 *
 * This is the reusable command-gate mechanism (plan-2026-05-27-tier-gate-
 * auto-learning, P1-006/007). Any gated slash command can hard-fail its
 * first Bash step with:
 *
 *   npx massu license check --min pro || exit 1
 *
 * A prose preamble is advisory; a CLI that EXITS NON-ZERO is structural.
 *
 * Subcommands:
 *   check --min <tier>   Exit 0 if the current tier is >= <tier>, else exit 3
 *                        + a generic upgrade message on stderr. Fail-closed:
 *                        any error resolving the tier → non-zero exit.
 *
 * Exit code matrix for `check`:
 *   0 = entitled (current tier >= --min)
 *   2 = usage error (missing/invalid --min)
 *   3 = not entitled (current tier < --min) — upgrade text on stderr
 *
 * Mirrors the `handlePermissionsSubcommand` shape at commands/permissions.ts.
 */

import {
  type ToolTier,
  tierLevel,
  getCurrentTier,
} from '../license.ts';
import { autoLearningUpgradeMessage } from '../auto-learning-entitlement.ts';

const VALID_TIERS: readonly ToolTier[] = ['free', 'pro', 'team', 'enterprise'];

function isValidTier(value: string): value is ToolTier {
  return (VALID_TIERS as readonly string[]).includes(value);
}

export async function handleLicenseSubcommand(
  args: string[],
): Promise<{ exitCode: number }> {
  const sub = args[0];

  switch (sub) {
    case 'check': {
      // Parse `--min <tier>`.
      const minIdx = args.indexOf('--min');
      if (minIdx === -1 || minIdx === args.length - 1) {
        process.stderr.write(
          'Usage: massu license check --min <free|pro|team|enterprise>\n',
        );
        return { exitCode: 2 };
      }
      const minRaw = args[minIdx + 1];
      if (!isValidTier(minRaw)) {
        process.stderr.write(
          `massu: invalid --min tier "${minRaw}" (expected one of: ${VALID_TIERS.join(', ')})\n`,
        );
        return { exitCode: 2 };
      }
      const min: ToolTier = minRaw;

      // Fail-closed: any error resolving the current tier → non-zero exit.
      let current: ToolTier;
      try {
        current = await getCurrentTier();
      } catch (err) {
        process.stderr.write(
          `massu: could not resolve license tier (${err instanceof Error ? err.message : String(err)})\n`,
        );
        return { exitCode: 3 };
      }

      if (tierLevel(current) >= tierLevel(min)) {
        return { exitCode: 0 };
      }

      // Not entitled — surface the generic upgrade message (shared SoT).
      process.stderr.write(autoLearningUpgradeMessage(current) + '\n');
      return { exitCode: 3 };
    }

    case '--help':
    case '-h':
    case undefined: {
      printLicenseHelp();
      return { exitCode: 0 };
    }

    default: {
      process.stderr.write(`massu: unknown license subcommand: ${sub}\n`);
      printLicenseHelp();
      return { exitCode: 1 };
    }
  }
}

export function printLicenseHelp(): void {
  process.stdout.write(`
massu license <subcommand>

Subcommands:
  check --min <tier>   Exit 0 if the current license tier is at or above <tier>,
                         else exit 3 with a generic upgrade message on stderr.
                         <tier> is one of: free | pro | team | enterprise.
                         Fail-closed — any error resolving the tier exits non-zero.

                         Use as the first step of a gated command to hard-fail:
                           npx massu license check --min pro || exit 1

Examples:
  npx massu license check --min pro
  npx massu license check --min team

Documentation: https://massu.ai/docs/reference/license-tiers
`);
}
