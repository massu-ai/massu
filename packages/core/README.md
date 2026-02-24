# @massu/core

AI Engineering Governance MCP Server — session memory, feature registry, code intelligence, and rule enforcement for AI coding assistants.

## Quick Start

```bash
npx massu init
```

This sets up the MCP server, configuration, and lifecycle hooks in one command.

## What is Massu?

Massu is a source-available [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that adds governance capabilities to AI coding assistants like Claude Code. It provides:

- **51 MCP Tools** — quality analytics, cost tracking, security scoring, dependency analysis, and more
- **11 Lifecycle Hooks** — pre-commit gates, security scanning, intent suggestion, and session management
- **3-Database Architecture** — code graph (read-only), data (imports/mappings), and memory (sessions/analytics)
- **Config-Driven** — all project-specific data lives in `massu.config.yaml`

## Usage

After `npx massu init`, your AI assistant gains access to all governance tools automatically via the MCP protocol.

```bash
# Health check
npx massu doctor

# Validate configuration
npx massu validate-config
```

## Documentation

Full documentation at [massu.ai](https://massu.ai).

## License

[BSL 1.1](https://github.com/massu-ai/massu/blob/main/LICENSE) — source-available. Free to use, modify, and distribute. See LICENSE for full terms.
