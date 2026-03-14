// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

export interface ModelColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface ModelRelationship {
  name: string;
  target: string;
  back_populates: string | null;
}

export interface ModelForeignKey {
  column: string;
  target: string; // "table.column"
}

export interface ParsedModel {
  className: string;
  tableName: string | null;
  columns: ModelColumn[];
  relationships: ModelRelationship[];
  foreignKeys: ModelForeignKey[];
  line: number;
}

/** Known SA base classes that indicate a model class. */
const BASE_CLASSES = new Set(['Base', 'DeclarativeBase', 'db.Model']);

/**
 * Check if a class definition inherits from a known SQLAlchemy base.
 */
function isModelClass(bases: string): boolean {
  const parts = bases.split(',').map((s) => s.trim());
  return parts.some((b) => BASE_CLASSES.has(b));
}

/**
 * Extract type name from SA 1.x Column() first argument.
 * e.g., Column(Integer, ...) -> "Integer"
 * e.g., Column(String(255), ...) -> "String(255)"
 */
function extractColumnType(argsStr: string): string {
  const trimmed = argsStr.trim();
  // Match the first argument which is the type
  // Handle callable types like String(255), Numeric(10,2)
  const m = trimmed.match(/^([A-Za-z_]\w*(?:\([^)]*\))?)/);
  return m ? m[1] : 'Unknown';
}

/**
 * Extract type from Mapped[type] annotation.
 * e.g., Mapped[int] -> "int", Mapped[Optional[str]] -> "Optional[str]"
 */
function extractMappedType(annotation: string): string {
  const m = annotation.match(/Mapped\[(.+)\]/);
  return m ? m[1] : annotation;
}

/**
 * Check if args contain nullable=False or nullable=True.
 * Default depends on context: Column defaults to nullable=True.
 */
function extractNullable(argsStr: string): boolean {
  const m = argsStr.match(/nullable\s*=\s*(True|False)/);
  if (m) return m[1] === 'True';
  // Default: nullable=True for Column, for Mapped it depends on Optional
  return true;
}

/**
 * Check if args contain primary_key=True.
 */
function extractPrimaryKey(argsStr: string): boolean {
  return /primary_key\s*=\s*True/.test(argsStr);
}

/**
 * Extract ForeignKey target from Column args.
 * e.g., Column(Integer, ForeignKey("users.id")) -> "users.id"
 */
function extractForeignKeys(columnName: string, argsStr: string): ModelForeignKey[] {
  const keys: ModelForeignKey[] = [];
  const re = /ForeignKey\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = re.exec(argsStr)) !== null) {
    keys.push({ column: columnName, target: match[1] });
  }
  return keys;
}

/**
 * Extract relationship target and back_populates.
 * e.g., relationship("User", back_populates="posts") -> { target: "User", back_populates: "posts" }
 */
function parseRelationship(argsStr: string): { target: string; back_populates: string | null } | null {
  const targetMatch = argsStr.match(/['"](\w+)['"]/);
  if (!targetMatch) return null;

  const bpMatch = argsStr.match(/back_populates\s*=\s*['"](\w+)['"]/);
  return {
    target: targetMatch[1],
    back_populates: bpMatch ? bpMatch[1] : null,
  };
}

/**
 * Find the matching closing paren/bracket, handling nesting.
 */
function findClosingParen(text: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 1;
  for (let i = openIndex + 1; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Get the full argument string inside balanced parentheses starting after a keyword.
 * Returns the content between the outermost parens.
 */
function getBalancedArgs(line: string, keyword: string): string | null {
  const idx = line.indexOf(keyword);
  if (idx === -1) return null;
  const parenStart = line.indexOf('(', idx + keyword.length);
  if (parenStart === -1) return null;
  const parenEnd = findClosingParen(line, parenStart, '(', ')');
  if (parenEnd === -1) return null;
  return line.substring(parenStart + 1, parenEnd);
}

/**
 * Parse SQLAlchemy model definitions from Python source code.
 */
export function parsePythonModels(source: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  const lines = source.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const classMatch = line.match(/^class\s+(\w+)\s*\(([^)]+)\)\s*:/);

    if (!classMatch) {
      i++;
      continue;
    }

    const className = classMatch[1];
    const bases = classMatch[2];
    const classLine = i + 1; // 1-based

    // Determine if this is a model class
    let isModel = isModelClass(bases);

    // We'll also check for __tablename__ inside the class body
    const columns: ModelColumn[] = [];
    const relationships: ModelRelationship[] = [];
    const foreignKeys: ModelForeignKey[] = [];
    let tableName: string | null = null;

    i++;

    // Parse class body (indented lines)
    while (i < lines.length) {
      const bodyLine = lines[i];

      // End of class body: non-empty line at column 0 that isn't a blank line
      if (bodyLine.length > 0 && !bodyLine.startsWith(' ') && !bodyLine.startsWith('\t') && bodyLine.trim() !== '') {
        break;
      }

      const trimmed = bodyLine.trim();

      // Parse __tablename__
      const tnMatch = trimmed.match(/^__tablename__\s*=\s*['"](\w+)['"]/);
      if (tnMatch) {
        tableName = tnMatch[1];
        isModel = true;
        i++;
        continue;
      }

      // Join multi-line statements within class body
      let fullLine = trimmed;
      if (fullLine) {
        let openP = 0;
        for (const ch of fullLine) {
          if (ch === '(') openP++;
          else if (ch === ')') openP--;
        }
        while (openP > 0 && i + 1 < lines.length) {
          i++;
          const nextLine = lines[i].trim();
          fullLine += ' ' + nextLine;
          for (const ch of nextLine) {
            if (ch === '(') openP++;
            else if (ch === ')') openP--;
          }
        }
      }

      // SA 1.x: name = Column(...)
      const col1Match = fullLine.match(/^(\w+)\s*=\s*Column\s*\(/);
      if (col1Match) {
        const colName = col1Match[1];
        const argsStr = getBalancedArgs(fullLine, 'Column');
        if (argsStr) {
          const colType = extractColumnType(argsStr);
          const nullable = extractNullable(argsStr);
          const primaryKey = extractPrimaryKey(argsStr);
          columns.push({ name: colName, type: colType, nullable, primaryKey });
          foreignKeys.push(...extractForeignKeys(colName, argsStr));
        }
        i++;
        continue;
      }

      // SA 2.0: name: Mapped[type] = mapped_column(...)
      const col2Match = fullLine.match(/^(\w+)\s*:\s*(Mapped\[.+?\])\s*=\s*mapped_column\s*\(/);
      if (col2Match) {
        const colName = col2Match[1];
        const mappedAnnotation = col2Match[2];
        const argsStr = getBalancedArgs(fullLine, 'mapped_column');
        const mappedType = extractMappedType(mappedAnnotation);
        const nullable = mappedType.startsWith('Optional') || extractNullable(argsStr || '');
        const primaryKey = extractPrimaryKey(argsStr || '');
        columns.push({ name: colName, type: mappedType, nullable, primaryKey });
        if (argsStr) {
          foreignKeys.push(...extractForeignKeys(colName, argsStr));
        }
        i++;
        continue;
      }

      // relationship()
      const relMatch = fullLine.match(/^(\w+)\s*(?::\s*[^=]+)?\s*=\s*relationship\s*\(/);
      if (relMatch) {
        const relName = relMatch[1];
        const argsStr = getBalancedArgs(fullLine, 'relationship');
        if (argsStr) {
          const parsed = parseRelationship(argsStr);
          if (parsed) {
            relationships.push({
              name: relName,
              target: parsed.target,
              back_populates: parsed.back_populates,
            });
          }
        }
        i++;
        continue;
      }

      i++;
    }

    if (isModel) {
      models.push({
        className,
        tableName,
        columns,
        relationships,
        foreignKeys,
        line: classLine,
      });
    }
  }

  return models;
}
