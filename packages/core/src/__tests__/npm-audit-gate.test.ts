// npm audit gate (scripts/npm-audit-gate.mjs) — one MUST-FIRE case per detection path, each
// paired with a MUST-STAY-SILENT control, so a red here means "the path works" and a green
// control means "the gate is not a brick". Origin: 2026-10-11, GHSA-vfj7-8cjw-p6xm (braces) has
// no patched release, so the plain `npm audit --audit-level=info` CI step could never pass again.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  evaluateNpmAudit,
  validateExemptions,
  loadExemptions,
  CouldNotLook,
  // @ts-expect-error — plain .mjs module, no type decls (pure JS gate logic).
} from '../../../../scripts/npm-audit-gate.mjs';

const REPO = resolve(__dirname, '../../../..');
const GATE = join(REPO, 'scripts', 'npm-audit-gate.mjs');
const TODAY = '2026-10-11';
const GHSA = 'GHSA-vfj7-8cjw-p6xm';

type Adv = { name: string; url: string; severity: string; title?: string; source?: number };

function payload(advs: Adv[]) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const a of advs) {
    vulnerabilities[a.name] = {
      name: a.name,
      severity: a.severity,
      via: [{ source: a.source ?? 1, name: a.name, title: a.title ?? 't', url: a.url, severity: a.severity }],
    };
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: advs.length } },
  };
}

const bracesAdv: Adv = { name: 'braces', url: `https://github.com/advisories/${GHSA}`, severity: 'high' };

function exemption(over: Record<string, unknown> = {}) {
  return {
    advisory: GHSA,
    package: 'braces',
    surface: '.',
    severity: 'high',
    reason: 'no patched release exists',
    reachability: 'glob patterns from the repo owner config only',
    added: '2026-10-11',
    expires: '2027-01-11',
    ...over,
  };
}

const run = (audits: Record<string, unknown>, exemptions: unknown[], today = TODAY) =>
  evaluateNpmAudit({ audits, exemptions, today }) as { code: number; lines: string[] };

describe('npm-audit-gate: blocking advisories', () => {
  it('MUST FIRE: an un-exempted advisory blocks (exit 1) and is named', () => {
    const r = run({ '.': payload([bracesAdv]) }, []);
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toMatch(new RegExp(`HIGH\\s+${GHSA}\\s+braces`));
  });

  it('MUST FIRE: floor is info — a LOW advisory blocks too (Rule 16, all-severity closure)', () => {
    const r = run({ '.': payload([{ name: 'x', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'low' }]) }, []);
    expect(r.code).toBe(1);
  });

  it('MUST FIRE: an exemption is scoped to ONE surface — it does not cover the other lockfile', () => {
    const r = run({ '.': payload([bracesAdv]), website: payload([bracesAdv]) }, [exemption()]);
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toMatch(/surface=website advisories_examined=1 exempted=0 blocking=1/);
  });

  it('SILENT CONTROL: the same advisory, validly exempted, passes (exit 0) and prints its denominator', () => {
    const r = run({ '.': payload([bracesAdv]) }, [exemption()]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/DENOMINATOR: surfaces=1 \[\.\] advisories_examined=1 .* used=1 blocking=0 expired=0 stale=0/);
  });

  it('SILENT CONTROL: a clean tree passes', () => {
    expect(run({ '.': payload([]) }, []).code).toBe(0);
  });
});

describe('npm-audit-gate: expiry', () => {
  it('MUST FIRE: an expired exemption stops suppressing (exit 1, EXPIRED named)', () => {
    const r = run({ '.': payload([bracesAdv]) }, [exemption({ expires: '2026-10-10', added: '2026-10-01' })]);
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toMatch(/EXPIRED EXEMPTIONS/);
  });

  it('SILENT CONTROL: an exemption expiring TODAY still holds', () => {
    expect(run({ '.': payload([bracesAdv]) }, [exemption({ expires: TODAY, added: '2026-10-01' })]).code).toBe(0);
  });
});

describe('npm-audit-gate: stale exemptions', () => {
  it('MUST FIRE: an exemption matching no live advisory on an AUDITED surface fails (exit 1, STALE named)', () => {
    const r = run({ '.': payload([]) }, [exemption()]);
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toMatch(/STALE EXEMPTIONS/);
  });

  it('SILENT CONTROL: an exemption for a surface NOT audited this run is out of scope, not stale (public mirror)', () => {
    const r = run({ '.': payload([]) }, [exemption({ surface: 'website' })]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/exemptions_declared=1 in_scope=0/);
  });
});

describe('npm-audit-gate: closed exemption vocabulary', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['missing reachability', { reachability: undefined }, /missing required key\(s\) reachability/],
    ['empty reason', { reason: '  ' }, /`reason` is empty/],
    ['empty reachability', { reachability: '' }, /`reachability` is empty/],
    ['unknown (typo) key', { reachabilty: 'x' }, /unknown key\(s\) reachabilty/],
    ['non-GHSA advisory id', { advisory: 'braces-bug' }, /is not a GHSA id/],
    ['unknown severity', { severity: 'severe' }, /severity "severe"/],
    ['impossible date', { expires: '2027-02-31' }, /`expires` must be a real YYYY-MM-DD date/],
    ['expiry not after added', { expires: '2026-10-11' }, /must be after `added`/],
  ];
  for (const [name, over, re] of cases) {
    it(`MUST FIRE: ${name} → EXEMPTION FILE INVALID (exit 1)`, () => {
      const row = exemption(over);
      for (const [k, v] of Object.entries(over)) if (v === undefined) delete (row as Record<string, unknown>)[k];
      const r = run({ '.': payload([bracesAdv]) }, [row]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/EXEMPTION FILE INVALID/);
      expect(r.lines.join('\n')).toMatch(re);
    });
  }

  it('MUST FIRE: a duplicate row is an error', () => {
    expect(validateExemptions([exemption(), exemption()]).join('\n')).toMatch(/duplicate exemption/);
  });

  it('SILENT CONTROL: a complete row validates with zero problems', () => {
    expect(validateExemptions([exemption()])).toEqual([]);
  });

  it('the COMMITTED exemptions file validates, and every row is GHSA-scoped with a reachability statement', () => {
    const rows = loadExemptions(join(REPO, 'scripts', 'npm-audit-exemptions.json'));
    expect(rows.length).toBeGreaterThan(0);
    expect(validateExemptions(rows)).toEqual([]);
    for (const r of rows) expect(r.reachability.length).toBeGreaterThan(40);
  });
});

describe('npm-audit-gate: fails CLOSED (could not look)', () => {
  const closed: Array<[string, Record<string, unknown>, RegExp]> = [
    ['npm error object', { '.': { error: { code: 'ENOAUDIT' } } }, /npm reported an error/],
    ['no auditReportVersion', { '.': { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } } }, /no auditReportVersion/],
    ['no metadata totals', { '.': { auditReportVersion: 2, vulnerabilities: {} } }, /metadata\.vulnerabilities is missing/],
    [
      'totals count findings the parser could not enumerate (schema drift)',
      { '.': { auditReportVersion: 2, vulnerabilities: { a: { via: ['b'] } }, metadata: { vulnerabilities: { total: 1 } } } },
      /enumeration produced ZERO advisories/,
    ],
    ['zero surfaces', {}, /no surface was audited/],
  ];
  for (const [name, audits, re] of closed) {
    it(`MUST FIRE: ${name} → CouldNotLook, never a pass`, () => {
      expect(() => run(audits, [])).toThrow(CouldNotLook);
      expect(() => run(audits, [])).toThrow(re);
    });
  }
});

describe('npm-audit-gate: CLI exit codes (the contract CI reads)', () => {
  function cli(args: string[]) {
    return spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });
  }
  function withFixtures(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'npm-audit-gate-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('MUST FIRE: un-exempted advisory → exit 1; SILENT CONTROL: exempted → exit 0', () => {
    withFixtures((dir) => {
      writeFileSync(join(dir, 'audit.json'), JSON.stringify(payload([bracesAdv])));
      writeFileSync(join(dir, 'none.json'), JSON.stringify({ exemptions: [] }));
      writeFileSync(join(dir, 'one.json'), JSON.stringify({ exemptions: [exemption()] }));
      const red = cli(['--audit-json', `.=${join(dir, 'audit.json')}`, '--exemptions', join(dir, 'none.json'), '--today', TODAY]);
      expect(red.status).toBe(1);
      expect(red.stdout).toMatch(/DENOMINATOR: surfaces=1/);
      const green = cli(['--audit-json', `.=${join(dir, 'audit.json')}`, '--exemptions', join(dir, 'one.json'), '--today', TODAY]);
      expect(green.status).toBe(0);
      expect(green.stdout).toMatch(/^PASS:/m);
    });
  });

  it('MUST FIRE: unreadable exemptions file and unparseable audit JSON → exit 2 (never 0)', () => {
    withFixtures((dir) => {
      writeFileSync(join(dir, 'audit.json'), JSON.stringify(payload([])));
      writeFileSync(join(dir, 'bad.json'), '{not json');
      const noOracle = cli(['--audit-json', `.=${join(dir, 'audit.json')}`, '--exemptions', join(dir, 'absent.json')]);
      expect(noOracle.status).toBe(2);
      expect(noOracle.stderr).toMatch(/COULD NOT LOOK/);
      writeFileSync(join(dir, 'none.json'), JSON.stringify({ exemptions: [] }));
      const badAudit = cli(['--audit-json', `.=${join(dir, 'bad.json')}`, '--exemptions', join(dir, 'none.json')]);
      expect(badAudit.status).toBe(2);
    });
  });
});
