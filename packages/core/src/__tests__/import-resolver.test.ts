// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { parseImports, resolveImportPath } from '../import-resolver.ts';

describe('parseImports', () => {
  it('parses named imports', () => {
    const source = `import { Foo, Bar } from '@/components/shared/Foo';`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0].type).toBe('named');
    expect(imports[0].names).toEqual(['Foo', 'Bar']);
    expect(imports[0].specifier).toBe('@/components/shared/Foo');
  });

  it('parses default imports', () => {
    const source = `import Database from 'better-sqlite3';`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0].type).toBe('default');
    expect(imports[0].names).toEqual(['Database']);
  });

  it('parses namespace imports', () => {
    const source = `import * as utils from './utils';`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0].type).toBe('namespace');
    expect(imports[0].names).toEqual(['utils']);
  });

  it('parses type imports', () => {
    const source = `import type { Database } from 'better-sqlite3';`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0].type).toBe('named');
    expect(imports[0].names).toEqual(['Database']);
  });

  it('parses side effect imports', () => {
    const source = `import './globals.css';`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0].type).toBe('side_effect');
    expect(imports[0].specifier).toBe('./globals.css');
  });

  it('parses dynamic imports', () => {
    const source = `const jsdom = await import('jsdom');`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0].type).toBe('dynamic');
    expect(imports[0].specifier).toBe('jsdom');
  });

  it('parses aliased imports', () => {
    const source = `import { Foo as Bar, Baz } from './module';`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0].names).toEqual(['Foo', 'Baz']);
  });

  it('handles multiple imports', () => {
    const source = `
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import type { FC } from 'react';
import './styles.css';
`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(4);
  });

  it('skips comments', () => {
    const source = `
// import { Foo } from './foo';
import { Bar } from './bar';
`;
    const imports = parseImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0].names).toEqual(['Bar']);
  });
});

describe('resolveImportPath', () => {
  it('returns null for bare/external imports', () => {
    expect(resolveImportPath('react', '/some/file.ts')).toBeNull();
    expect(resolveImportPath('next/navigation', '/some/file.ts')).toBeNull();
    expect(resolveImportPath('better-sqlite3', '/some/file.ts')).toBeNull();
  });

  // Note: resolveImportPath depends on file system, so we only test external filtering here.
  // Full integration tests would need actual file paths.
});
