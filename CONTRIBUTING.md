# Contributing to Massu

Thank you for your interest in contributing to Massu! This document explains how to contribute effectively.

## Contributor License Agreement (CLA)

Before we can accept your contribution, you must sign our [Contributor License Agreement](CLA.md). This is required for all contributions, including bug fixes.

## How Contributions Work

The public `massu` repository is a **read-only mirror** of our internal development repository. Here's how the contribution flow works:

1. You open a Pull Request on this public repository
2. We review your PR on GitHub
3. If approved, we port your changes into our internal repository
4. Your changes are synced back to this public repo via our automated sync process
5. We close your original PR with a note referencing the sync commit

This means your PR will not be merged directly via GitHub's merge button — but your changes will appear in the repository and you will be credited.

## Development Setup

### Prerequisites

- Node.js 20+
- npm 10+

### Getting Started

```bash
# Clone the repository
git clone https://github.com/massu-ai/massu.git
cd massu

# Install dependencies
npm install

# Run tests
npm test

# Type check
cd packages/core && npx tsc --noEmit

# Build hooks
cd packages/core && npm run build:hooks

# Run pattern scanner
bash scripts/massu-pattern-scanner.sh
```

### Project Structure

```
massu/
  packages/
    core/          # MCP Server (@massu/core)
  scripts/         # Build and quality scripts
  docs/            # Documentation
  examples/        # Example configurations
  .claude/         # Claude Code configuration
    commands/      # Slash commands
    hooks/         # Lifecycle hooks
  massu.config.yaml  # Project configuration
```

## Making Changes

### Code Style

- TypeScript with ESM modules (use `import`, not `require()`)
- Config access via `getConfig()` from `config.ts` (never parse YAML directly)
- Tool names use configurable prefix via `massu.config.yaml`
- All hooks must compile with esbuild and use JSON stdin/stdout

### Testing

All changes must pass the existing test suite:

```bash
# Run all tests
npm test

# Type check
cd packages/core && npx tsc --noEmit

# Pattern compliance
bash scripts/massu-pattern-scanner.sh
```

### Adding MCP Tools

New MCP tools follow the 3-function pattern:

1. `getXToolDefinitions()` — Returns tool definitions
2. `isXTool(name)` — Returns boolean for tool name matching
3. `handleXToolCall(name, args, ...)` — Handles tool execution

All three functions must be wired into `packages/core/src/tools.ts`.

## Pull Request Guidelines

1. **One feature per PR** — Keep PRs focused and reviewable
2. **Tests required** — Add tests for new functionality
3. **All checks must pass** — Tests, type check, pattern scanner
4. **Clear description** — Explain what your change does and why
5. **No breaking changes** — Or clearly document them in the PR description

## Local Development Troubleshooting

### `better-sqlite3` native binding missing

**Symptom**: 695+ test failures in `packages/core` with `db.close()`
undefined in `afterEach` cleanup; `Error: Cannot find module
'@better-sqlite3/...'`.

**Cause**: When Node version changes (e.g. upgrade from 22 → 26) or
when `node_modules` was created on a different machine architecture
(ARM vs x86_64), the prebuilt `better-sqlite3` native binding mismatch
causes silent failures.

**Fix**: rebuild from source:

```bash
cd packages/core
npm rebuild better-sqlite3
```

Reference: R-011 — never misdiagnose as Node incompat without testing
on a working version first.

### Pattern Scanner BSD-awk noise on macOS

**Symptom**: `bash scripts/massu-pattern-scanner.sh` emits awk noise on
macOS.

**Cause**: macOS ships BSD awk; older versions of the scanner used
GNU-style `\(` escapes.

**Fix**: The scanner (as of @massu/core@1.12.0, plan
`plan-stage-e-low-info-sweep` P-E-003) auto-detects `gawk` when
available. If you still see noise, install GNU awk: `brew install gawk`.

## Reporting Issues

- Use [GitHub Issues](https://github.com/massu-ai/massu/issues) to report bugs
- Include steps to reproduce, expected behavior, and actual behavior
- For security vulnerabilities, please email security@massu.ai instead of opening a public issue

## License

By contributing to Massu, you agree that your contributions will be licensed under the same [Business Source License 1.1](LICENSE) that covers the project.
