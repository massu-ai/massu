// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { getConfig, getProjectRoot } from './config.ts';
import type { ToolDefinition, ToolResult } from './tools.ts';

/** Prefix a base tool name with the configured tool prefix. */
function p(baseName: string): string {
  return `${getConfig().toolPrefix}_${baseName}`;
}

// ============================================================
// MCP Bridge: Cross-project tool mesh
// ============================================================

interface MCPServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  type?: string;
}

interface MCPConnection {
  config: MCPServerConfig;
  process: ChildProcess | null;
  connected: boolean;
  tools: MCPToolDef[];
  requestId: number;
}

interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Active MCP connections (module-level to persist across tool calls)
const connections = new Map<string, MCPConnection>();

// Clean up all MCP subprocesses on exit to prevent orphans
process.on('exit', () => {
  for (const [, conn] of connections) {
    if (conn.process && !conn.process.killed) {
      try { conn.process.kill('SIGTERM'); } catch { /* already dead */ }
    }
  }
});
process.on('SIGTERM', () => {
  for (const [name] of connections) disconnectServer(name);
});

// Environment variables safe to forward to MCP subprocesses.
// Generic for any Massu npm user — no project-specific hardcoding.
const ENV_ALLOW_LIST = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM',
  'PYTHONPATH', 'NODE_PATH',
]);
const ENV_DENY_PATTERNS = [
  'PRIVATE_KEY', 'SECRET_KEY', 'API_SECRET',
  'AUTH_DISABLED', 'COLD_STORAGE',
  'PASSWORD', 'TOKEN',
];

function buildSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // Derive safe env prefixes from the project name in massu.config.yaml.
  // e.g., project name "myapp" -> allow MYAPP_CONFIG_, MYAPP_LOG_ etc.
  // This makes the bridge work for any Massu user's project without hardcoding.
  const projectName = getConfig().project?.name?.toUpperCase() || '';
  const safePrefixes = projectName
    ? [`${projectName}_CONFIG_`, `${projectName}_LOG_`]
    : [];

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (ENV_DENY_PATTERNS.some(pat => key.includes(pat))) continue;
    if (ENV_ALLOW_LIST.has(key)) {
      env[key] = value;
    } else if (safePrefixes.length > 0 && safePrefixes.some(pfx => key.startsWith(pfx))) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Load MCP server configurations from .mcp.json in project root.
 * Only loads servers that are NOT the massu server itself (avoid self-connection).
 */
function loadMcpConfig(): Record<string, MCPServerConfig> {
  const root = getProjectRoot();
  const mcpPath = resolve(root, '.mcp.json');
  if (!existsSync(mcpPath)) return {};

  try {
    const raw = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    const servers: Record<string, MCPServerConfig> = {};
    const mcpServers = raw.mcpServers || {};
    const pfx = getConfig().toolPrefix;

    for (const [name, config] of Object.entries(mcpServers)) {
      // Skip self (the massu server)
      if (name === pfx) continue;
      servers[name] = config as MCPServerConfig;
    }
    return servers;
  } catch (e) {
    console.error('[mcp-bridge] Failed to parse .mcp.json:', e);
    return {};
  }
}

/**
 * Send a JSON-RPC 2.0 request to an MCP subprocess and wait for response.
 */
async function mcpRequest(
  conn: MCPConnection,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (!conn.process || !conn.process.stdin || !conn.process.stdout) {
    throw new Error('MCP process not connected');
  }

  conn.requestId++;
  const request = {
    jsonrpc: '2.0',
    id: conn.requestId,
    method,
    params,
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.process?.stdout?.removeListener('data', onData);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 30000);

    // Buffer partial chunks until we have a complete newline-delimited response
    let buffer = '';
    const onData = (data: Buffer) => {
      buffer += data.toString('utf-8');
      const lines = buffer.split('\n');
      // Keep the last incomplete chunk in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === conn.requestId) {
            clearTimeout(timeout);
            conn.process?.stdout?.removeListener('data', onData);
            if (response.error) {
              reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
            } else {
              resolve(response.result || {});
            }
            return;
          }
        } catch (e) {
          clearTimeout(timeout);
          conn.process?.stdout?.removeListener('data', onData);
          reject(new Error(`Failed to parse MCP response: ${e}`));
          return;
        }
      }
    };

    conn.process!.stdout!.on('data', onData);
    conn.process!.stdin!.write(JSON.stringify(request) + '\n');
  });
}

/**
 * Connect to an MCP server subprocess and perform handshake.
 */
async function connectToServer(name: string, config: MCPServerConfig): Promise<MCPConnection> {
  const existing = connections.get(name);
  if (existing?.connected && existing.process && !existing.process.killed) {
    return existing;
  }

  const root = getProjectRoot();
  const cwd = config.cwd ? resolve(root, config.cwd) : root;
  const args = config.args || [];

  const proc = spawn(config.command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildSubprocessEnv(),
  });

  const conn: MCPConnection = {
    config,
    process: proc,
    connected: false,
    tools: [],
    requestId: 0,
  };

  try {
    // Handshake
    await mcpRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'massu-mcp-bridge', version: '1.0.0' },
    });

    // Send initialized notification
    if (proc.stdin) {
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }) + '\n');
    }

    conn.connected = true;

    // Discover tools
    const toolsResult = await mcpRequest(conn, 'tools/list', {}) as { tools?: MCPToolDef[] };
    conn.tools = toolsResult.tools || [];

    // Store in map only after successful handshake
    connections.set(name, conn);
    return conn;
  } catch (e) {
    // Clean up on handshake failure — don't leave a broken connection in the map
    if (!proc.killed) proc.kill('SIGTERM');
    throw e;
  }
}

/**
 * Disconnect an MCP server.
 */
function disconnectServer(name: string): void {
  const conn = connections.get(name);
  if (conn) {
    conn.connected = false;
    if (conn.process && !conn.process.killed) {
      conn.process.kill('SIGTERM');
      // Escalate to SIGKILL if SIGTERM doesn't work within 3 seconds
      const proc = conn.process;
      setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, 3000);
    }
    connections.delete(name);
  }
}

function text(s: string): ToolResult {
  return { content: [{ type: 'text', text: s }] };
}

// ============================================================
// Tool Definitions
// ============================================================

export function getMcpBridgeToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: p('mcp_servers'),
      description: 'List all configured MCP servers from .mcp.json and their connection status.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: p('mcp_tools'),
      description: 'List tools available from a specific MCP server. Connects to the server if not already connected.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name from .mcp.json' },
        },
        required: ['server'],
      },
    },
    {
      name: p('mcp_call'),
      description: 'Call a tool on a connected MCP server. Connects automatically if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name from .mcp.json' },
          tool: { type: 'string', description: 'Tool name to call on the remote server' },
          arguments: {
            type: 'object',
            description: 'Arguments to pass to the remote tool',
            additionalProperties: true,
          },
        },
        required: ['server', 'tool'],
      },
    },
    {
      name: p('mcp_status'),
      description: 'Health check all MCP server connections. Shows which are connected, disconnected, or errored.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ];
}

export function isMcpBridgeTool(name: string): boolean {
  const pfx = getConfig().toolPrefix;
  return name.startsWith(`${pfx}_mcp_`);
}

export async function handleMcpBridgeToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const pfx = getConfig().toolPrefix;
  const baseName = name.startsWith(`${pfx}_`) ? name.slice(pfx.length + 1) : name;

  switch (baseName) {
    case 'mcp_servers':
      return handleMcpServers();
    case 'mcp_tools':
      return await handleMcpTools(args.server as string);
    case 'mcp_call':
      return await handleMcpCall(
        args.server as string,
        args.tool as string,
        (args.arguments as Record<string, unknown>) || {},
      );
    case 'mcp_status':
      return handleMcpStatus();
    default:
      return text(`Unknown MCP bridge tool: ${name}`);
  }
}

// ============================================================
// Tool Handlers
// ============================================================

function handleMcpServers(): ToolResult {
  const configs = loadMcpConfig();
  const servers = Object.entries(configs).map(([name, config]) => {
    const conn = connections.get(name);
    return {
      name,
      command: config.command,
      args: config.args || [],
      cwd: config.cwd || '.',
      status: conn?.connected ? 'connected' : 'disconnected',
      toolCount: conn?.tools.length || 0,
    };
  });

  if (servers.length === 0) {
    return text('No MCP servers configured in .mcp.json (excluding self).');
  }

  const lines = ['# MCP Servers\n'];
  for (const srv of servers) {
    const status = srv.status === 'connected' ? 'CONNECTED' : 'DISCONNECTED';
    lines.push(`- **${srv.name}** [${status}] — \`${srv.command} ${srv.args.join(' ')}\` (${srv.toolCount} tools)`);
  }
  return text(lines.join('\n'));
}

async function handleMcpTools(server: string): Promise<ToolResult> {
  const configs = loadMcpConfig();
  const config = configs[server];
  if (!config) {
    return text(`MCP server "${server}" not found in .mcp.json. Available: ${Object.keys(configs).join(', ') || 'none'}`);
  }

  try {
    const conn = await connectToServer(server, config);
    if (conn.tools.length === 0) {
      return text(`MCP server "${server}" is connected but has no tools.`);
    }

    const lines = [`# Tools from ${server} (${conn.tools.length})\n`];
    for (const tool of conn.tools) {
      lines.push(`- **${tool.name}**: ${tool.description}`);
    }
    return text(lines.join('\n'));
  } catch (e) {
    return text(`Failed to connect to MCP server "${server}": ${e}`);
  }
}

async function handleMcpCall(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const configs = loadMcpConfig();
  const config = configs[server];
  if (!config) {
    return text(`MCP server "${server}" not found in .mcp.json.`);
  }

  try {
    const conn = await connectToServer(server, config);
    const result = await mcpRequest(conn, 'tools/call', { name: tool, arguments: args });

    // MCP tools/call returns { content: [...] } or { content: [...], isError: true }
    const content = (result as any).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);
      if ((result as any).isError) {
        return text(`MCP tool error: ${texts.join('\n')}`);
      }
      return text(texts.join('\n'));
    }

    return text(JSON.stringify(result, null, 2));
  } catch (e) {
    // Mark as disconnected but don't delete — operator can see the failure in mcp_status
    const conn = connections.get(server);
    if (conn) conn.connected = false;
    return text(`MCP call failed (${server}/${tool}): ${e}`);
  }
}

function handleMcpStatus(): ToolResult {
  const configs = loadMcpConfig();
  const lines = ['# MCP Connection Status\n'];

  for (const [name] of Object.entries(configs)) {
    const conn = connections.get(name);
    if (!conn) {
      lines.push(`- **${name}**: NOT CONNECTED`);
    } else if (conn.connected && conn.process && !conn.process.killed) {
      lines.push(`- **${name}**: HEALTHY (pid=${conn.process.pid}, ${conn.tools.length} tools)`);
    } else {
      lines.push(`- **${name}**: DISCONNECTED`);
      disconnectServer(name);
    }
  }

  if (Object.keys(configs).length === 0) {
    lines.push('No MCP servers configured.');
  }

  return text(lines.join('\n'));
}
