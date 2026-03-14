// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// Python Import Statement Parser
// ============================================================

/**
 * Represents a single parsed Python import statement.
 */
export interface PythonImport {
  /** The kind of import: plain absolute, plain relative, from-absolute, or from-relative. */
  type: 'absolute' | 'relative' | 'from_absolute' | 'from_relative';
  /** The module path, e.g. "os.path" or "..utils". */
  module: string;
  /** Imported names (empty for plain `import x` statements). */
  names: string[];
  /** Alias when `import x as alias` is used. */
  alias?: string;
  /** Relative import level: 0 for absolute, 1 for `.`, 2 for `..`, etc. */
  level: number;
  /** 1-based line number where the import statement begins. */
  line: number;
}

/**
 * Parse all Python import statements from source code.
 *
 * Handles:
 * - `import x`, `import x.y.z`, `import x as alias`, `import x, y, z`
 * - `from x import y`, `from x import y, z`, `from x import *`
 * - `from . import x`, `from ..x import y`, `from ...x.y import z`
 * - Multi-line parenthesized imports: `from x import (\n  a,\n  b\n)`
 * - Skips `if TYPE_CHECKING:` blocks
 * - Strips comments
 *
 * @param source - Python source code
 * @returns Array of parsed imports in source order
 */
export function parsePythonImports(source: string): PythonImport[] {
  const lines = source.split('\n');
  const results: PythonImport[] = [];

  /** State machine modes. */
  type Mode = 'normal' | 'multiline' | 'type_checking';
  let mode: Mode = 'normal';

  // Multiline accumulation state
  let multilineBuffer = '';
  let multilineStartLine = 0;

  // TYPE_CHECKING block tracking
  let typeCheckingIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1; // 1-based

    // ── TYPE_CHECKING block detection ──────────────────────
    if (mode === 'normal') {
      const tcMatch = rawLine.match(/^(\s*)if\s+TYPE_CHECKING\s*:/);
      if (tcMatch) {
        mode = 'type_checking';
        typeCheckingIndent = tcMatch[1].length;
        continue;
      }
    }

    if (mode === 'type_checking') {
      // Stay in type_checking mode until we see a line that is:
      // - non-empty, non-comment, and at the same or lesser indentation
      const stripped = rawLine.replace(/#.*$/, '').trimEnd();
      if (stripped.length === 0) continue; // blank or comment-only line
      const currentIndent = rawLine.match(/^(\s*)/)?.[1].length ?? 0;
      if (currentIndent <= typeCheckingIndent) {
        // Dedented — exit TYPE_CHECKING block, process this line normally
        mode = 'normal';
        typeCheckingIndent = -1;
        // Fall through to normal processing below
      } else {
        continue; // Still inside TYPE_CHECKING block
      }
    }

    // ── Multiline continuation ─────────────────────────────
    if (mode === 'multiline') {
      const cleaned = stripComment(rawLine);
      multilineBuffer += ' ' + cleaned.trim();
      if (cleaned.includes(')')) {
        // Close the multiline import
        mode = 'normal';
        const parsed = parseFromImportLine(multilineBuffer, multilineStartLine);
        if (parsed) results.push(parsed);
        multilineBuffer = '';
      }
      continue;
    }

    // ── Normal mode ────────────────────────────────────────
    const line = stripComment(rawLine).trim();

    // Skip blank lines
    if (line.length === 0) continue;

    // Detect multiline from-import with opening paren but no closing paren
    if (line.startsWith('from ') && line.includes('(') && !line.includes(')')) {
      mode = 'multiline';
      multilineBuffer = line;
      multilineStartLine = lineNum;
      continue;
    }

    // from ... import ...
    if (line.startsWith('from ')) {
      const parsed = parseFromImportLine(line, lineNum);
      if (parsed) results.push(parsed);
      continue;
    }

    // import ...
    if (line.startsWith('import ')) {
      const imports = parsePlainImportLine(line, lineNum);
      results.push(...imports);
      continue;
    }
  }

  return results;
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Strip an inline `# comment` from a line, respecting strings minimally.
 * For import lines this is sufficient since import syntax doesn't contain `#`.
 */
function stripComment(line: string): string {
  // If the line is a pure comment, return empty
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return '';

  const hashIdx = line.indexOf('#');
  if (hashIdx === -1) return line;
  return line.slice(0, hashIdx);
}

/**
 * Count leading dots in a module string and return the level + remaining module.
 */
function splitRelativePrefix(raw: string): { level: number; rest: string } {
  let level = 0;
  while (level < raw.length && raw[level] === '.') {
    level++;
  }
  return { level, rest: raw.slice(level) };
}

/**
 * Parse a `from X import Y` line (possibly with parentheses already joined).
 */
function parseFromImportLine(line: string, lineNum: number): PythonImport | null {
  // Normalize: remove parens, collapse whitespace
  const cleaned = line
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Pattern: from <module> import <names>
  const match = cleaned.match(/^from\s+(\S+)\s+import\s+(.+)$/);
  if (!match) return null;

  const rawModule = match[1];
  const namesStr = match[2];

  const { level, rest } = splitRelativePrefix(rawModule);
  const isRelative = level > 0;

  const module = rawModule;

  // Parse names: split by comma, trim, handle `name as alias` per name
  const names = namesStr
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map((n) => {
      // Handle `name as alias` — store just the name in the names array
      const asMatch = n.match(/^(\S+)\s+as\s+(\S+)$/);
      return asMatch ? asMatch[1] : n;
    });

  return {
    type: isRelative ? 'from_relative' : 'from_absolute',
    module,
    names,
    level,
    line: lineNum,
  };
}

/**
 * Parse a plain `import X` line, which may contain multiple comma-separated modules.
 *
 * Examples:
 * - `import os` → one result
 * - `import os, sys, re` → three results
 * - `import os.path as osp` → one result with alias
 */
function parsePlainImportLine(line: string, lineNum: number): PythonImport[] {
  const results: PythonImport[] = [];

  // Strip leading "import "
  const rest = line.replace(/^import\s+/, '');

  // Split by comma
  const parts = rest.split(',').map((p) => p.trim()).filter((p) => p.length > 0);

  for (const part of parts) {
    // Check for `module as alias`
    const asMatch = part.match(/^(\S+)\s+as\s+(\S+)$/);
    const moduleName = asMatch ? asMatch[1] : part;
    const alias = asMatch ? asMatch[2] : undefined;

    const { level } = splitRelativePrefix(moduleName);
    const isRelative = level > 0;

    const imp: PythonImport = {
      type: isRelative ? 'relative' : 'absolute',
      module: moduleName,
      names: [],
      level,
      line: lineNum,
    };

    if (alias !== undefined) {
      imp.alias = alias;
    }

    results.push(imp);
  }

  return results;
}
