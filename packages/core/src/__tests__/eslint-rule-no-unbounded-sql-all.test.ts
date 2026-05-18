// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-DG-001 (plan-stage-d-medium-sweep) drift-guard.
 *
 * Closes the structural class of bugs where `db.prepare(SELECT ...).all()`
 * has no LIMIT clause. Stage C P-H034 audited and fixed 16+ such queries
 * one-by-one; this rule prevents the class from recurring at the AST level.
 *
 * The rule is loaded directly from <repo>/eslint-rules/no-unbounded-sql-all.js
 * and exercised via hand-built ESTree AST fragments. This isolates the rule
 * from ESLint runtime + parser dependencies that aren't installed in
 * packages/core. The 5+ cases in the plan are covered as:
 *   1. SELECT + LIMIT → no error.
 *   2. SELECT without LIMIT → error.
 *   3. COUNT(...) SELECT → no error.
 *   4. Template literal SQL with LIMIT → no error.
 *   5. Chained .pluck().all() with unbounded SELECT → error (walk skips
 *      intermediate calls).
 */

import { describe, it, expect } from 'vitest'

// CJS rule loaded via dynamic import to satisfy ESM + JS interop.
import rule from '../../../../eslint-rules/no-unbounded-sql-all.js'

interface CapturedReport {
  messageId: string
}

function runOnExpression(sql: string, chainBeforeAll: string[] = []): CapturedReport[] {
  // Hand-build the ESTree shape: <chain>.all(),
  // where <chain> = db.prepare(SQL)[.x1()[.x2()]...]
  const prepareCall = {
    type: 'CallExpression',
    callee: {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'db' },
      property: { type: 'Identifier', name: 'prepare' },
    },
    arguments: [
      sql.startsWith('TEMPLATE:')
        ? {
            type: 'TemplateLiteral',
            quasis: [
              {
                type: 'TemplateElement',
                value: {
                  raw: sql.slice('TEMPLATE:'.length),
                  cooked: sql.slice('TEMPLATE:'.length),
                },
                tail: true,
              },
            ],
            expressions: [],
          }
        : sql === '__variable__'
          ? { type: 'Identifier', name: 'sql' }
          : { type: 'Literal', value: sql, raw: JSON.stringify(sql) },
    ],
  }
  let cursor: unknown = prepareCall
  for (const method of chainBeforeAll) {
    cursor = {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: cursor,
        property: { type: 'Identifier', name: method },
      },
      arguments: [],
    }
  }
  const allCall = {
    type: 'CallExpression',
    callee: {
      type: 'MemberExpression',
      object: cursor,
      property: { type: 'Identifier', name: 'all' },
    },
    arguments: [],
  }

  const reports: CapturedReport[] = []
  const ctx = {
    report: (arg: { messageId: string }) => reports.push({ messageId: arg.messageId }),
  }
  const visitor = (rule as { create: (c: unknown) => { CallExpression: (n: unknown) => void } }).create(ctx)
  visitor.CallExpression(allCall)
  return reports
}

describe('P-DG-001 ESLint massu/no-unbounded-sql-all rule', () => {
  it('SELECT with LIMIT → no violation', () => {
    const reports = runOnExpression(
      'SELECT * FROM observations ORDER BY id DESC LIMIT 1000',
    )
    expect(reports).toHaveLength(0)
  })

  it('SELECT without LIMIT → violation reported', () => {
    const reports = runOnExpression(
      'SELECT * FROM observations WHERE session_id = ?',
    )
    expect(reports).toHaveLength(1)
    expect(reports[0].messageId).toBe('missingLimit')
  })

  it('SELECT COUNT(*) → no violation (count is bounded by aggregation)', () => {
    const reports = runOnExpression('SELECT COUNT(*) as count FROM big_table')
    expect(reports).toHaveLength(0)
  })

  it('template literal SQL with LIMIT in static portion → no violation', () => {
    const reports = runOnExpression(
      'TEMPLATE:SELECT * FROM big_table ORDER BY id DESC LIMIT 100',
    )
    expect(reports).toHaveLength(0)
  })

  it('chained .pluck().all() with unbounded SELECT → violation', () => {
    const reports = runOnExpression(
      'SELECT id FROM jobs WHERE status = ?',
      ['pluck'],
    )
    expect(reports).toHaveLength(1)
    expect(reports[0].messageId).toBe('missingLimit')
  })

  it('non-literal SQL (variable) → not reported (out of static scope)', () => {
    const reports = runOnExpression('__variable__')
    expect(reports).toHaveLength(0)
  })

  it('SELECT with parameterized LIMIT placeholder → no violation', () => {
    const reports = runOnExpression('SELECT * FROM t LIMIT ?')
    expect(reports).toHaveLength(0)
  })
})
