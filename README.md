# Massu

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

## Cloud Features

For team collaboration, cloud sync, and advanced analytics, visit [massu.ai](https://massu.ai).

## Configuration

Massu is configured via `massu.config.yaml` in your project root. See `examples/` for full configurations:

- `examples/nextjs-trpc/` — Next.js + tRPC + Prisma + Supabase (enterprise)

## Architecture

```
@massu/core          # MCP Server (npm package)
  src/
    server.ts               # MCP JSON-RPC transport
    config.ts               # YAML config loader
    memory/                 # Session memory subsystem
    sentinel/               # Feature registry subsystem
    intelligence/           # Code analysis subsystem
    observability/          # Analytics subsystem
    hooks/                  # Lifecycle hooks

@massu/plugin        # Claude Code Plugin
  commands/                 # Slash commands
  agents/                   # Specialized subagents
  hooks/hooks.json          # Hook definitions
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## License

See [LICENSE](LICENSE) file (Business Source License 1.1).
