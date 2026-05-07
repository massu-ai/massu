/**
 * Tests for the @massu/core/adapter SDK (Plan 3c gap-31 + gap-35).
 *
 * Coverage:
 * - defineAdapter is identity at runtime
 * - The CodebaseAdapter type is exported (compile-time check)
 * - Sample adapter spec round-trips through defineAdapter unchanged
 * - All re-exported types are reachable from the SDK module
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  defineAdapter,
  type CodebaseAdapter,
  type DetectionSignals,
  type SourceFile,
  type AdapterResult,
  type TreeSitterLanguage,
} from '../adapter.js';

describe('defineAdapter', () => {
  it('returns the spec unchanged at runtime (identity function)', () => {
    const spec: CodebaseAdapter = {
      id: 'test-adapter',
      languages: ['python'],
      matches: () => true,
      introspect: async () => ({
        conventions: {},
        provenance: [],
        confidence: 'low',
      }),
    };
    const result = defineAdapter(spec);
    // Identity check: same object reference.
    expect(result).toBe(spec);
  });

  it('preserves all fields verbatim', () => {
    const matches = (signals: DetectionSignals) => Boolean(signals.gemfile);
    const introspect = async (_files: SourceFile[]): Promise<AdapterResult> => ({
      conventions: { router: 'rails' },
      provenance: [],
      confidence: 'high',
    });
    const spec = defineAdapter({
      id: 'rails-active-record',
      languages: ['ruby'],
      matches,
      introspect,
    });
    expect(spec.id).toBe('rails-active-record');
    expect(spec.languages).toEqual(['ruby']);
    expect(spec.matches).toBe(matches);
    expect(spec.introspect).toBe(introspect);
  });
});

describe('SDK type re-exports (compile-time)', () => {
  it('CodebaseAdapter type is reachable', () => {
    expectTypeOf<CodebaseAdapter>().toMatchTypeOf<{
      id: string;
      languages: TreeSitterLanguage[];
      matches: (signals: DetectionSignals) => boolean;
    }>();
  });

  it('DetectionSignals type has the expected shape', () => {
    expectTypeOf<DetectionSignals>().toMatchTypeOf<{
      packageJson?: Record<string, unknown>;
      pyprojectToml?: Record<string, unknown>;
      gemfile?: string;
      cargoToml?: Record<string, unknown>;
      goMod?: string;
      presentDirs: Set<string>;
      presentFiles: Set<string>;
    }>();
  });

  it('SourceFile type is exported', () => {
    expectTypeOf<SourceFile>().toMatchTypeOf<{
      relativePath: string;
      content: string;
    }>();
  });

  it('AdapterResult type is exported', () => {
    expectTypeOf<AdapterResult>().toMatchTypeOf<{
      conventions: Record<string, unknown>;
      confidence: 'high' | 'medium' | 'low' | 'none';
    }>();
  });
});
