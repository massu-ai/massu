// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

export interface ParsedRoute {
  method: string;
  path: string;
  functionName: string;
  dependencies: string[];
  requestModel: string | null;
  responseModel: string | null;
  isAuthenticated: boolean;
  line: number;
}

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
]);

const BASIC_TYPES = new Set([
  'str',
  'int',
  'float',
  'bool',
  'bytes',
  'list',
  'dict',
  'set',
  'tuple',
  'Any',
  'None',
  'Optional',
  'Request',
  'Response',
  'Query',
  'Path',
  'Header',
  'Cookie',
  'Body',
  'Form',
  'File',
  'UploadFile',
  'BackgroundTasks',
  'HTTPException',
  'Depends',
  'Session',
  'AsyncSession',
]);

/**
 * Join logical lines that are split across multiple physical lines.
 * Handles backslash continuations and unclosed parentheses/brackets.
 */
function joinLogicalLines(source: string): { text: string; startLine: number }[] {
  const physicalLines = source.split('\n');
  const logical: { text: string; startLine: number }[] = [];
  let current = '';
  let startLine = 0;
  let openParens = 0;
  let openBrackets = 0;

  for (let i = 0; i < physicalLines.length; i++) {
    const raw = physicalLines[i];
    if (current === '') {
      startLine = i + 1; // 1-based
    }

    // Strip trailing backslash continuation
    const continued = raw.trimEnd().endsWith('\\');
    const line = continued ? raw.trimEnd().slice(0, -1) : raw;

    current += (current ? ' ' : '') + line;

    // Count parens/brackets (ignoring those inside strings for simplicity)
    for (const ch of line) {
      if (ch === '(') openParens++;
      else if (ch === ')') openParens = Math.max(0, openParens - 1);
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets = Math.max(0, openBrackets - 1);
    }

    if (!continued && openParens === 0 && openBrackets === 0) {
      logical.push({ text: current, startLine });
      current = '';
    }
  }

  if (current) {
    logical.push({ text: current, startLine });
  }

  return logical;
}

/**
 * Extract the first quoted string from a text segment.
 */
function extractQuotedString(text: string): string | null {
  const m = text.match(/(['"])(.*?)\1/);
  return m ? m[2] : null;
}

/**
 * Extract response_model value from a decorator argument string.
 */
function extractResponseModel(argStr: string): string | null {
  const m = argStr.match(/response_model\s*=\s*([A-Za-z_][A-Za-z0-9_.\[\]]*)/);
  return m ? m[1] : null;
}

/**
 * Extract methods list from api_route decorator.
 */
function extractApiRouteMethods(argStr: string): string[] {
  const m = argStr.match(/methods\s*=\s*\[([^\]]*)\]/);
  if (!m) return [];
  const inner = m[1];
  const methods: string[] = [];
  const re = /['"](\w+)['"]/g;
  let match;
  while ((match = re.exec(inner)) !== null) {
    methods.push(match[1].toUpperCase());
  }
  return methods;
}

/**
 * Parse Depends() calls from function parameters.
 */
function extractDependencies(paramStr: string): string[] {
  const deps: string[] = [];
  const re = /Depends\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)/g;
  let match;
  while ((match = re.exec(paramStr)) !== null) {
    deps.push(match[1]);
  }
  return deps;
}

/**
 * Parse function parameters for request body models.
 * A request body parameter is a type-annotated param whose type is not
 * a basic/framework type and not assigned via Depends/Query/Path/etc.
 */
function extractRequestModel(paramStr: string): string | null {
  // Split params by comma, respecting nested parens
  const params = splitParams(paramStr);

  for (const param of params) {
    const trimmed = param.trim();
    // Skip self, cls, *args, **kwargs
    if (/^(self|cls|\*\*?\w*)$/.test(trimmed.split(/[\s:=]/)[0].trim())) continue;
    // Skip if has Depends, Query, Path, Header, Cookie, Form, File, Body assignment
    if (/=\s*(Depends|Query|Path|Header|Cookie|Form|File|Body)\s*\(/.test(trimmed)) continue;

    // Look for type annotation: name: Type
    const annotationMatch = trimmed.match(/^\s*(\w+)\s*:\s*([A-Za-z_][A-Za-z0-9_.\[\]|]*)/);
    if (annotationMatch) {
      const typeName = annotationMatch[2].replace(/\s/g, '');
      // Strip Optional[], List[], etc wrappers to get base type
      const baseType = typeName.replace(/^(Optional|List|Set|Tuple|Dict)\[/, '').replace(/\]$/, '').split('[')[0].split('|')[0];
      if (!BASIC_TYPES.has(baseType) && /^[A-Z]/.test(baseType)) {
        return baseType;
      }
    }
  }
  return null;
}

/**
 * Split parameter string by top-level commas (not inside parens/brackets).
 */
function splitParams(paramStr: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const ch of paramStr) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Parse FastAPI route decorators and their handler functions from Python source code.
 */
export function parsePythonRoutes(source: string): ParsedRoute[] {
  const routes: ParsedRoute[] = [];
  const logicalLines = joinLogicalLines(source);

  // Collect pending decorators, then match them to function defs
  interface PendingDecorator {
    method: string;
    path: string;
    responseModel: string | null;
    methods: string[]; // for api_route
    line: number;
  }

  const pendingDecorators: PendingDecorator[] = [];

  for (let i = 0; i < logicalLines.length; i++) {
    const { text, startLine } = logicalLines[i];
    const trimmed = text.trim();

    // Detect route decorator: @variable.method("path" ...) or @variable.api_route(...)
    const decoratorMatch = trimmed.match(
      /^@\s*(\w+)\s*\.\s*(\w+)\s*\((.*)\)\s*$/s,
    );

    if (decoratorMatch) {
      const methodName = decoratorMatch[2].toLowerCase();
      const argStr = decoratorMatch[3];

      if (methodName === 'api_route') {
        const path = extractQuotedString(argStr);
        if (path) {
          const methods = extractApiRouteMethods(argStr);
          const responseModel = extractResponseModel(argStr);
          pendingDecorators.push({
            method: 'API_ROUTE',
            path,
            responseModel,
            methods,
            line: startLine,
          });
        }
      } else if (HTTP_METHODS.has(methodName)) {
        const path = extractQuotedString(argStr);
        if (path) {
          const responseModel = extractResponseModel(argStr);
          pendingDecorators.push({
            method: methodName.toUpperCase(),
            path,
            responseModel,
            methods: [],
            line: startLine,
          });
        }
      }
      continue;
    }

    // Detect function definition
    const funcMatch = trimmed.match(
      /^(?:async\s+)?def\s+(\w+)\s*\((.*)\)\s*(?:->.*)?:\s*$/s,
    );

    if (funcMatch && pendingDecorators.length > 0) {
      const functionName = funcMatch[1];
      const paramStr = funcMatch[2];

      const dependencies = extractDependencies(paramStr);
      const requestModel = extractRequestModel(paramStr);

      const isAuthenticated = dependencies.some((dep) =>
        /auth|user|current_user/i.test(dep),
      );

      for (const dec of pendingDecorators) {
        if (dec.method === 'API_ROUTE') {
          // Expand api_route into one route per method
          const methods = dec.methods.length > 0 ? dec.methods : ['GET'];
          for (const m of methods) {
            routes.push({
              method: m,
              path: dec.path,
              functionName,
              dependencies,
              requestModel,
              responseModel: dec.responseModel,
              isAuthenticated,
              line: dec.line,
            });
          }
        } else {
          routes.push({
            method: dec.method,
            path: dec.path,
            functionName,
            dependencies,
            requestModel,
            responseModel: dec.responseModel,
            isAuthenticated,
            line: dec.line,
          });
        }
      }

      pendingDecorators.length = 0;
      continue;
    }

    // If we hit a non-decorator, non-function line, and there are pending decorators
    // that aren't followed by more decorators, clear them (they belong to something else)
    if (!trimmed.startsWith('@') && !trimmed.startsWith('def ') && !trimmed.startsWith('async def ')) {
      if (pendingDecorators.length > 0 && trimmed !== '') {
        pendingDecorators.length = 0;
      }
    }
  }

  return routes;
}
