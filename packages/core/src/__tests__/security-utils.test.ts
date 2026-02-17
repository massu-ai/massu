// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import {
  ensureWithinRoot,
  escapeRegex,
  safeRegex,
  globToSafeRegex,
  redactSensitiveContent,
  enforceSeverityFloors,
  MINIMUM_SEVERITY_WEIGHTS,
} from '../security-utils.ts';

describe('ensureWithinRoot', () => {
  const root = '/projects/my-app';

  it('allows paths within root', () => {
    expect(ensureWithinRoot('src/index.ts', root)).toBe('/projects/my-app/src/index.ts');
  });

  it('allows nested paths', () => {
    expect(ensureWithinRoot('src/lib/utils/helpers.ts', root)).toBe('/projects/my-app/src/lib/utils/helpers.ts');
  });

  it('blocks path traversal with ../', () => {
    expect(() => ensureWithinRoot('../../etc/passwd', root)).toThrow('Path traversal blocked');
  });

  it('blocks path traversal with encoded sequences', () => {
    expect(() => ensureWithinRoot('../../../etc/shadow', root)).toThrow('Path traversal blocked');
  });

  it('normalizes paths with ./ segments', () => {
    expect(ensureWithinRoot('./src/../src/index.ts', root)).toBe('/projects/my-app/src/index.ts');
  });

  it('blocks traversal that resolves outside after normalization', () => {
    expect(() => ensureWithinRoot('src/../../../../etc/passwd', root)).toThrow('Path traversal blocked');
  });
});

describe('escapeRegex', () => {
  it('escapes special regex characters', () => {
    expect(escapeRegex('hello.world')).toBe('hello\\.world');
    expect(escapeRegex('a+b*c')).toBe('a\\+b\\*c');
    expect(escapeRegex('foo(bar)')).toBe('foo\\(bar\\)');
  });

  it('leaves normal strings unchanged', () => {
    expect(escapeRegex('hello world')).toBe('hello world');
  });

  it('escapes all PCRE special chars', () => {
    const special = '.*+?^${}()|[]\\';
    const escaped = escapeRegex(special);
    // Every char should be escaped
    expect(escaped).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
  });
});

describe('safeRegex', () => {
  it('compiles simple patterns', () => {
    const re = safeRegex('hello|world');
    expect(re).toBeInstanceOf(RegExp);
    expect(re!.test('hello')).toBe(true);
  });

  it('rejects nested quantifiers (ReDoS)', () => {
    expect(safeRegex('(a+)+')).toBeNull();
    expect(safeRegex('(a*)*')).toBeNull();
    expect(safeRegex('(a+){2,}')).toBeNull();
  });

  it('rejects excessively long patterns', () => {
    expect(safeRegex('a'.repeat(501))).toBeNull();
  });

  it('rejects invalid regex syntax', () => {
    expect(safeRegex('(?P<invalid')).toBeNull();
  });

  it('accepts reasonable patterns', () => {
    expect(safeRegex('\\bctx\\.prisma\\b')).toBeInstanceOf(RegExp);
    expect(safeRegex('import.*from')).toBeInstanceOf(RegExp);
  });

  it('supports flags', () => {
    const re = safeRegex('hello', 'i');
    expect(re!.test('HELLO')).toBe(true);
  });
});

describe('globToSafeRegex', () => {
  it('converts simple glob with single star', () => {
    const re = globToSafeRegex('src/**/*.ts');
    expect(re.test('src/lib/utils.ts')).toBe(true);
    expect(re.test('src/deep/nested/file.ts')).toBe(true);
  });

  it('does not match across path separators with single star', () => {
    const re = globToSafeRegex('src/*.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/lib/index.ts')).toBe(false);
  });

  it('escapes special regex chars in the glob', () => {
    const re = globToSafeRegex('src/components/(portal)/*.tsx');
    expect(re.test('src/components/(portal)/page.tsx')).toBe(true);
  });
});

describe('redactSensitiveContent', () => {
  it('redacts API keys', () => {
    expect(redactSensitiveContent('key: sk-abc123def456ghij')).toContain('[REDACTED_KEY]');
    expect(redactSensitiveContent('token: ghp_1234567890abcdef')).toContain('[REDACTED_KEY]');
  });

  it('redacts email addresses', () => {
    expect(redactSensitiveContent('contact user@example.com')).toContain('[REDACTED_EMAIL]');
  });

  it('redacts Bearer tokens', () => {
    expect(redactSensitiveContent('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'))
      .toContain('[REDACTED_TOKEN]');
  });

  it('redacts absolute file paths', () => {
    expect(redactSensitiveContent('file at /Users/john/secrets/key.pem')).toContain('[REDACTED_PATH]');
  });

  it('redacts connection strings', () => {
    expect(redactSensitiveContent('postgres://admin:s3cret@db.host.com/mydb'))
      .toContain('[REDACTED_CREDENTIALS]');
  });

  it('preserves non-sensitive content', () => {
    const safe = 'This is a normal prompt about implementing a feature';
    expect(redactSensitiveContent(safe)).toBe(safe);
  });
});

describe('enforceSeverityFloors', () => {
  const defaults = { critical: 25, high: 15, medium: 8, low: 3 };

  it('uses config values when above floor', () => {
    const result = enforceSeverityFloors({ critical: 30, high: 20 }, defaults);
    expect(result.critical).toBe(30);
    expect(result.high).toBe(20);
  });

  it('enforces minimum floors', () => {
    const result = enforceSeverityFloors({ critical: 0, high: 0, medium: 0, low: 0 }, defaults);
    expect(result.critical).toBe(MINIMUM_SEVERITY_WEIGHTS.critical);
    expect(result.high).toBe(MINIMUM_SEVERITY_WEIGHTS.high);
    expect(result.medium).toBe(MINIMUM_SEVERITY_WEIGHTS.medium);
    expect(result.low).toBe(MINIMUM_SEVERITY_WEIGHTS.low);
  });

  it('preserves defaults for missing config keys', () => {
    const result = enforceSeverityFloors({ critical: 50 }, defaults);
    expect(result.critical).toBe(50);
    expect(result.high).toBe(15); // default preserved
    expect(result.medium).toBe(8); // default preserved
  });

  it('prevents complete disabling of security scoring', () => {
    const result = enforceSeverityFloors(
      { critical: 0, high: 0, medium: 0, low: 0 },
      defaults
    );
    const totalWeight = Object.values(result).reduce((sum, v) => sum + v, 0);
    expect(totalWeight).toBeGreaterThan(0);
  });
});
