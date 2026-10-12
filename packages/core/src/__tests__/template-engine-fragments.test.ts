// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P4.3b-1 of docs/plans/2026-09-20-stack-conformant-asset-rendering.md — the `{{> name}}`
 * fragment directive.
 *
 * WHY IT EXISTS. 35 shipped assets carry massu's own examples — `- [ ] Wire into tools.ts`,
 * `packages/core/src/[FILL].ts` — inside content that is otherwise ~90% useful to any
 * customer. The vocabulary already solves the single-value case (`{{verify.test}}`); this is
 * its block-level equivalent, so the shared body stays in ONE file and only the
 * stack-specific slot varies.
 *
 * ⛔ THE CONTRACT THAT MATTERS MOST IS D5: AN UNRESOLVABLE FRAGMENT DEGRADES, NEVER THROWS.
 * `install-commands.ts:549-556` catches engine errors into `stats.skipped++` and exits 0, so
 * a throwing directive would turn a missing fragment into a SILENTLY ABSENT ASSET — the
 * exact failure the owning plan exists to end, reintroduced by its own fix.
 */

import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  matchFragmentToken,
  fragmentDiagnostic,
  FragmentNestingError,
} from '../commands/template-engine.ts';

const VARS = { verify: { test: 'pytest -q' }, paths: { source: 'app' } };

describe('matchFragmentToken — the name charset is a path-traversal surface', () => {
  it('accepts a plain name', () => {
    expect(matchFragmentToken('> feature-checklist')).toBe('feature-checklist');
    expect(matchFragmentToken('>feature_checklist')).toBe('feature_checklist');
    expect(matchFragmentToken('>  spaced  ')).toBe('spaced');
  });

  it('REFUSES anything that could escape the fragments directory', () => {
    // A fragment name becomes a FILENAME. `..`, `/` and `\` must be unrepresentable.
    for (const bad of ['> ../secrets', '> a/b', '> a\\b', '> ..', '> .hidden', '> -leading']) {
      expect(matchFragmentToken(bad), `${bad} must not parse as a fragment`).toBeNull();
    }
  });

  it('does not mistake an ordinary variable token for a fragment', () => {
    expect(matchFragmentToken('verify.test')).toBeNull();
    expect(matchFragmentToken('verify.build | default("x")')).toBeNull();
  });
});

describe('renderTemplate — fragment resolution', () => {
  it('splices the resolved body in place of the token', () => {
    const out = renderTemplate('before\n{{> chk}}\nafter', VARS, {
      resolveFragment: () => '- [ ] a step',
    });
    expect(out).toBe('before\n- [ ] a step\nafter');
  });

  it('renders the fragment body with the SAME vars (D3) — one level', () => {
    const out = renderTemplate('{{> chk}}', VARS, {
      resolveFragment: () => 'run `{{verify.test}}` in {{paths.source}}',
    });
    expect(out).toBe('run `pytest -q` in app');
  });

  it('passes the requested NAME to the resolver', () => {
    const seen: string[] = [];
    renderTemplate('{{> alpha}} {{> beta}}', VARS, {
      resolveFragment: (n) => {
        seen.push(n);
        return n.toUpperCase();
      },
    });
    expect(seen).toEqual(['alpha', 'beta']);
  });

  it('DEGRADES with a visible diagnostic when the resolver misses (D5)', () => {
    const out = renderTemplate('x {{> missing}} y', VARS, { resolveFragment: () => null });
    expect(out).toBe(`x ${fragmentDiagnostic('missing')} y`);
    expect(out).toContain('no fragment "missing"');
  });

  it('DEGRADES rather than throwing when no resolver is supplied at all', () => {
    // rule-candidate-applier renders learned-rule templates through a renderer with no
    // fragment support. It must not explode if one ever contains a fragment token.
    expect(() => renderTemplate('{{> chk}}', VARS)).not.toThrow();
    expect(renderTemplate('{{> chk}}', VARS)).toContain('no fragment "chk"');
  });

  it('REFUSES a nested fragment (D4) rather than detecting cycles', () => {
    expect(() =>
      renderTemplate('{{> outer}}', VARS, { resolveFragment: () => 'a {{> inner}} b' }),
    ).toThrow(FragmentNestingError);
  });

  it('a self-including fragment is caught by the same rule — no infinite loop', () => {
    expect(() =>
      renderTemplate('{{> loop}}', VARS, { resolveFragment: () => 'x {{> loop}} y' }),
    ).toThrow(FragmentNestingError);
  });

  it('leaves ordinary tokens and the \\{{ escape untouched', () => {
    expect(renderTemplate('{{verify.test}}', VARS, { resolveFragment: () => 'X' })).toBe('pytest -q');
    expect(renderTemplate('\\{{> chk}}', VARS, { resolveFragment: () => 'X' })).toBe('{{> chk}}');
  });

  it('is a NO-OP for a template containing no fragment (the migration control)', () => {
    // Every asset that has not been migrated must render byte-identically with the
    // directive present. If this fails, the directive changed existing output.
    const t = '# Title\n\nRun `{{verify.test}}` and see {{paths.source}}/x.\n';
    expect(renderTemplate(t, VARS, { resolveFragment: () => 'X' })).toBe(
      renderTemplate(t, VARS),
    );
  });
});
