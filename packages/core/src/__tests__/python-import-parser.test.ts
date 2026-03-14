// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { parsePythonImports } from '../python/import-parser.ts';

describe('python-import-parser', () => {
  it('parses absolute import', () => {
    const result = parsePythonImports('import os');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'absolute', module: 'os', names: [], level: 0 });
  });

  it('parses dotted absolute import', () => {
    const result = parsePythonImports('import os.path');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'absolute', module: 'os.path' });
  });

  it('parses import with alias', () => {
    const result = parsePythonImports('import numpy as np');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'absolute', module: 'numpy', alias: 'np' });
  });

  it('parses from import', () => {
    const result = parsePythonImports('from os import path');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'from_absolute', module: 'os', names: ['path'], level: 0 });
  });

  it('parses from import with multiple names', () => {
    const result = parsePythonImports('from os.path import join, dirname, exists');
    expect(result).toHaveLength(1);
    expect(result[0].names).toEqual(['join', 'dirname', 'exists']);
  });

  it('parses wildcard import', () => {
    const result = parsePythonImports('from os import *');
    expect(result).toHaveLength(1);
    expect(result[0].names).toEqual(['*']);
  });

  it('parses relative import level 1', () => {
    const result = parsePythonImports('from . import utils');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'from_relative', level: 1 });
  });

  it('parses relative import level 2', () => {
    const result = parsePythonImports('from ..models import User');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'from_relative', level: 2, names: ['User'] });
  });

  it('parses relative import level 3', () => {
    const result = parsePythonImports('from ...core.db import engine');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ level: 3, names: ['engine'] });
  });

  it('parses multi-line parenthesized import', () => {
    const source = `from app.models import (
    User,
    Post,
    Comment,
)`;
    const result = parsePythonImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].names).toEqual(['User', 'Post', 'Comment']);
  });

  it('skips TYPE_CHECKING imports', () => {
    const source = `from app.models import User

if TYPE_CHECKING:
    from app.schemas import UserSchema
    from app.deps import AuthDep

from app.core import settings`;
    const result = parsePythonImports(source);
    expect(result).toHaveLength(2);
    expect(result[0].names).toEqual(['User']);
    expect(result[1].names).toEqual(['settings']);
  });

  it('skips comment lines', () => {
    const source = `# This is a comment
import os
# from fake import thing
from app import real`;
    const result = parsePythonImports(source);
    expect(result).toHaveLength(2);
  });

  it('handles multiple imports on one line', () => {
    const result = parsePythonImports('import os, sys, json');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty source', () => {
    expect(parsePythonImports('')).toHaveLength(0);
  });

  it('assigns correct line numbers', () => {
    const source = `import os

from app import main`;
    const result = parsePythonImports(source);
    expect(result[0].line).toBe(1);
    expect(result[1].line).toBe(3);
  });
});
