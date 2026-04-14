# Massu

## Project Overview

AI Engineering Governance Platform — an MCP server with Claude Code integration. Monorepo with core package at `packages/core`.

## Tech Stack

| Technology | Details |
|-----------|---------|
| Language | TypeScript (ESM) |
| Runtime | Node.js 18+ |
| Database | better-sqlite3 (local storage) |
| Protocol | Raw JSON-RPC 2.0 over stdio (MCP) |
| Config | YAML (`massu.config.yaml`) |
| Build | esbuild (hooks), tsc (type checking) |
| Testing | vitest |

## Key Paths

| Purpose | Path |
|---------|------|
| MCP Server entry | `packages/core/src/server.ts` |
| Tool definitions & routing | `packages/core/src/tools.ts` |
| Config loader | `packages/core/src/config.ts` |
| Hook sources | `packages/core/src/hooks/*.ts` |
| Tests | `packages/core/src/__tests__/*.test.ts` |
| Config file | `massu.config.yaml` |
| CLI entry | `packages/core/src/cli.ts` |
| Commands | `packages/core/src/commands/` |

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm test` | Run all vitest tests |
| `npm run build` | Type check + compile hooks |
| `cd packages/core && npm run build:hooks` | Compile hooks only |
| `cd packages/core && npx tsc --noEmit` | Type check only |
| `bash scripts/massu-pattern-scanner.sh` | Pattern compliance |

## Coding Conventions

- Use ESM imports (`import`), not CommonJS (`require`)
- All imports must include `.ts` extension (pattern scanner enforced)
- Config access via `getConfig()` from `config.ts` — never parse YAML directly
- Tool prefix is configurable via `massu.config.yaml` (default: `massu_`)
- New MCP tools use 3-function pattern: `getDefs()` + `isTool()` + `handleCall()`
- Hooks receive JSON on stdin, output JSON on stdout, exit within 5 seconds
- Database access: `getCodeGraphDb()` (read-only), `getDataDb()`, `getMemoryDb()` (close after use)

## Critical Rules

1. Never commit secrets — no API keys, tokens, or credentials
2. All tests must pass before committing (`npm test`)
3. Pattern scanner must pass (`bash scripts/massu-pattern-scanner.sh`)
4. New MCP tools must be registered in `tools.ts` (CR-11)
5. Hooks must compile with esbuild (CR-12)
6. No hardcoded project-specific data — use config lookups
7. Always close `memDb` after use (try/finally pattern)

See `.claude/CLAUDE.md` for full development documentation.
