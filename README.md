# Massu

**AI Engineering Governance Platform**

Session memory, feature registry, code intelligence, and rule enforcement for AI coding assistants.

---

## What is Massu?

Massu is an MCP server and Claude Code plugin that transforms AI coding assistants from general-purpose tools into governed engineering environments. It provides:

- **Session Memory** — Cross-session learning with automatic observation capture, failure recall, and full-text search
- **Knowledge System** — 12 tools for indexing codebase knowledge, team patterns, ADRs, and searchable insights across sessions (Pro tier)
- **Feature Registry (Sentinel)** — Track features, detect impact before deletion, verify parity during rebuilds
- **Code Intelligence** — Import chain analysis, backend-frontend coupling detection, domain boundary enforcement
- **Rule Engine** — Contextual coding rules surfaced automatically when editing files
- **Documentation Sync** — Detect when docs drift from code changes
- **Observability** — Session replay, prompt analysis, tool usage patterns, cost tracking
- **Auto-Learning Pipeline** — Automatically turns bug fixes into enforced rules: fix detection → incident report → prevention rule → enforcement hook
- **Shell Hooks** — 15 lifecycle hooks (session-start, session-end, pre-delete-check, security-gate, fix-detector, auto-learning-pipeline, and more)

## Why?

AI coding assistants generate code fast. But speed without governance creates:
- Security vulnerabilities no one reviews
- Architectural drift no one notices
- Features that silently break during refactors
- Knowledge that dies when sessions end

Massu was born from **22 real production incidents** building enterprise software with AI. Every feature exists because something went wrong without it.

## Tiers

Massu uses a tiered model. All hooks and commands are free. Tools are gated by tier:

| Tier | Tools | What You Get |
|------|-------|--------------|
| **Free** | 13 tools | Core navigation, basic memory, regression detection, license status |
| **Pro** | 48 tools | Everything in Free + knowledge system (12 tools), advanced memory, analytics, cost tracking, observability, docs |
| **Team** | 57 tools | Everything in Pro + sentinel feature registry, team knowledge sharing |
| **Enterprise** | 63 tools | Everything in Team + audit trail, security scoring, dependency analysis |

All 15 lifecycle hooks and all 43 slash commands are included at every tier.

## Quick Start

```bash
# Install
npm install @massu/core

# One-command setup (detects framework, creates config, registers MCP, installs hooks and commands)
npx massu init

# Start Claude Code — everything is active
claude
```

That's it. `massu init` automatically:
- Detects your framework (TypeScript, Next.js, Prisma, tRPC, etc.)
- Creates `massu.config.yaml` with detected settings
- Registers the MCP server in `.mcp.json`
- Installs all 15 lifecycle hooks in `.claude/settings.local.json`
- Installs all 43 slash commands into `.claude/commands/`
- Databases auto-create on first session

To verify your installation:

```bash
npx massu doctor
```

To update slash commands independently (e.g., after upgrading `@massu/core`):

```bash
npx massu install-commands
```

### Unlocking Pro Features

Free tier includes 13 tools. To unlock all 63 tools:

```bash
# Add your API key (get one at https://massu.ai/dashboard/api-keys)
npx massu init --api-key YOUR_API_KEY

# Or set it in massu.config.yaml:
# license:
#   key: "massu_pro_..."
```

Use the `massu_license_status` tool in any session to check your current tier and available tools.

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
