// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu init` — One-command full project setup.
 *
 * 1. Detects project framework (scans package.json)
 * 2. Generates massu.config.yaml (or preserves existing)
 * 3. Registers MCP server in .mcp.json (creates or merges)
 * 4. Installs all 15 hooks in .claude/settings.local.json
 * 5. Installs slash commands into .claude/commands/
 * 6. Initializes memory directory
 * 7. Prints success summary
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { backfillMemoryFiles } from '../memory-file-ingest.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { stringify as yamlStringify } from 'yaml';
import { getConfig } from '../config.ts';
import { installCommands } from './install-commands.ts';

// ============================================================
// Types
// ============================================================

interface FrameworkDetection {
  type: string;
  router: string;
  orm: string;
  ui: string;
}

interface InitResult {
  configCreated: boolean;
  configSkipped: boolean;
  mcpRegistered: boolean;
  mcpSkipped: boolean;
  hooksInstalled: boolean;
  hooksCount: number;
  framework: FrameworkDetection;
}

// ============================================================
// Framework Auto-Detection
// ============================================================

export function detectFramework(projectRoot: string): FrameworkDetection {
  const result: FrameworkDetection = {
    type: 'javascript',
    router: 'none',
    orm: 'none',
    ui: 'none',
  };

  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return result;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    // Language detection
    if (allDeps['typescript']) result.type = 'typescript';

    // UI framework detection
    if (allDeps['next']) result.ui = 'nextjs';
    else if (allDeps['@sveltejs/kit']) result.ui = 'sveltekit';
    else if (allDeps['nuxt']) result.ui = 'nuxt';
    else if (allDeps['@angular/core']) result.ui = 'angular';
    else if (allDeps['vue']) result.ui = 'vue';
    else if (allDeps['react']) result.ui = 'react';

    // Router detection
    if (allDeps['@trpc/server']) result.router = 'trpc';
    else if (allDeps['graphql'] || allDeps['@apollo/server']) result.router = 'graphql';
    else if (allDeps['express'] || allDeps['fastify'] || allDeps['hono']) result.router = 'rest';

    // ORM detection
    if (allDeps['@prisma/client'] || allDeps['prisma']) result.orm = 'prisma';
    else if (allDeps['drizzle-orm']) result.orm = 'drizzle';
    else if (allDeps['typeorm']) result.orm = 'typeorm';
    else if (allDeps['sequelize']) result.orm = 'sequelize';
    else if (allDeps['mongoose']) result.orm = 'mongoose';
  } catch {
    // Best effort
  }

  return result;
}

// ============================================================
// Python Project Detection
// ============================================================

interface PythonDetection {
  detected: boolean;
  root: string;
  hasFastapi: boolean;
  hasSqlalchemy: boolean;
  hasAlembic: boolean;
  alembicDir: string | null;
}

export function detectPython(projectRoot: string): PythonDetection {
  const result: PythonDetection = {
    detected: false,
    root: '',
    hasFastapi: false,
    hasSqlalchemy: false,
    hasAlembic: false,
    alembicDir: null,
  };

  // Check for Python project markers
  const markers = ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'];
  const hasMarker = markers.some(m => existsSync(resolve(projectRoot, m)));
  if (!hasMarker) return result;

  result.detected = true;

  // Scan dependencies for FastAPI and SQLAlchemy
  const depFiles = [
    { file: 'pyproject.toml', parser: parsePyprojectDeps },
    { file: 'requirements.txt', parser: parseRequirementsDeps },
    { file: 'setup.py', parser: parseSetupPyDeps },
    { file: 'Pipfile', parser: parsePipfileDeps },
  ];

  for (const { file, parser } of depFiles) {
    const filePath = resolve(projectRoot, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const deps = parser(content);
        if (deps.includes('fastapi')) result.hasFastapi = true;
        if (deps.includes('sqlalchemy')) result.hasSqlalchemy = true;
      } catch {
        // Best effort
      }
    }
  }

  // Check for Alembic
  if (existsSync(resolve(projectRoot, 'alembic.ini'))) {
    result.hasAlembic = true;
    // Try to find the alembic versions directory
    if (existsSync(resolve(projectRoot, 'alembic'))) {
      result.alembicDir = 'alembic';
    }
  } else if (existsSync(resolve(projectRoot, 'alembic'))) {
    result.hasAlembic = true;
    result.alembicDir = 'alembic';
  }

  // Auto-detect Python source root
  const candidateRoots = ['app', 'src', 'backend', 'api'];
  for (const candidate of candidateRoots) {
    const candidatePath = resolve(projectRoot, candidate);
    if (existsSync(candidatePath) && existsSync(resolve(candidatePath, '__init__.py'))) {
      result.root = candidate;
      break;
    }
    // Also check for .py files directly (some projects use app/ without __init__.py)
    if (existsSync(candidatePath)) {
      try {
        const files = readdirSync(candidatePath);
        if (files.some(f => f.endsWith('.py'))) {
          result.root = candidate;
          break;
        }
      } catch {
        // Best effort
      }
    }
  }

  // Fallback: use '.' if no candidate root found
  if (!result.root) {
    result.root = '.';
  }

  return result;
}

function parsePyprojectDeps(content: string): string[] {
  const deps: string[] = [];
  const lower = content.toLowerCase();
  if (lower.includes('fastapi')) deps.push('fastapi');
  if (lower.includes('sqlalchemy')) deps.push('sqlalchemy');
  return deps;
}

function parseRequirementsDeps(content: string): string[] {
  const deps: string[] = [];
  const lower = content.toLowerCase();
  for (const line of lower.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('fastapi')) deps.push('fastapi');
    if (trimmed.startsWith('sqlalchemy')) deps.push('sqlalchemy');
  }
  return deps;
}

function parseSetupPyDeps(content: string): string[] {
  const deps: string[] = [];
  const lower = content.toLowerCase();
  if (lower.includes('fastapi')) deps.push('fastapi');
  if (lower.includes('sqlalchemy')) deps.push('sqlalchemy');
  return deps;
}

function parsePipfileDeps(content: string): string[] {
  const deps: string[] = [];
  const lower = content.toLowerCase();
  if (lower.includes('fastapi')) deps.push('fastapi');
  if (lower.includes('sqlalchemy')) deps.push('sqlalchemy');
  return deps;
}

// ============================================================
// Config File Generation
// ============================================================

export function generateConfig(projectRoot: string, framework: FrameworkDetection): boolean {
  const configPath = resolve(projectRoot, 'massu.config.yaml');

  if (existsSync(configPath)) {
    return false; // Config already exists
  }

  const projectName = basename(projectRoot);

  const config: Record<string, unknown> = {
    project: {
      name: projectName,
      root: 'auto',
    },
    framework: {
      type: framework.type,
      router: framework.router,
      orm: framework.orm,
      ui: framework.ui,
    },
    paths: {
      source: 'src',
      aliases: { '@': 'src' },
    },
    toolPrefix: 'massu',
    domains: [],
    rules: [
      {
        pattern: 'src/**/*.ts',
        rules: ['Use ESM imports, not CommonJS'],
      },
    ],
  };

  // Detect and add Python configuration
  const python = detectPython(projectRoot);
  if (python.detected) {
    const pythonConfig: Record<string, unknown> = {
      root: python.root,
      exclude_dirs: ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache'],
    };
    if (python.hasFastapi) pythonConfig.framework = 'fastapi';
    if (python.hasSqlalchemy) pythonConfig.orm = 'sqlalchemy';
    if (python.hasAlembic && python.alembicDir) {
      pythonConfig.alembic_dir = python.alembicDir;
    }
    config.python = pythonConfig;
  }

  const yamlContent = `# Massu AI Configuration
# Generated by: npx massu init
# Documentation: https://massu.ai/docs/getting-started/configuration

${yamlStringify(config)}`;

  writeFileSync(configPath, yamlContent, 'utf-8');
  return true;
}

// ============================================================
// MCP Server Registration
// ============================================================

export function registerMcpServer(projectRoot: string): boolean {
  const mcpPath = resolve(projectRoot, '.mcp.json');

  let existing: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  // Check if already registered
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  if (servers.massu) {
    return false; // Already registered
  }

  // Add massu server
  servers.massu = {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@massu/core'],
  };

  existing.mcpServers = servers;

  writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  return true;
}

// ============================================================
// Hook Installation
// ============================================================

interface HookEntry {
  type: 'command';
  command: string;
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

type HooksConfig = Record<string, HookGroup[]>;

/**
 * Resolve the path to compiled hook files.
 * Handles both local development and npm-installed scenarios.
 */
export function resolveHooksDir(): string {
  // Try to find the hooks in node_modules first (installed via npm)
  const cwd = process.cwd();
  const nodeModulesPath = resolve(cwd, 'node_modules/@massu/core/dist/hooks');
  if (existsSync(nodeModulesPath)) {
    return 'node_modules/@massu/core/dist/hooks';
  }

  // Fall back to finding relative to this source file
  const localPath = resolve(__dirname, '../dist/hooks');
  if (existsSync(localPath)) {
    return localPath;
  }

  // Default to node_modules path (will be created on npm install)
  return 'node_modules/@massu/core/dist/hooks';
}

function hookCmd(hooksDir: string, hookFile: string): string {
  return `node ${hooksDir}/${hookFile}`;
}

export function buildHooksConfig(hooksDir: string): HooksConfig {
  return {
    SessionStart: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'session-start.js'), timeout: 10 },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'security-gate.js'), timeout: 5 },
        ],
      },
      {
        matcher: 'Bash|Write',
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'pre-delete-check.js'), timeout: 5 },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'post-tool-use.js'), timeout: 10 },
          { type: 'command', command: hookCmd(hooksDir, 'quality-event.js'), timeout: 5 },
          { type: 'command', command: hookCmd(hooksDir, 'cost-tracker.js'), timeout: 5 },
        ],
      },
      {
        matcher: 'Edit|Write',
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'post-edit-context.js'), timeout: 5 },
          { type: 'command', command: hookCmd(hooksDir, 'fix-detector.js'), timeout: 5 },
        ],
      },
      {
        matcher: 'Write',
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'incident-pipeline.js'), timeout: 5 },
          { type: 'command', command: hookCmd(hooksDir, 'rule-enforcement-pipeline.js'), timeout: 5 },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'session-end.js'), timeout: 15 },
          { type: 'command', command: hookCmd(hooksDir, 'auto-learning-pipeline.js'), timeout: 10 },
        ],
      },
    ],
    PreCompact: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'pre-compact.js'), timeout: 10 },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: hookCmd(hooksDir, 'user-prompt.js'), timeout: 5 },
          { type: 'command', command: hookCmd(hooksDir, 'intent-suggester.js'), timeout: 5 },
        ],
      },
    ],
  };
}

export function installHooks(projectRoot: string): { installed: boolean; count: number } {
  const claudeDirName = getConfig().conventions?.claudeDirName ?? '.claude';
  const claudeDir = resolve(projectRoot, claudeDirName);
  const settingsPath = resolve(claudeDir, 'settings.local.json');

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Read existing settings
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  // Resolve hook paths
  const hooksDir = resolveHooksDir();

  // Build hooks config
  const hooksConfig = buildHooksConfig(hooksDir);

  // Count total hooks
  let hookCount = 0;
  for (const groups of Object.values(hooksConfig)) {
    for (const group of groups) {
      hookCount += group.hooks.length;
    }
  }

  // Merge hooks into settings (replace hooks section, preserve everything else)
  settings.hooks = hooksConfig;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  return { installed: true, count: hookCount };
}

// ============================================================
// Memory Directory Initialization
// ============================================================

/**
 * Initialize the memory directory and create an initial MEMORY.md if absent.
 * The memory directory lives in ~/.claude/projects/<encoded-root>/memory/
 * matching the path used by memory-db.ts / knowledge-tools.ts.
 */
export function initMemoryDir(projectRoot: string): { created: boolean; memoryMdCreated: boolean } {
  // Encode the project root the same way as getResolvedPaths() in config.ts
  const encodedRoot = '-' + projectRoot.replace(/\//g, '-');
  const memoryDir = resolve(homedir(), `.claude/projects/${encodedRoot}/memory`);

  let created = false;
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
    created = true;
  }

  const memoryMdPath = resolve(memoryDir, 'MEMORY.md');
  let memoryMdCreated = false;
  if (!existsSync(memoryMdPath)) {
    const projectName = basename(projectRoot);
    const memoryContent = `# ${projectName} - Massu Memory

## Key Learnings
<!-- Important patterns and conventions discovered during development -->

## Common Gotchas
<!-- Non-obvious issues and how to avoid them -->

## Corrections
<!-- Wrong behaviors that were corrected and how to prevent them -->

## File Index
<!-- Significant files and directories -->
`;
    writeFileSync(memoryMdPath, memoryContent, 'utf-8');
    memoryMdCreated = true;
  }

  return { created, memoryMdCreated };
}

// ============================================================
// Main Init Flow
// ============================================================

export async function runInit(): Promise<void> {
  const projectRoot = process.cwd();

  console.log('');
  console.log('Massu AI - Project Setup');
  console.log('========================');
  console.log('');

  // Step 1: Detect framework
  const framework = detectFramework(projectRoot);
  const frameworkParts: string[] = [];
  if (framework.type !== 'javascript') frameworkParts.push(capitalize(framework.type));
  if (framework.ui !== 'none') frameworkParts.push(formatName(framework.ui));
  if (framework.orm !== 'none') frameworkParts.push(capitalize(framework.orm));
  if (framework.router !== 'none') frameworkParts.push(framework.router.toUpperCase());
  const detected = frameworkParts.length > 0 ? frameworkParts.join(', ') : 'JavaScript';
  console.log(`  Detected: ${detected}`);

  // Step 1b: Detect Python
  const python = detectPython(projectRoot);
  if (python.detected) {
    const pyParts: string[] = ['Python'];
    if (python.hasFastapi) pyParts.push('FastAPI');
    if (python.hasSqlalchemy) pyParts.push('SQLAlchemy');
    if (python.hasAlembic) pyParts.push('Alembic');
    console.log(`  Detected: ${pyParts.join(', ')} (root: ${python.root})`);
  }

  // Step 2: Create config
  const configCreated = generateConfig(projectRoot, framework);
  if (configCreated) {
    console.log('  Created massu.config.yaml');
  } else {
    console.log('  massu.config.yaml already exists (preserved)');
  }

  // Step 3: Register MCP server
  const mcpRegistered = registerMcpServer(projectRoot);
  if (mcpRegistered) {
    console.log('  Registered MCP server in .mcp.json');
  } else {
    console.log('  MCP server already registered in .mcp.json');
  }

  // Step 4: Install hooks
  const { count: hooksCount } = installHooks(projectRoot);
  console.log(`  Installed ${hooksCount} hooks in .claude/settings.local.json`);

  // Step 5: Install slash commands
  const cmdResult = installCommands(projectRoot);
  const cmdTotal = cmdResult.installed + cmdResult.updated + cmdResult.skipped;
  if (cmdResult.installed > 0 || cmdResult.updated > 0) {
    console.log(`  Installed ${cmdTotal} slash commands (${cmdResult.installed} new, ${cmdResult.updated} updated)`);
  } else {
    console.log(`  ${cmdTotal} slash commands already up to date`);
  }

  // Step 6: Initialize memory directory
  const { created: memDirCreated, memoryMdCreated } = initMemoryDir(projectRoot);
  if (memDirCreated) {
    console.log('  Created memory directory (~/.claude/projects/.../memory/)');
  } else {
    console.log('  Memory directory already exists');
  }
  if (memoryMdCreated) {
    console.log('  Created initial MEMORY.md');
  }

  // Step 6b: Auto-backfill existing memory files into database
  try {
    const claudeDirName = '.claude';
    const encodedRoot = projectRoot.replace(/\//g, '-');
    const computedMemoryDir = resolve(homedir(), claudeDirName, 'projects', encodedRoot, 'memory');

    const memFiles = existsSync(computedMemoryDir)
      ? readdirSync(computedMemoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
      : [];

    if (memFiles.length > 0) {
      const { getMemoryDb } = await import('../memory-db.ts');
      const db = getMemoryDb();
      try {
        const stats = backfillMemoryFiles(db, computedMemoryDir, `init-${Date.now()}`);
        if (stats.inserted > 0 || stats.updated > 0) {
          console.log(`  Backfilled ${stats.inserted + stats.updated} memory files into database (${stats.inserted} new, ${stats.updated} updated)`);
        }
      } finally {
        db.close();
      }
    }
  } catch (_backfillErr) {
    // Best-effort: don't fail init if backfill fails
  }

  // Step 7: Databases info
  console.log('  Databases will auto-create on first session');

  // Summary
  console.log('');
  console.log('Massu AI is ready. Start a Claude Code session to begin.');
  console.log('');
  console.log('Next steps:');
  console.log('  claude                    # Start a session (hooks activate automatically)');
  console.log('  npx massu doctor          # Verify installation health');
  console.log('');
  console.log('Documentation: https://massu.ai/docs');
  console.log('');
}

// ============================================================
// Helpers
// ============================================================

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatName(name: string): string {
  const names: Record<string, string> = {
    nextjs: 'Next.js',
    sveltekit: 'SvelteKit',
    nuxt: 'Nuxt',
    angular: 'Angular',
    vue: 'Vue',
    react: 'React',
  };
  return names[name] ?? capitalize(name);
}
