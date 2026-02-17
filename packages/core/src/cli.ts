#!/usr/bin/env node
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
    case 'validate-config': {
      const { runValidateConfig } = await import('./commands/doctor.ts');
      await runValidateConfig();
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

function printHelp(): void {
  console.log(`
Massu AI - Engineering Governance Platform

Usage:
  massu <command>

Commands:
  init              Set up Massu AI in your project (one command, full setup)
  doctor            Check installation health
  install-hooks     Install/update Claude Code hooks
  validate-config   Validate massu.config.yaml

Options:
  --help, -h        Show this help message
  --version, -v     Show version

Getting started:
  npx massu init    # Full setup in one command

Documentation: https://massu.dev/docs
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
