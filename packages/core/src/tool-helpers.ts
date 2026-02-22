// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { getConfig } from './config.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
}

/** Get the configured tool prefix (e.g., 'massu' or 'myapp') */
function prefix(): string {
  return getConfig().toolPrefix;
}

/** Prefix a base tool name with the configured tool prefix. */
export function p(baseName: string): string {
  return `${prefix()}_${baseName}`;
}

/**
 * Strip the configured prefix from a tool name to get the base name.
 * e.g., "massu_sync" -> "sync", "massu_memory_search" -> "memory_search"
 */
export function stripPrefix(name: string): string {
  const pfx = prefix() + '_';
  if (name.startsWith(pfx)) {
    return name.slice(pfx.length);
  }
  return name;
}

/** Create a text tool result. */
export function text(content: string): ToolResult {
  return { content: [{ type: 'text', text: content }] };
}
