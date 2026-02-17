# @massu/plugin

Claude Code plugin for Massu AI - planned future work.

## Status

This package is a placeholder for the planned Claude Code plugin integration. The plugin will provide:

- Custom slash commands (`/massu-create-plan`, `/massu-loop`, `/massu-commit`, `/massu-push`)
- Agent workflows for automated plan execution
- Hook registration for Claude Code lifecycle events
- Direct integration with the `@massu/core` MCP server

## Current Architecture

The Massu platform currently operates as an MCP server (`@massu/core`) that Claude Code connects to via the MCP protocol. The plugin package will provide a more tightly integrated experience with:

1. **Commands** - Registered slash commands that trigger plan-driven workflows
2. **Agents** - Autonomous agents for multi-step plan execution with verification
3. **Hooks** - Lifecycle hooks that capture session context automatically

## Development

This package is not yet implemented. See `packages/core/` for the active MCP server implementation.

## License

BSL 1.1 - See [LICENSE](../../LICENSE) for details.
