// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * Massu CLI Entry Point
 *
 * Routes subcommands to handlers, falls through to MCP server mode
 * when no subcommand is provided (backward compatible).
 *
 * Usage:
 *   npx massu init            - Full project setup
 *   npx massu doctor          - Health check
 *   npx massu install-hooks   - Install hooks only
 *   npx massu validate-config - Validate configuration
 *   npx @massu/core           - MCP server mode (no args)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const subcommand = args[0];

async function main(): Promise<void> {
  switch (subcommand) {
    case 'init': {
      const { runInit } = await import('./commands/init.ts');
      await runInit();
      break;
    }
    case 'doctor': {
      const { runDoctor } = await import('./commands/doctor.ts');
      await runDoctor();
      break;
    }
    case 'install-hooks': {
      const { runInstallHooks } = await import('./commands/install-hooks.ts');
      await runInstallHooks();
      break;
    }
    case 'install-commands': {
      const { runInstallCommands } = await import('./commands/install-commands.ts');
      await runInstallCommands();
      break;
    }
    case 'show-template': {
      const { runShowTemplate } = await import('./commands/show-template.ts');
      await runShowTemplate(args.slice(1));
      break;
    }
    case 'validate-config': {
      const { runValidateConfig } = await import('./commands/doctor.ts');
      await runValidateConfig();
      break;
    }
    case 'config': {
      await handleConfigSubcommand(args.slice(1));
      break;
    }
    case '--help':
    case '-h': {
      printHelp();
      break;
    }
    case '--version':
    case '-v': {
      printVersion();
      break;
    }
    default: {
      // No subcommand or unknown: fall through to MCP server mode
      // This maintains backward compatibility with `npx @massu/core`
      await import('./server.ts');
    }
  }
}

async function handleConfigSubcommand(configArgs: string[]): Promise<void> {
  const sub = configArgs[0];
  const flags = new Set(configArgs.slice(1));
  switch (sub) {
    case 'refresh': {
      const { runConfigRefresh } = await import('./commands/config-refresh.ts');
      const result = await runConfigRefresh({
        dryRun: flags.has('--dry-run'),
        skipCommands: flags.has('--skip-commands'),
      });
      process.exit(result.exitCode);
      return;
    }
    case 'validate': {
      const { runValidateConfig } = await import('./commands/doctor.ts');
      await runValidateConfig();
      return;
    }
    case 'upgrade': {
      const { runConfigUpgrade } = await import('./commands/config-upgrade.ts');
      const result = await runConfigUpgrade({
        rollback: flags.has('--rollback'),
        ci: flags.has('--ci') || flags.has('--yes'),
      });
      process.exit(result.exitCode);
      return;
    }
    case 'doctor': {
      const { runDoctor } = await import('./commands/doctor.ts');
      await runDoctor();
      return;
    }
    case 'check-drift': {
      const { runConfigCheckDrift } = await import('./commands/config-check-drift.ts');
      const result = await runConfigCheckDrift({ verbose: flags.has('--verbose') });
      process.exit(result.exitCode);
      return;
    }
    case '--help':
    case '-h':
    case undefined: {
      printConfigHelp();
      return;
    }
    default: {
      process.stderr.write(`massu: unknown config subcommand: ${sub}\n`);
      printConfigHelp();
      process.exit(1);
      return;
    }
  }
}

function printHelp(): void {
  console.log(`
Massu AI - Engineering Governance Platform

Usage:
  massu <command>

Commands:
  init              Set up Massu AI in your project (one command, full setup)
  doctor            Check installation health
  install-hooks     Install/update Claude Code hooks
  install-commands  Install/update slash commands
  show-template     Print the resolved variant of a bundled template (e.g. for diffs)
  validate-config   Validate massu.config.yaml (alias: config validate)
  config <sub>      Config lifecycle: refresh | validate | upgrade | doctor | check-drift

Options:
  --help, -h        Show this help message
  --version, -v     Show version

Getting started:
  npx massu init              # Full setup in one command
  npx massu init --help       # Show all init options (--ci, --force, --template)
  npx massu config --help     # Show config subcommands

Documentation: https://massu.ai/docs
`);
}

function printConfigHelp(): void {
  console.log(`
massu config <subcommand>

Subcommands:
  refresh       Re-run detection and apply changes to massu.config.yaml.
                  --dry-run    Print diff and exit without writing.
  validate      Validate massu.config.yaml (alias of \`massu validate-config\`).
  upgrade       Migrate a v1 config to schema_version=2.
                  --rollback   Restore from .bak file.
                  --ci, --yes  Non-interactive mode (no prompts).
  doctor        Run the full health check (alias of \`massu doctor\`).
  check-drift   CI-safe drift gate; exits 1 on drift.
                  --verbose    Print detailed changes to stdout.

Examples:
  npx massu config refresh --dry-run
  npx massu config upgrade --ci
  npx massu config check-drift --verbose
`);
}

function printVersion(): void {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
    console.log(`massu v${pkg.version}`);
  } catch {
    console.log('massu v0.1.0');
  }
}

main().catch((err) => {
  console.error(`massu: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
