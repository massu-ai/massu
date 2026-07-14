// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import {
  detectFramework,
  generateConfig,
  registerMcpServer,
  installHooks,
  buildHooksConfig,
} from '../commands/init.ts';

const TEST_DIR = resolve(__dirname, '../../.test-cli');

function setupTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
}

function cleanupTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

describe('CLI: Framework Detection', () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it('detects TypeScript', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5.0.0' },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.type).toBe('typescript');
  });

  it('detects Next.js', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.ui).toBe('nextjs');
    expect(result.type).toBe('typescript');
  });

  it('detects Prisma ORM', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { '@prisma/client': '^5.0.0' },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.orm).toBe('prisma');
  });

  it('detects tRPC router', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { '@trpc/server': '^10.0.0' },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.router).toBe('trpc');
  });

  it('detects SvelteKit', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      devDependencies: { '@sveltejs/kit': '^2.0.0' },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.ui).toBe('sveltekit');
  });

  it('detects drizzle ORM', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { 'drizzle-orm': '^0.30.0' },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.orm).toBe('drizzle');
  });

  it('detects GraphQL router', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { graphql: '^16.0.0' },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.router).toBe('graphql');
  });

  it('detects Express REST', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.0.0' },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.router).toBe('rest');
  });

  it('returns defaults when no package.json', () => {
    const result = detectFramework(TEST_DIR);
    expect(result.type).toBe('javascript');
    expect(result.router).toBe('none');
    expect(result.orm).toBe('none');
    expect(result.ui).toBe('none');
  });

  it('detects full stack: TS + Next.js + Prisma + tRPC', () => {
    writeFileSync(resolve(TEST_DIR, 'package.json'), JSON.stringify({
      dependencies: {
        next: '^14.0.0',
        '@prisma/client': '^5.0.0',
        '@trpc/server': '^10.0.0',
      },
      devDependencies: {
        typescript: '^5.0.0',
      },
    }));
    const result = detectFramework(TEST_DIR);
    expect(result.type).toBe('typescript');
    expect(result.ui).toBe('nextjs');
    expect(result.orm).toBe('prisma');
    expect(result.router).toBe('trpc');
  });
});

describe('CLI: Config Generation', () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  // P2-002: generateConfig is deprecated since 1.2.1. These smoke tests silence
  // the deprecation warning to keep CI output clean. The function's behavior
  // contract is unchanged.
  it('creates massu.config.yaml', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const framework = { type: 'typescript', router: 'trpc', orm: 'prisma', ui: 'nextjs' };
      const created = generateConfig(TEST_DIR, framework);
      expect(created).toBe(true);
      expect(existsSync(resolve(TEST_DIR, 'massu.config.yaml'))).toBe(true);

      const content = readFileSync(resolve(TEST_DIR, 'massu.config.yaml'), 'utf-8');
      expect(content).toContain('toolPrefix: massu');
      expect(content).toContain('type: typescript');
      expect(content).toContain('router: trpc');
      expect(content).toContain('orm: prisma');
      expect(content).toContain('ui: nextjs');
      // Deprecation warn emitted.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated since 1.2.1'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips if config already exists', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(resolve(TEST_DIR, 'massu.config.yaml'), 'existing: true\n');
      const framework = { type: 'typescript', router: 'none', orm: 'none', ui: 'none' };
      const created = generateConfig(TEST_DIR, framework);
      expect(created).toBe(false);

      const content = readFileSync(resolve(TEST_DIR, 'massu.config.yaml'), 'utf-8');
      expect(content).toBe('existing: true\n');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('CLI: MCP Registration', () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it('creates .mcp.json when it does not exist', () => {
    const registered = registerMcpServer(TEST_DIR);
    expect(registered).toBe(true);
    expect(existsSync(resolve(TEST_DIR, '.mcp.json'))).toBe(true);

    const content = JSON.parse(readFileSync(resolve(TEST_DIR, '.mcp.json'), 'utf-8'));
    expect(content.mcpServers.massu).toBeDefined();
    expect(content.mcpServers.massu.type).toBe('stdio');
    expect(content.mcpServers.massu.command).toBe('npx');
    // P-002: version-pinned to prevent customer drift onto unpinned @massu/core.
    expect(content.mcpServers.massu.args).toHaveLength(2);
    expect(content.mcpServers.massu.args[0]).toBe('-y');
    expect(content.mcpServers.massu.args[1]).toMatch(/^@massu\/core@\d+\.\d+\.\d+/);
  });

  it('merges into existing .mcp.json without overwriting other servers', () => {
    writeFileSync(resolve(TEST_DIR, '.mcp.json'), JSON.stringify({
      mcpServers: {
        other: { type: 'stdio', command: 'other-server' },
      },
    }));

    const registered = registerMcpServer(TEST_DIR);
    expect(registered).toBe(true);

    const content = JSON.parse(readFileSync(resolve(TEST_DIR, '.mcp.json'), 'utf-8'));
    expect(content.mcpServers.massu).toBeDefined();
    expect(content.mcpServers.other).toBeDefined();
    expect(content.mcpServers.other.command).toBe('other-server');
  });

  it('skips if massu already registered', () => {
    writeFileSync(resolve(TEST_DIR, '.mcp.json'), JSON.stringify({
      mcpServers: {
        massu: { type: 'stdio', command: 'npx', args: ['-y', '@massu/core'] },
      },
    }));

    const registered = registerMcpServer(TEST_DIR);
    expect(registered).toBe(false);
  });

  it('is idempotent (running twice does not duplicate)', () => {
    registerMcpServer(TEST_DIR);
    const registered = registerMcpServer(TEST_DIR);
    expect(registered).toBe(false);

    const content = JSON.parse(readFileSync(resolve(TEST_DIR, '.mcp.json'), 'utf-8'));
    expect(Object.keys(content.mcpServers)).toHaveLength(1);
  });
});

describe('CLI: Hooks Installation', () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it('creates .claude/settings.local.json with hooks', () => {
    const { installed, count } = installHooks(TEST_DIR);
    expect(installed).toBe(true);
    // 16 total (P-E-019 + plan-living-memory-slice-1): 1 SessionStart +
    // 1 PreToolUse (consolidated gate) + 8 PostToolUse + 2 Stop + 1 PreCompact +
    // 3 UserPromptSubmit (user-prompt + intent-suggester + memory-recall)
    expect(count).toBe(16);

    const settingsPath = resolve(TEST_DIR, '.claude/settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.hooks).toBeDefined();
    expect(content.hooks.SessionStart).toBeDefined();
    expect(content.hooks.PreToolUse).toBeDefined();
    expect(content.hooks.PostToolUse).toBeDefined();
    expect(content.hooks.Stop).toBeDefined();
    expect(content.hooks.PreCompact).toBeDefined();
    expect(content.hooks.UserPromptSubmit).toBeDefined();
  });

  it('preserves existing settings when installing hooks', () => {
    mkdirSync(resolve(TEST_DIR, '.claude'), { recursive: true });
    writeFileSync(resolve(TEST_DIR, '.claude/settings.local.json'), JSON.stringify({
      permissions: { allow: ['Bash'] },
      customSetting: 'preserved',
    }));

    installHooks(TEST_DIR);

    const content = JSON.parse(readFileSync(resolve(TEST_DIR, '.claude/settings.local.json'), 'utf-8'));
    expect(content.permissions).toEqual({ allow: ['Bash'] });
    expect(content.customSetting).toBe('preserved');
    expect(content.hooks).toBeDefined();
  });

  it('generates correct hook commands', () => {
    // P-003 (1.9.4+): commands now use `hook-runner <name>` (no `.js` suffix).
    const hooksConfig = buildHooksConfig('node_modules/@massu/core/dist/hooks');

    // P-E-019 (1.12.0): consolidated PreToolUse gate — single hook
    // covers BOTH security-gate AND pre-delete-check checks in one spawn.
    const preToolUse = hooksConfig.PreToolUse;
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].matcher).toBe('Bash|Write|Edit');
    expect(preToolUse[0].hooks[0].command).toContain('hook-runner pre-tool-use-gate');

    // PostToolUse has three groups: all-matcher (3 hooks), Edit|Write (3 hooks),
    // and Write-only (2 hooks for auto-learning pipelines).
    const postToolUse = hooksConfig.PostToolUse;
    expect(postToolUse).toHaveLength(3);
    expect(postToolUse[0].hooks).toHaveLength(3);
    expect(postToolUse[0].hooks[0].command).toContain('hook-runner post-tool-use');
    expect(postToolUse[0].hooks[1].command).toContain('hook-runner quality-event');
    expect(postToolUse[0].hooks[2].command).toContain('hook-runner cost-tracker');
    expect(postToolUse[1].matcher).toBe('Edit|Write');
    expect(postToolUse[1].hooks).toHaveLength(3);
    expect(postToolUse[1].hooks[0].command).toContain('hook-runner post-edit-context');
    expect(postToolUse[1].hooks[1].command).toContain('hook-runner fix-detector');
    expect(postToolUse[1].hooks[2].command).toContain('hook-runner classify-failure');
    expect(postToolUse[2].matcher).toBe('Write');
    expect(postToolUse[2].hooks).toHaveLength(2);
    expect(postToolUse[2].hooks[0].command).toContain('hook-runner incident-pipeline');
    expect(postToolUse[2].hooks[1].command).toContain('hook-runner rule-enforcement-pipeline');

    // Check Stop has session-end + auto-learning aggregation
    expect(hooksConfig.Stop[0].hooks).toHaveLength(2);
    expect(hooksConfig.Stop[0].hooks[0].command).toContain('hook-runner session-end');
    expect(hooksConfig.Stop[0].hooks[1].command).toContain('hook-runner auto-learning-pipeline');

    // Check PreCompact
    expect(hooksConfig.PreCompact[0].hooks[0].command).toContain('hook-runner pre-compact');

    // Check UserPromptSubmit (plan-living-memory-slice-1: +memory-recall = 3)
    const userPrompt = hooksConfig.UserPromptSubmit;
    expect(userPrompt[0].hooks).toHaveLength(3);
    expect(userPrompt[0].hooks[0].command).toContain('hook-runner user-prompt');
    expect(userPrompt[0].hooks[1].command).toContain('hook-runner intent-suggester');
    expect(userPrompt[0].hooks[2].command).toContain('hook-runner memory-recall');
  });

  it('counts all 16 hooks correctly (P-E-019 consolidated 2 PreToolUse → 1; +memory-recall)', () => {
    // 1 PreToolUse (consolidated gate) + 8 PostToolUse (3+3+2) + 2 Stop +
    // 1 PreCompact + 3 UserPromptSubmit + 1 SessionStart = 16
    const hooksConfig = buildHooksConfig('test/path');
    let count = 0;
    for (const groups of Object.values(hooksConfig)) {
      for (const group of groups) {
        count += group.hooks.length;
      }
    }
    expect(count).toBe(16);
  });
});
