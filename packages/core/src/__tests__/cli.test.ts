// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('creates massu.config.yaml', () => {
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
  });

  it('skips if config already exists', () => {
    writeFileSync(resolve(TEST_DIR, 'massu.config.yaml'), 'existing: true\n');
    const framework = { type: 'typescript', router: 'none', orm: 'none', ui: 'none' };
    const created = generateConfig(TEST_DIR, framework);
    expect(created).toBe(false);

    const content = readFileSync(resolve(TEST_DIR, 'massu.config.yaml'), 'utf-8');
    expect(content).toBe('existing: true\n');
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
    expect(content.mcpServers.massu.args).toEqual(['-y', '@massu/core']);
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
    expect(count).toBe(11);

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
    const hooksConfig = buildHooksConfig('node_modules/@massu/core/dist/hooks');

    // Check PreToolUse has security-gate and pre-delete-check
    const preToolUse = hooksConfig.PreToolUse;
    expect(preToolUse).toHaveLength(2);
    expect(preToolUse[0].matcher).toBe('Bash');
    expect(preToolUse[0].hooks[0].command).toContain('security-gate.js');
    expect(preToolUse[1].matcher).toBe('Bash|Write');
    expect(preToolUse[1].hooks[0].command).toContain('pre-delete-check.js');

    // Check PostToolUse has all 4 hooks
    const postToolUse = hooksConfig.PostToolUse;
    expect(postToolUse).toHaveLength(2);
    expect(postToolUse[0].hooks).toHaveLength(3);
    expect(postToolUse[0].hooks[0].command).toContain('post-tool-use.js');
    expect(postToolUse[0].hooks[1].command).toContain('quality-event.js');
    expect(postToolUse[0].hooks[2].command).toContain('cost-tracker.js');
    expect(postToolUse[1].matcher).toBe('Edit|Write');
    expect(postToolUse[1].hooks[0].command).toContain('post-edit-context.js');

    // Check Stop has session-end
    expect(hooksConfig.Stop[0].hooks[0].command).toContain('session-end.js');

    // Check PreCompact
    expect(hooksConfig.PreCompact[0].hooks[0].command).toContain('pre-compact.js');

    // Check UserPromptSubmit
    const userPrompt = hooksConfig.UserPromptSubmit;
    expect(userPrompt[0].hooks).toHaveLength(2);
    expect(userPrompt[0].hooks[0].command).toContain('user-prompt.js');
    expect(userPrompt[0].hooks[1].command).toContain('intent-suggester.js');
  });

  it('counts all 11 hooks correctly', () => {
    const hooksConfig = buildHooksConfig('test/path');
    let count = 0;
    for (const groups of Object.values(hooksConfig)) {
      for (const group of groups) {
        count += group.hooks.length;
      }
    }
    expect(count).toBe(11);
  });
});
