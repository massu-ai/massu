// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu doctor` — Installation health check.
 *
 * Verifies all components of a Massu AI installation are working:
 * 1. massu.config.yaml exists and parses correctly
 * 2. .mcp.json has massu entry
 * 3. .claude/settings.local.json has hooks config
 * 4. All 11 compiled hook files exist
 * 5. Knowledge DB exists (.massu/memory.db)
 * 6. Memory directory exists (~/.claude/projects/.../memory/)
 * 7. Shell hooks wired in settings.local.json
 * 8. better-sqlite3 native module loads
 * 9. Node.js version >= 18
 * 10. Git repository detected
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { getResolvedPaths } from '../config.ts';
import { getCurrentTier, getLicenseInfo, daysUntilExpiry } from '../license.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Types
// ============================================================

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

// ============================================================
// Hook Files
// ============================================================

const EXPECTED_HOOKS = [
  'session-start.js',
  'session-end.js',
  'post-tool-use.js',
  'user-prompt.js',
  'pre-compact.js',
  'pre-delete-check.js',
  'post-edit-context.js',
  'security-gate.js',
  'cost-tracker.js',
  'quality-event.js',
  'intent-suggester.js',
];

// ============================================================
// Individual Checks
// ============================================================

function checkConfig(projectRoot: string): CheckResult {
  const configPath = resolve(projectRoot, 'massu.config.yaml');
  if (!existsSync(configPath)) {
    return { name: 'Configuration', status: 'fail', detail: 'massu.config.yaml not found. Run: npx massu init' };
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== 'object') {
      return { name: 'Configuration', status: 'fail', detail: 'massu.config.yaml is empty or invalid YAML' };
    }
    return { name: 'Configuration', status: 'pass', detail: 'massu.config.yaml found and valid' };
  } catch (err) {
    return { name: 'Configuration', status: 'fail', detail: `massu.config.yaml parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkMcpServer(projectRoot: string): CheckResult {
  const mcpPath = getResolvedPaths().mcpJsonPath;
  if (!existsSync(mcpPath)) {
    return { name: 'MCP Server', status: 'fail', detail: '.mcp.json not found. Run: npx massu init' };
  }

  try {
    const content = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    const servers = content.mcpServers ?? {};
    if (!servers.massu) {
      return { name: 'MCP Server', status: 'fail', detail: 'massu not registered in .mcp.json. Run: npx massu init' };
    }
    return { name: 'MCP Server', status: 'pass', detail: 'Registered in .mcp.json' };
  } catch (err) {
    return { name: 'MCP Server', status: 'fail', detail: `.mcp.json parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkHooksConfig(projectRoot: string): CheckResult {
  const settingsPath = getResolvedPaths().settingsLocalPath;
  if (!existsSync(settingsPath)) {
    return { name: 'Hooks Config', status: 'fail', detail: '.claude/settings.local.json not found. Run: npx massu init' };
  }

  try {
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!content.hooks) {
      return { name: 'Hooks Config', status: 'fail', detail: 'No hooks configured. Run: npx massu install-hooks' };
    }

    // Count configured hooks
    let hookCount = 0;
    for (const groups of Object.values(content.hooks)) {
      if (Array.isArray(groups)) {
        for (const group of groups) {
          const g = group as { hooks?: unknown[] };
          if (Array.isArray(g.hooks)) {
            hookCount += g.hooks.length;
          }
        }
      }
    }

    if (hookCount === 0) {
      return { name: 'Hooks Config', status: 'fail', detail: 'Hooks section exists but no hooks configured' };
    }

    return { name: 'Hooks Config', status: 'pass', detail: `${hookCount} hooks configured` };
  } catch (err) {
    return { name: 'Hooks Config', status: 'fail', detail: `settings.local.json parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkHookFiles(projectRoot: string): CheckResult {
  // Check node_modules path first
  const nodeModulesHooksDir = resolve(projectRoot, 'node_modules/@massu/core/dist/hooks');
  let hooksDir = nodeModulesHooksDir;

  if (!existsSync(nodeModulesHooksDir)) {
    // Check relative to this file (development mode)
    const devHooksDir = resolve(__dirname, '../../dist/hooks');
    if (existsSync(devHooksDir)) {
      hooksDir = devHooksDir;
    } else {
      return { name: 'Hook Files', status: 'fail', detail: 'Compiled hooks not found. Run: npm install @massu/core' };
    }
  }

  const missing: string[] = [];
  for (const hookFile of EXPECTED_HOOKS) {
    if (!existsSync(resolve(hooksDir, hookFile))) {
      missing.push(hookFile);
    }
  }

  if (missing.length > 0) {
    return { name: 'Hook Files', status: 'fail', detail: `Missing hooks: ${missing.join(', ')}` };
  }

  return { name: 'Hook Files', status: 'pass', detail: `${EXPECTED_HOOKS.length}/${EXPECTED_HOOKS.length} compiled hooks present` };
}

async function checkNativeModules(): Promise<CheckResult> {
  try {
    await import('better-sqlite3');
    return { name: 'Native Modules', status: 'pass', detail: 'better-sqlite3 loads correctly' };
  } catch (err) {
    return { name: 'Native Modules', status: 'fail', detail: `better-sqlite3 failed: ${err instanceof Error ? err.message : String(err)}. Try: npm rebuild better-sqlite3` };
  }
}

function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);

  if (major >= 18) {
    return { name: 'Node.js', status: 'pass', detail: `v${version} (>= 18 required)` };
  }

  return { name: 'Node.js', status: 'fail', detail: `v${version} — Node.js 18+ is required` };
}

async function checkGitRepo(projectRoot: string): Promise<CheckResult> {
  const gitDir = resolve(projectRoot, '.git');
  if (!existsSync(gitDir)) {
    return { name: 'Git Repository', status: 'warn', detail: 'Not a git repository (optional but recommended)' };
  }

  try {
    const { spawnSync } = await import('child_process');
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: projectRoot,
    });
    const branch = result.stdout?.trim() ?? 'unknown';
    return { name: 'Git Repository', status: 'pass', detail: `Detected (branch: ${branch})` };
  } catch {
    return { name: 'Git Repository', status: 'pass', detail: 'Detected' };
  }
}

function checkKnowledgeDb(projectRoot: string): CheckResult {
  // Knowledge DB is the memory DB
  const knowledgeDbPath = getResolvedPaths().memoryDbPath;
  if (!existsSync(knowledgeDbPath)) {
    return {
      name: 'Knowledge DB',
      status: 'warn',
      detail: '.massu/memory.db not found (will auto-create on first session)',
    };
  }
  return { name: 'Knowledge DB', status: 'pass', detail: '.massu/memory.db exists' };
}

function checkMemoryDir(_projectRoot: string): CheckResult {
  // Memory dir: ~/.claude/projects/-<encoded-root>/memory/ (resolved via config)
  const memoryDir = getResolvedPaths().memoryDir;
  if (!existsSync(memoryDir)) {
    return {
      name: 'Memory Directory',
      status: 'warn',
      detail: 'Memory directory not found. Run: npx massu init',
    };
  }
  return { name: 'Memory Directory', status: 'pass', detail: `Memory directory exists` };
}

function checkShellHooksWired(_projectRoot: string): CheckResult {
  // Verify that .claude/settings.local.json has hooks configured (shell hooks are wired)
  const settingsPath = getResolvedPaths().settingsLocalPath;
  if (!existsSync(settingsPath)) {
    return {
      name: 'Shell Hooks',
      status: 'fail',
      detail: 'settings.local.json not found. Run: npx massu install-hooks',
    };
  }

  try {
    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const hooks = content.hooks ?? {};
    const hasSessionStart = Array.isArray(hooks.SessionStart) && hooks.SessionStart.length > 0;
    const hasPreToolUse = Array.isArray(hooks.PreToolUse) && hooks.PreToolUse.length > 0;
    if (!hasSessionStart && !hasPreToolUse) {
      return {
        name: 'Shell Hooks',
        status: 'fail',
        detail: 'No lifecycle hooks wired. Run: npx massu install-hooks',
      };
    }
    return { name: 'Shell Hooks', status: 'pass', detail: 'Lifecycle hooks wired in settings.local.json' };
  } catch (err) {
    return {
      name: 'Shell Hooks',
      status: 'fail',
      detail: `settings.local.json parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkLicenseStatus(): Promise<CheckResult> {
  try {
    const tier = await getCurrentTier();
    const info = await getLicenseInfo();

    if (tier === 'free' && !info.validUntil) {
      return { name: 'License', status: 'pass', detail: 'Free (no API key configured)' };
    }

    const days = await daysUntilExpiry();
    if (days >= 0 && info.validUntil) {
      return {
        name: 'License',
        status: 'pass',
        detail: `${tier.charAt(0).toUpperCase() + tier.slice(1)} (valid until ${info.validUntil})`,
      };
    }

    return {
      name: 'License',
      status: 'pass',
      detail: `${tier.charAt(0).toUpperCase() + tier.slice(1)} (valid)`,
    };
  } catch (err) {
    return {
      name: 'License',
      status: 'warn',
      detail: `Could not check license: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ============================================================
// Main Doctor Flow
// ============================================================

export async function runDoctor(): Promise<void> {
  const projectRoot = process.cwd();

  console.log('');
  console.log('Massu AI Health Check');
  console.log('=====================');
  console.log('');

  const checks: CheckResult[] = [
    checkConfig(projectRoot),
    checkMcpServer(projectRoot),
    checkHooksConfig(projectRoot),
    checkHookFiles(projectRoot),
    checkKnowledgeDb(projectRoot),
    checkMemoryDir(projectRoot),
    checkShellHooksWired(projectRoot),
    await checkNativeModules(),
    checkNodeVersion(),
    await checkGitRepo(projectRoot),
    await checkLicenseStatus(),
  ];

  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const check of checks) {
    const icon = check.status === 'pass' ? '\u2713' : check.status === 'warn' ? '!' : '\u2717';
    const pad = check.name.padEnd(20);
    console.log(`  ${icon} ${pad} ${check.detail}`);

    if (check.status === 'pass') passed++;
    else if (check.status === 'fail') failed++;
    else warned++;
  }

  console.log('');

  if (failed === 0) {
    const total = passed + warned;
    console.log(`Status: HEALTHY (${passed}/${total} checks passed${warned > 0 ? `, ${warned} warnings` : ''})`);
  } else {
    console.log(`Status: UNHEALTHY (${failed} check${failed > 1 ? 's' : ''} failed)`);
    console.log('');
    console.log('Fix issues above, then run: npx massu doctor');
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

// ============================================================
// Validate Config Command
// ============================================================

export async function runValidateConfig(): Promise<void> {
  const projectRoot = process.cwd();
  const configPath = resolve(projectRoot, 'massu.config.yaml');

  if (!existsSync(configPath)) {
    console.error('Error: massu.config.yaml not found in current directory');
    console.error('Run: npx massu init');
    process.exit(1);
    return;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(content);

    if (!parsed || typeof parsed !== 'object') {
      console.error('Error: massu.config.yaml is empty or not a valid YAML object');
      process.exit(1);
      return;
    }

    // Check required fields
    const warnings: string[] = [];

    if (!parsed.project?.name) {
      warnings.push('Missing project.name (will default to "my-project")');
    }
    if (!parsed.toolPrefix) {
      warnings.push('Missing toolPrefix (will default to "massu")');
    }
    if (!parsed.framework?.type) {
      warnings.push('Missing framework.type (will default to "typescript")');
    }

    console.log('');
    if (warnings.length === 0) {
      console.log('massu.config.yaml is valid');
    } else {
      console.log('massu.config.yaml parsed successfully with warnings:');
      for (const w of warnings) {
        console.log(`  ! ${w}`);
      }
    }
    console.log('');
  } catch (err) {
    console.error(`Error parsing massu.config.yaml: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
