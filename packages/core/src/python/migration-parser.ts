// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

export interface MigrationOperation {
  type:
    | 'create_table'
    | 'drop_table'
    | 'add_column'
    | 'drop_column'
    | 'alter_column'
    | 'create_index'
    | 'other';
  table?: string;
  column?: string;
  details?: string;
}

export interface ParsedMigration {
  revision: string;
  downRevision: string | null;
  description: string | null;
  operations: MigrationOperation[];
}

/**
 * Extract a string assignment value from source.
 * Handles: revision = 'abc123' and revision = "abc123"
 */
function extractStringVar(source: string, varName: string): string | null {
  const re = new RegExp(`^${varName}\\s*(?::\\s*\\w+)?\\s*=\\s*['"]([^'"]*)['"]\s*$`, 'm');
  const m = source.match(re);
  return m ? m[1] : null;
}

/**
 * Extract a variable that can be a string or None.
 * Handles: down_revision = None, down_revision = 'abc', down_revision: ... = None
 */
function extractNullableStringVar(source: string, varName: string): string | null {
  // Check for None first
  const noneRe = new RegExp(`^${varName}\\s*(?::\\s*[^=]+)?\\s*=\\s*None\\s*$`, 'm');
  if (noneRe.test(source)) return null;

  return extractStringVar(source, varName);
}

/**
 * Extract the description from the module docstring or revision message.
 * Alembic typically puts it in a comment like: """description here"""
 * or in the Revision ID comment block.
 */
function extractDescription(source: string): string | null {
  // Try triple-quoted module docstring
  const docMatch = source.match(/^"""(.*?)"""/ms);
  if (docMatch) {
    const firstLine = docMatch[1].trim().split('\n')[0].trim();
    if (firstLine && !firstLine.startsWith('Revision ID')) {
      return firstLine;
    }
  }

  // Try single-line comment after "Revises:" block
  const descMatch = source.match(/^#\s*Revision ID:\s*\w+\n#\s*Revises:\s*\w*\n#\s*Create Date:\s*.+\n\n"""(.+?)"""/m);
  if (descMatch) return descMatch[1].trim();

  // Try the first triple-quoted string content that looks like a description
  const tripleMatch = source.match(/"""([^"]+?)(?:\n\nRevision ID|\n\n|""")/);
  if (tripleMatch) {
    const desc = tripleMatch[1].trim();
    if (desc && desc.length < 200) return desc;
  }

  return null;
}

/**
 * Extract the body of the upgrade() function.
 */
function extractFunctionBody(source: string, funcName: string): string {
  const funcRe = new RegExp(`^def\\s+${funcName}\\s*\\([^)]*\\)\\s*(?:->\\s*\\w+)?\\s*:`, 'm');
  const match = funcRe.exec(source);
  if (!match) return '';

  const startIndex = match.index + match[0].length;
  const lines = source.substring(startIndex).split('\n');
  const bodyLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Empty lines are part of the body
    if (line.trim() === '') {
      bodyLines.push(line);
      continue;
    }
    // If line starts with indent (space or tab), it's part of the body
    if (line.startsWith(' ') || line.startsWith('\t')) {
      bodyLines.push(line);
    } else {
      // Hit a non-indented line — end of function
      break;
    }
  }

  return bodyLines.join('\n');
}

/**
 * Extract the first quoted string argument from an op call.
 * e.g., op.create_table('users', ...) -> 'users'
 */
function extractFirstStringArg(argsStr: string): string | null {
  const m = argsStr.match(/['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

/**
 * Extract table and column from op calls that take (table, column, ...).
 * e.g., op.add_column('users', sa.Column('email', ...)) -> { table: 'users', column: 'email' }
 */
function extractTableAndColumn(argsStr: string): { table: string | null; column: string | null } {
  const parts = splitTopLevelCommas(argsStr);
  const table = parts[0] ? extractFirstStringArg(parts[0]) : null;

  // For add_column, the second arg is sa.Column('name', ...)
  let column: string | null = null;
  if (parts[1]) {
    const colMatch = parts[1].match(/Column\s*\(\s*['"]([^'"]+)['"]/);
    if (colMatch) {
      column = colMatch[1];
    } else {
      // For drop_column, it's just a string: op.drop_column('table', 'column')
      column = extractFirstStringArg(parts[1]);
    }
  }

  return { table, column };
}

/**
 * Split a string by top-level commas (not inside parens/brackets/strings).
 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      current += ch;
      if (ch === inString && text[i - 1] !== '\\') {
        inString = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = ch;
      current += ch;
      continue;
    }

    if (ch === '(' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Parse operations from the upgrade function body.
 */
function parseOperations(body: string): MigrationOperation[] {
  const operations: MigrationOperation[] = [];

  // Join multi-line op calls
  const joinedBody = joinOpCalls(body);
  const lines = joinedBody.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // op.create_table(...)
    const createTableMatch = trimmed.match(/op\.create_table\s*\((.+)\)/s);
    if (createTableMatch) {
      const tableName = extractFirstStringArg(createTableMatch[1]);
      operations.push({
        type: 'create_table',
        table: tableName || undefined,
      });
      continue;
    }

    // op.drop_table(...)
    const dropTableMatch = trimmed.match(/op\.drop_table\s*\((.+)\)/s);
    if (dropTableMatch) {
      const tableName = extractFirstStringArg(dropTableMatch[1]);
      operations.push({
        type: 'drop_table',
        table: tableName || undefined,
      });
      continue;
    }

    // op.add_column(...)
    const addColMatch = trimmed.match(/op\.add_column\s*\((.+)\)/s);
    if (addColMatch) {
      const { table, column } = extractTableAndColumn(addColMatch[1]);
      operations.push({
        type: 'add_column',
        table: table || undefined,
        column: column || undefined,
      });
      continue;
    }

    // op.drop_column(...)
    const dropColMatch = trimmed.match(/op\.drop_column\s*\((.+)\)/s);
    if (dropColMatch) {
      const { table, column } = extractTableAndColumn(dropColMatch[1]);
      operations.push({
        type: 'drop_column',
        table: table || undefined,
        column: column || undefined,
      });
      continue;
    }

    // op.alter_column(...)
    const alterColMatch = trimmed.match(/op\.alter_column\s*\((.+)\)/s);
    if (alterColMatch) {
      const { table, column } = extractTableAndColumn(alterColMatch[1]);
      operations.push({
        type: 'alter_column',
        table: table || undefined,
        column: column || undefined,
        details: trimmed,
      });
      continue;
    }

    // op.create_index(...)
    const createIdxMatch = trimmed.match(/op\.create_index\s*\((.+)\)/s);
    if (createIdxMatch) {
      const parts = splitTopLevelCommas(createIdxMatch[1]);
      const indexName = parts[0] ? extractFirstStringArg(parts[0]) : null;
      const tableName = parts[1] ? extractFirstStringArg(parts[1]) : null;
      operations.push({
        type: 'create_index',
        table: tableName || undefined,
        details: indexName ? `index: ${indexName}` : undefined,
      });
      continue;
    }

    // Any other op.xxx(...) call
    const otherOpMatch = trimmed.match(/op\.(\w+)\s*\((.+)\)/s);
    if (otherOpMatch) {
      operations.push({
        type: 'other',
        details: `op.${otherOpMatch[1]}(...)`,
      });
    }
  }

  return operations;
}

/**
 * Join multi-line op.xxx() calls into single lines.
 */
function joinOpCalls(body: string): string {
  const lines = body.split('\n');
  const result: string[] = [];
  let current = '';
  let openParens = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (current === '' && !trimmed.startsWith('op.')) {
      result.push(line);
      continue;
    }

    current += (current ? ' ' : '') + trimmed;

    for (const ch of trimmed) {
      if (ch === '(') openParens++;
      else if (ch === ')') openParens = Math.max(0, openParens - 1);
    }

    if (openParens === 0) {
      result.push(current);
      current = '';
    }
  }

  if (current) result.push(current);
  return result.join('\n');
}

/**
 * Parse an Alembic migration file and extract revision info and operations.
 */
export function parseAlembicMigration(source: string): ParsedMigration {
  const revision = extractStringVar(source, 'revision') || '';
  const downRevision = extractNullableStringVar(source, 'down_revision');
  const description = extractDescription(source);

  const upgradeBody = extractFunctionBody(source, 'upgrade');
  const operations = parseOperations(upgradeBody);

  return {
    revision,
    downRevision,
    description,
    operations,
  };
}
