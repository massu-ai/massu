import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// plan-stage-d-medium-sweep P-M-002 drift-guard: post-tool-use.ts must
// module-scope-cache the parsed massu.config.yaml and invalidate via
// fs.statSync(...).mtimeMs comparison rather than re-parsing YAML on every
// tool call. Regression to per-call yaml.parse() is a hot-path latency leak.

const SRC = readFileSync(
  join(__dirname, '..', 'hooks', 'post-tool-use.ts'),
  'utf-8',
);

describe('P-M-002 post-tool-use config cache drift-guard', () => {
  it('module-scope cache variables exist for parsed conventions', () => {
    // Either `_cachedConventions` (the documented variable name in the plan)
    // or any module-level `let` with `Conventions` in its type annotation.
    const hasNamedCache = /_cachedConventions\s*[:=]/.test(SRC) || /cachedConventions\s*[:=]/.test(SRC);
    expect(hasNamedCache, 'expected a module-scope cache variable for parsed conventions').toBe(true);
  });

  it('cache invalidation reads file mtime via statSync', () => {
    // statSync may be imported from 'fs' alongside other helpers.
    expect(SRC).toMatch(/\bstatSync\b/);
    expect(SRC).toMatch(/mtimeMs/);
  });

  it('yaml.parse is invoked behind the cache, not unconditionally on every call', () => {
    // Find the parseYaml() call site (skip the import statement at the top
    // by locating the first invocation with an opening paren).
    const callMatch = /parseYaml\s*\(/.exec(SRC);
    expect(callMatch, 'expected at least one parseYaml() call').not.toBeNull();
    const upTo = SRC.slice(0, callMatch!.index);
    // mtime must appear somewhere before the parse call (cache invalidation
    // check). The cache-check branch reads mtimeMs and short-circuits.
    expect(upTo, 'parseYaml must be gated behind an mtime check').toMatch(/mtime/);
  });
});
