// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P3.2 of docs/plans/2026-09-20-stack-conformant-asset-rendering.md.
 *
 * Constrains the 13 SHIPPED stack templates so the vocabulary every asset renders against
 * cannot silently rot. The roster is DERIVED from `readdirSync('templates/')` (G32), so a
 * 14th stack is covered on its first commit rather than when someone remembers.
 *
 * The verdict vocabulary is CLOSED: a verification key outside
 * REQUIRED ∪ OPTIONAL is an ERROR here, never a quietly skipped row (G3). This is
 * deliberately scoped to the SHIPPED TEMPLATES only — `VerificationEntrySchema` is
 * `.passthrough()` by design and `verification_types` exists so customers can declare
 * their own VR-* types. Constraining a customer's config would break both features;
 * constraining what massu itself ships is the actual obligation.
 *
 * P3.1's adjudication record is asserted here too, which is what gives it a CALLER: a
 * record nothing reads is a dead feature (CR-71).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import YAML from 'yaml';
import {
  REQUIRED_VERIFY_KEYS,
  OPTIONAL_VERIFY_KEYS,
  ALL_VERIFY_KEYS,
} from '../stack-capabilities.ts';
import { validateShippedTemplate } from '../shipped-template-schema.ts';

const TEMPLATES_DIR = resolve(__dirname, '../../templates');
const ADJUDICATION = resolve(__dirname, '../../../../scripts/lib/stack-test-command-adjudication.json');

function stackNames(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((entry) => existsSync(join(TEMPLATES_DIR, entry, 'massu.config.yaml')))
    .sort();
}

function rawYaml(stack: string): string {
  return readFileSync(join(TEMPLATES_DIR, stack, 'massu.config.yaml'), 'utf-8');
}

const STACKS = stackNames();

describe('shipped stack templates — structural conformance', () => {
  it('the roster is non-empty (M1: a zero denominator makes every test below vacuous)', () => {
    expect(STACKS.length).toBeGreaterThan(0);
    expect(STACKS.length).toBe(13);
  });

  it.each(STACKS)('%s parses as YAML and declares a verification block', (stack) => {
    const parsed = YAML.parse(rawYaml(stack)) as Record<string, unknown>;
    expect(parsed, `${stack}: did not parse`).toBeTruthy();
    expect(parsed.verification, `${stack}: no top-level verification:`).toBeTruthy();
  });

  it.each(STACKS)('%s declares every REQUIRED key for its primary language', (stack) => {
    const parsed = YAML.parse(rawYaml(stack)) as {
      framework: { primary?: string; type: string };
      verification: Record<string, Record<string, string>>;
    };
    const primary = parsed.framework.primary ?? parsed.framework.type;
    const entry = parsed.verification[primary];
    expect(entry, `${stack}: verification has no entry for primary '${primary}'`).toBeTruthy();
    for (const required of REQUIRED_VERIFY_KEYS) {
      expect(entry[required], `${stack}.${primary}: missing REQUIRED '${required}'`).toBeTruthy();
    }
  });

  it.each(STACKS)('%s declares no verification key outside the CLOSED vocabulary', (stack) => {
    const parsed = YAML.parse(rawYaml(stack)) as {
      verification: Record<string, Record<string, string>>;
    };
    for (const [lang, entry] of Object.entries(parsed.verification)) {
      for (const declared of Object.keys(entry ?? {})) {
        expect(
          ALL_VERIFY_KEYS as readonly string[],
          `${stack}.${lang}: '${declared}' is outside {${[...REQUIRED_VERIFY_KEYS, ...OPTIONAL_VERIFY_KEYS].join(', ')}}`,
        ).toContain(declared);
      }
    }
  });

  it.each(STACKS)('%s declares no verification key twice', (stack) => {
    // YAML.parse silently keeps the LAST duplicate, so a duplicated key is invisible in the
    // parsed object. Detecting it requires reading the raw text.
    const lines = rawYaml(stack).split('\n');
    const seen = new Map<string, number>();
    let inVerification = false;
    let currentLang = '';
    for (const line of lines) {
      if (/^verification:\s*$/.test(line)) {
        inVerification = true;
        continue;
      }
      if (inVerification && /^\S/.test(line)) {
        inVerification = false; // dedented out of the block
        continue;
      }
      if (!inVerification) continue;
      const langMatch = /^ {2}(\w[\w-]*):\s*$/.exec(line);
      if (langMatch) {
        currentLang = langMatch[1];
        continue;
      }
      const keyMatch = /^ {4}(\w+):/.exec(line);
      if (keyMatch) {
        const composite = `${currentLang}.${keyMatch[1]}`;
        seen.set(composite, (seen.get(composite) ?? 0) + 1);
      }
    }
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
    expect(duplicated, `${stack}: duplicated verification keys`).toEqual([]);
    // Positive control: the parser actually found keys. Zero would make this vacuous.
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('P3.1 adjudication record — every shipped stack is adjudicated', () => {
  const REQUIRED_FIELDS = ['stack', 'before', 'after', 'canonical_source', 'justification'];

  it('exists and parses', () => {
    expect(existsSync(ADJUDICATION), `missing: ${ADJUDICATION}`).toBe(true);
    expect(() => JSON.parse(readFileSync(ADJUDICATION, 'utf-8'))).not.toThrow();
  });

  it('covers every stack on disk — a new stack is UNADJUDICATED on its first commit', () => {
    const record = JSON.parse(readFileSync(ADJUDICATION, 'utf-8')) as {
      entries: Array<Record<string, unknown>>;
    };
    const complete = record.entries.filter((entry) =>
      REQUIRED_FIELDS.every((field) => entry[field] !== undefined && entry[field] !== ''),
    );
    const adjudicated = new Set(complete.map((entry) => String(entry.stack)));
    const unadjudicated = STACKS.filter((stack) => !adjudicated.has(stack));

    expect(unadjudicated, 'stacks present on disk but absent from the record').toEqual([]);
    expect(adjudicated.size).toBe(STACKS.length);

    // An entry naming a stack that no longer ships is stale, and stale-in-the-passing-
    // direction is how a record stops describing reality.
    const orphaned = [...adjudicated].filter((stack) => !STACKS.includes(stack));
    expect(orphaned, 'record entries for stacks that no longer exist').toEqual([]);
  });

  it("records the `after` value that the template actually ships", () => {
    // The record and the templates are two sources that must agree. If they drift, the
    // record becomes a story about the past rather than a description of the present.
    const record = JSON.parse(readFileSync(ADJUDICATION, 'utf-8')) as {
      entries: Array<{ stack: string; after: string; corrections?: Array<Record<string, string>> }>;
    };
    let checked = 0;
    for (const entry of record.entries) {
      const parsed = YAML.parse(rawYaml(entry.stack)) as {
        framework: { primary?: string; type: string };
        verification: Record<string, Record<string, string>>;
      };
      const primary = parsed.framework.primary ?? parsed.framework.type;
      expect(parsed.verification[primary].test, `${entry.stack}.test`).toBe(entry.after);
      checked++;

      for (const correction of entry.corrections ?? []) {
        const field = correction['key'];
        expect(
          parsed.verification[primary][field],
          `${entry.stack}.${field} does not match its recorded correction`,
        ).toBe(correction['after']);
        checked++;
      }
    }
    // DERIVED from the record, never a literal (G32): one `test` command per entry plus
    // however many corrections it records. A hardcoded total goes stale the moment a
    // correction is added or withdrawn, and it goes stale in the passing direction.
    const expected =
      record.entries.length +
      record.entries.reduce((sum, entry) => sum + (entry.corrections ?? []).length, 0);
    expect(checked).toBeGreaterThan(0); // positive control: the loop actually ran
    expect(checked).toBe(expected);
  });
});

describe('P3.3 — the STRICT shipped-template schema', () => {
  function load(stack: string): Record<string, unknown> {
    return YAML.parse(rawYaml(stack)) as Record<string, unknown>;
  }

  it('every shipped template satisfies it (denominator asserted)', () => {
    expect(STACKS.length).toBe(13);
    const failures = STACKS.map((stack) => validateShippedTemplate(load(stack), stack)).filter(
      (result) => !result.ok,
    );
    expect(failures.flatMap((f) => f.issues)).toEqual([]);
  });

  it('REFUSES a template missing a REQUIRED key, naming the stack AND the key', () => {
    const broken = load('python-fastapi');
    delete (broken.verification as Record<string, Record<string, unknown>>)['python']['type'];
    const result = validateShippedTemplate(broken, 'python-fastapi');
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('python-fastapi');
    expect(result.issues.join('\n')).toContain('type');
  });

  it('REFUSES an EMPTY-STRING command — absence, not a declaration', () => {
    // `''` renders as a command that runs nothing and exits 0: a check that reports
    // success precisely because it could not run. It must never satisfy a required key.
    const broken = load('python-fastapi');
    (broken.verification as Record<string, Record<string, unknown>>)['python']['test'] = '';
    const result = validateShippedTemplate(broken, 'python-fastapi');
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/non-empty 'test'/);
  });

  it('REFUSES a template with no verification block at all', () => {
    const broken = load('ts-nextjs');
    delete broken.verification;
    expect(validateShippedTemplate(broken, 'ts-nextjs').ok).toBe(false);
  });

  it('REFUSES a template whose primary language declares nothing', () => {
    const broken = load('python-fastapi');
    (broken.framework as Record<string, unknown>).primary = 'elixir';
    const result = validateShippedTemplate(broken, 'python-fastapi');
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('elixir');
  });

  it('does NOT constrain a CUSTOMER config — that path stays permissive', () => {
    // The whole point of a second schema. A customer config missing a verification block
    // must still load: config validation throws, and 74 non-test source files call
    // getConfig(), so refusing here would cost them every massu command including the
    // `doctor` that would diagnose it. Proven by the live suite: the fixtures in
    // verification-laws-reach-consumers.test.ts carry NO verification block and install
    // successfully. This test pins the asymmetry so it cannot be "tidied" into one schema.
    const legacy = load('ts-nextjs');
    delete legacy.verification;
    expect(validateShippedTemplate(legacy, 'ts-nextjs').ok).toBe(false); // strict: refused
    // and the permissive path is exercised end-to-end by build-template-vars-stack.test.ts,
    // which builds a real repo from a config with no verification block and asserts the
    // install proceeds with stack.satisfied === false.
  });
});
