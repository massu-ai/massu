// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// plan-v0.2-interactive-rule-approval P-D-010 acceptance tests:
// (a) known vars interpolate, (b) unknown var throws TemplateAllowlistError,
// (c) RCE attempts ALL throw TemplateAllowlistError (5+ cases),
// (d) template with no `${}` returns literal, (e) signals_csv interpolates
// as a pre-rendered string.

import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  TemplateAllowlistError,
  TemplateMissingValueError,
  listAllowedTemplateVars,
} from '../template-renderer.ts';

describe('template-renderer (RCE-safe)', () => {
  describe('(a) known vars interpolate', () => {
    it('renders the canonical example from the plan spec', () => {
      const out = renderTemplate(
        '## ${date}: ${prompt_preview}\n- score: ${score}\n- signals: ${signals_csv}\n',
        {
          date: '2026-05-20T12:00:00Z',
          prompt_preview: "use getConfig() instead of YAML",
          score: 90,
          signals_csv: 'strong_correction_phrase,prior_edit_or_write,bugfix_or_refactor_category',
        }
      );
      expect(out).toContain('## 2026-05-20T12:00:00Z: use getConfig() instead of YAML');
      expect(out).toContain('- score: 90');
      expect(out).toContain('- signals: strong_correction_phrase,prior_edit_or_write,bugfix_or_refactor_category');
    });

    it('renders the slug var', () => {
      expect(renderTemplate('rule_${slug}', { slug: 'fix_yaml_load' })).toBe('rule_fix_yaml_load');
    });

    it('renders the destination_name var', () => {
      expect(renderTemplate('# ${destination_name}', { destination_name: 'brand-voice' })).toBe('# brand-voice');
    });
  });

  describe('(b) unknown var throws TemplateAllowlistError', () => {
    it('rejects `${nope}` (no such var)', () => {
      expect(() => renderTemplate('${nope}', {})).toThrow(TemplateAllowlistError);
    });

    it('rejects `${unknown_thing}` (valid identifier, not in allowlist)', () => {
      expect(() => renderTemplate('${unknown_thing}', {})).toThrow(TemplateAllowlistError);
    });

    it('error names the unknown key + lists allowed vars', () => {
      try {
        renderTemplate('${nope}', {});
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TemplateAllowlistError);
        const e = err as TemplateAllowlistError;
        expect(e.key).toBe('nope');
        expect(e.allowedVars).toEqual(listAllowedTemplateVars());
      }
    });
  });

  describe('(c) RCE attempts ALL throw TemplateAllowlistError', () => {
    const rceAttempts = [
      '${process.exit(1)}',
      "${require('child_process')}",
      '${global}',
      '${this}',
      '${constructor}',
      '${eval("1+1")}',
      '${new Function("return 1")}',
      '${__proto__}',
      '${Object.assign({}, {})}',
    ];
    it.each(rceAttempts)('rejects %s', (template) => {
      expect(() => renderTemplate(template, {})).toThrow(TemplateAllowlistError);
    });

    it('rejects `${process}` — passes identifier shape but fails allowlist', () => {
      expect(() => renderTemplate('${process}', {})).toThrow(TemplateAllowlistError);
    });
  });

  describe('(d) template with no `${}` returns literal', () => {
    it('passes through plain text unchanged', () => {
      expect(renderTemplate('just literal text', {})).toBe('just literal text');
    });

    it('passes through unescaped dollar signs unchanged', () => {
      expect(renderTemplate('cost is $10', {})).toBe('cost is $10');
    });
  });

  describe('(e) signals_csv interpolates as a pre-rendered string', () => {
    it('renders the caller-prepared CSV verbatim', () => {
      const csv = 'strong_correction_phrase,negation_plus_instruction,bugfix_or_refactor_category';
      expect(renderTemplate('${signals_csv}', { signals_csv: csv })).toBe(csv);
    });
  });

  describe('missing-value errors', () => {
    it('throws TemplateMissingValueError when allowed var is undefined', () => {
      expect(() => renderTemplate('${score}', {})).toThrow(TemplateMissingValueError);
    });

    it('explicit empty-string value is fine (no throw)', () => {
      expect(renderTemplate('${slug}', { slug: '' })).toBe('');
    });
  });
});
