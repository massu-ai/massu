// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * CLAUDE.md content generation — framework-aware templates and directory scanning.
 *
 * Used by `massu init` to generate a tailored CLAUDE.md for the detected project.
 */

import { readdirSync, statSync } from 'fs';
import { resolve, relative, basename } from 'path';

// ============================================================
// Types (re-used from init.ts but kept minimal to avoid circular deps)
// ============================================================

interface FrameworkInfo {
  type: string;
  router: string;
  orm: string;
  ui: string;
}

interface PythonInfo {
  detected: boolean;
  root: string;
  hasFastapi: boolean;
  hasSqlalchemy: boolean;
  hasAlembic: boolean;
}

// ============================================================
// Directory Structure Scanner (P-A03)
// ============================================================

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '.massu', '.turbo', '.cache', '.output',
]);

export function scanDirectoryStructure(projectRoot: string, maxDepth: number = 2): string {
  const lines: string[] = [];
  const rootName = basename(projectRoot);
  lines.push(`${rootName}/`);
  scanLevel(projectRoot, '', maxDepth, 0, lines);
  return lines.join('\n');
}

function scanLevel(
  dir: string,
  prefix: string,
  maxDepth: number,
  currentDepth: number,
  lines: string[],
): void {
  if (currentDepth >= maxDepth) return;

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }

  // Separate dirs and files, filter excluded
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') && EXCLUDED_DIRS.has(entry)) continue;
    if (EXCLUDED_DIRS.has(entry)) continue;
    try {
      const stat = statSync(resolve(dir, entry));
      if (stat.isDirectory()) dirs.push(entry);
      else files.push(entry);
    } catch {
      // Skip unreadable entries
    }
  }

  const allEntries = [...dirs, ...files];
  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    const isLast = i === allEntries.length - 1;
    const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 ';
    const childPrefix = isLast ? '    ' : '\u2502   ';
    const isDir = dirs.includes(entry);

    lines.push(`${prefix}${connector}${entry}${isDir ? '/' : ''}`);

    if (isDir) {
      scanLevel(resolve(dir, entry), prefix + childPrefix, maxDepth, currentDepth + 1, lines);
    }
  }
}

// ============================================================
// Content Builder (P-A02)
// ============================================================

export function buildClaudeMdContent(
  projectName: string,
  projectRoot: string,
  framework: FrameworkInfo,
  python: PythonInfo,
): string {
  const sections: string[] = [];

  // 1. Project Overview
  sections.push(buildProjectOverview(projectName, framework, python));

  // 2. Tech Stack
  sections.push(buildTechStack(framework, python));

  // 3. Directory Structure
  sections.push(buildDirectorySection(projectRoot));

  // 4. Coding Conventions
  sections.push(buildCodingConventions(framework, python));

  // 5. Testing
  sections.push(buildTestingSection(framework, python));

  // 6. Massu Workflow
  sections.push(buildMassuWorkflow());

  // 7. Memory System
  sections.push(buildMemorySystem());

  // 8. Critical Rules
  sections.push(buildCriticalRules());

  return sections.join('\n\n---\n\n') + '\n';
}

// ---- Section Builders ----

function buildProjectOverview(
  projectName: string,
  framework: FrameworkInfo,
  python: PythonInfo,
): string {
  const stack: string[] = [];
  if (framework.type !== 'javascript') stack.push(capitalize(framework.type));
  if (framework.ui !== 'none') stack.push(formatUiName(framework.ui));
  if (framework.router !== 'none') stack.push(framework.router.toUpperCase());
  if (framework.orm !== 'none') stack.push(capitalize(framework.orm));
  if (python.detected) {
    stack.push('Python');
    if (python.hasFastapi) stack.push('FastAPI');
  }

  const stackStr = stack.length > 0 ? stack.join(', ') : 'JavaScript';

  return `# ${projectName}

## Project Overview

${projectName} is a ${stackStr} project.

<!-- Add a brief description of what this project does -->`;
}

function buildTechStack(framework: FrameworkInfo, python: PythonInfo): string {
  const rows: string[] = [];
  rows.push('| Technology | Details |');
  rows.push('|-----------|---------|');

  rows.push(`| Language | ${capitalize(framework.type)} |`);
  if (framework.ui !== 'none') rows.push(`| UI Framework | ${formatUiName(framework.ui)} |`);
  if (framework.router !== 'none') rows.push(`| Router/API | ${framework.router.toUpperCase()} |`);
  if (framework.orm !== 'none') rows.push(`| ORM | ${capitalize(framework.orm)} |`);
  if (python.detected) {
    rows.push('| Python | Yes |');
    if (python.hasFastapi) rows.push('| Python Framework | FastAPI |');
    if (python.hasSqlalchemy) rows.push('| Python ORM | SQLAlchemy |');
    if (python.hasAlembic) rows.push('| Migrations | Alembic |');
  }

  return `## Tech Stack\n\n${rows.join('\n')}`;
}

function buildDirectorySection(projectRoot: string): string {
  const tree = scanDirectoryStructure(projectRoot);
  return `## Directory Structure\n\n\`\`\`\n${tree}\n\`\`\``;
}

function buildCodingConventions(framework: FrameworkInfo, python: PythonInfo): string {
  const rules: string[] = [];

  // Language-level conventions
  if (framework.type === 'typescript') {
    rules.push('- Use ESM imports (`import`), not CommonJS (`require`)');
    rules.push('- Enable strict TypeScript (`strict: true` in tsconfig.json)');
    rules.push('- Prefer explicit types over `any`');
  }

  // UI framework conventions
  switch (framework.ui) {
    case 'nextjs':
      rules.push('- Use App Router conventions (`app/` directory)');
      rules.push('- Default to Server Components; add `"use client"` only when needed');
      rules.push('- Use `next/image` for images, `next/link` for navigation');
      rules.push('- API routes go in `app/api/` using Route Handlers');
      break;
    case 'sveltekit':
      rules.push('- Use load functions for data fetching (`+page.server.ts`)');
      rules.push('- Use form actions for mutations');
      rules.push('- Server-only code in `+server.ts` files');
      break;
    case 'react':
      rules.push('- Prefer functional components with hooks');
      rules.push('- Colocate component, styles, and tests');
      break;
  }

  // Router conventions
  if (framework.router === 'trpc') {
    rules.push('- Define tRPC routers with Zod input validation');
    rules.push('- Keep router files focused (one domain per router)');
  }

  // ORM conventions
  if (framework.orm === 'prisma') {
    rules.push('- Define models in `prisma/schema.prisma`');
    rules.push('- Run `npx prisma generate` after schema changes');
  } else if (framework.orm === 'drizzle') {
    rules.push('- Define schemas with Drizzle table builders');
    rules.push('- Run migrations with `drizzle-kit`');
  }

  // Python conventions
  if (python.detected) {
    rules.push('- Use type hints for function signatures');
    rules.push('- Use `async def` for async endpoints');
    if (python.hasFastapi) {
      rules.push('- Use Pydantic models for request/response schemas');
      rules.push('- Organize routes with `APIRouter`');
    }
    if (python.hasSqlalchemy) {
      rules.push('- Use SQLAlchemy 2.0 style (select/insert builders)');
    }
  }

  if (rules.length === 0) {
    rules.push('- Follow consistent naming conventions');
    rules.push('- Keep functions small and focused');
  }

  return `## Coding Conventions\n\n${rules.join('\n')}`;
}

function buildTestingSection(framework: FrameworkInfo, python: PythonInfo): string {
  const lines: string[] = [];

  if (framework.type === 'typescript') {
    lines.push('- Test framework: vitest (or jest)');
    lines.push('- Test files: `__tests__/*.test.ts` or `*.test.ts` colocated');
    lines.push('- Run tests: `npm test`');
  }

  if (python.detected) {
    lines.push('- Python tests: pytest');
    lines.push('- Test files: `tests/` directory or `test_*.py` files');
    lines.push('- Run: `pytest`');
  }

  if (lines.length === 0) {
    lines.push('- Configure a test framework for this project');
    lines.push('- Run tests before committing changes');
  }

  return `## Testing\n\n${lines.join('\n')}`;
}

function buildMassuWorkflow(): string {
  return `## Massu Workflow

This project uses [Massu AI](https://massu.ai) for development governance.

### Common Commands

| Command | Purpose |
|---------|---------|
| \`/massu-create-plan\` | Create an implementation plan |
| \`/massu-plan\` | Audit and improve a plan |
| \`/massu-golden-path\` | Full implementation flow (plan to push) |
| \`/massu-test\` | Run tests with failure analysis |
| \`/massu-commit\` | Pre-commit verification gate |
| \`/massu-push\` | Pre-push verification gate |
| \`/massu-status\` | Project health dashboard |
| \`/massu-debug\` | Systematic debugging |

### Workflow Flow

\`\`\`
/massu-create-plan -> /massu-plan (audit) -> /massu-golden-path (implement + push)
\`\`\``;
}

function buildMemorySystem(): string {
  return `## Memory System

Massu maintains persistent memory across sessions in \`~/.claude/projects/.../memory/\`.

- **User memories**: Your role, preferences, and expertise
- **Feedback memories**: Corrections and validated approaches
- **Project memories**: Ongoing work, decisions, deadlines
- **Reference memories**: External resources and tools

Memory is automatically loaded at session start and updated as you work.`;
}

function buildCriticalRules(): string {
  return `## Critical Rules

1. **Never commit secrets** — no API keys, tokens, or credentials in code
2. **Run tests before committing** — all tests must pass
3. **Verify before claiming done** — use VR-* verification checks
4. **Fix all issues encountered** — pre-existing issues get fixed too
5. **Read before editing** — understand existing code before modifying

<!-- Add project-specific rules as you discover them -->`;
}

// ---- Helpers ----

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatUiName(name: string): string {
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
