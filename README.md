# Massu

[![npm version](https://img.shields.io/npm/v/@massu/core)](https://www.npmjs.com/package/@massu/core)
[![CI](https://github.com/ethankowen-73/massu/actions/workflows/ci.yml/badge.svg)](https://github.com/ethankowen-73/massu/actions/workflows/ci.yml)
[![License: BSL 1.1](https://img.shields.io/badge/License-BSL_1.1-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)

**AI Engineering Governance Platform**

Session memory, feature registry, code intelligence, and rule enforcement for AI coding assistants.

---

## What is Massu?

Massu is an MCP server and Claude Code plugin that transforms AI coding assistants from general-purpose tools into governed engineering environments. It provides:

- **Session Memory** — Cross-session learning with automatic observation capture, failure recall, and full-text search
- **Feature Registry (Sentinel)** — Track features, detect impact before deletion, verify parity during rebuilds
- **Code Intelligence** — Import chain analysis, backend-frontend coupling detection, domain boundary enforcement
- **Rule Engine** — Contextual coding rules surfaced automatically when editing files
- **Documentation Sync** — Detect when docs drift from code changes
- **Observability** — Session replay, prompt analysis, tool usage patterns, cost tracking

## Why?

AI coding assistants generate code fast. But speed without governance creates:
- Security vulnerabilities no one reviews
- Architectural drift no one notices
- Features that silently break during refactors
- Knowledge that dies when sessions end

Massu was born from **22 real production incidents** building enterprise software with AI. Every feature exists because something went wrong without it.

## Quick Start

```bash
# Install
npm install @massu/core

# One-command setup (detects framework, creates config, registers MCP, installs hooks)
npx massu init

# Start Claude Code — everything is active
claude
```

That's it. `massu init` automatically:
- Detects your framework (TypeScript, Next.js, Prisma, tRPC, etc.)
- Creates `massu.config.yaml` with detected settings
- Registers the MCP server in `.mcp.json`
- Installs all 11 lifecycle hooks in `.claude/settings.local.json`
- Databases auto-create on first session

To verify your installation:

```bash
npx massu doctor
```

## Documentation

Full documentation is available in the [`docs/`](docs/) directory:

- [Getting Started](docs/getting-started/) — Installation, configuration, first run
- [Features](docs/features/) — Detailed feature documentation
- [Commands](docs/commands/) — All available slash commands
- [Guides](docs/guides/) — How-to guides and best practices
- [Hooks](docs/hooks/) — Lifecycle hook documentation
- [Reference](docs/reference/) — API and configuration reference

Or visit the full docs site at [massu.ai/docs](https://massu.ai/docs).

## Cloud Features

For team collaboration, cloud sync, and advanced analytics, visit [massu.ai](https://massu.ai).

## Configuration

Massu is configured via `massu.config.yaml` in your project root. See `examples/` for full configurations:

- `examples/nextjs-trpc/` — Next.js + tRPC + Prisma + Supabase (enterprise)

## Architecture

```
massu/
  packages/
    core/                    # MCP Server (published as @massu/core)
      src/
        server.ts            # MCP JSON-RPC transport over stdio
        tools.ts             # Tool definitions and routing (51 MCP tools)
        config.ts            # YAML config loader
        memory-*.ts          # Session memory subsystem
        sentinel-*.ts        # Feature registry subsystem
        *-tools.ts           # Tool modules (3-function pattern)
        hooks/               # 11 lifecycle hooks (esbuild-compiled)
      dist/                  # Compiled output
    plugin/                  # Claude Code plugin (private)
  .claude/
    commands/                # 20 workflow slash commands
  scripts/                   # Build and quality scripts
  docs/                      # Documentation (mirrors massu.ai/docs)
  examples/                  # Example configurations
  massu.config.yaml          # Project configuration
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## Security

To report a security vulnerability, please see [SECURITY.md](SECURITY.md).

## License

[Business Source License 1.1](LICENSE) — free for non-commercial and limited production use. Converts to Apache 2.0 on February 14, 2029.
