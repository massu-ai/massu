// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * P-DG-001 (plan-stage-d-medium-sweep): ESLint rule `massu/no-unbounded-sql-all`.
 *
 * Forbids `db.prepare('SELECT ...').all()` (and chained variants) where the
 * SQL is a literal SELECT without a top-level LIMIT clause. Closes the
 * structural class of bugs where an unbounded query loads every row of a
 * large table into memory — Stage C P-H034 audited 16+ such queries; this
 * rule prevents the class from recurring.
 *
 * Allowlist (per-occurrence): place an inline ESLint disable comment with
 * a justification, e.g.
 *
 *   // eslint-disable-next-line massu/no-unbounded-sql-all -- bounded by upstream filter
 *   const rows = db.prepare(`SELECT * FROM small_lookup_table`).all();
 *
 * COUNT-only SELECTs, SELECTs against table-name-prefixed `sqlite_*` system
 * tables, and SELECTs explicitly carrying `LIMIT <N>` are all permitted.
 */

'use strict';

/**
 * Detect whether the SQL string contains a top-level LIMIT clause.
 * "Top-level" excludes subqueries — but for the rule's purpose, ANY
 * LIMIT in the string is sufficient because adding any LIMIT was the
 * fix prescribed by P-H034. The over-permissive case is a tolerated
 * false negative; the over-restrictive case (false positive) is more
 * costly because it forces eslint-disable churn.
 */
// Architecture-review M-8 hardening: accept all four common bound-parameter
// shapes — better-sqlite3 (?, $name, :name) and pg-style ($1).
function hasLimit(sql) {
  return /\blimit\s+(\d+|\?|\(?:?\?\)?|:[a-zA-Z_]|\$\d+|\$[a-zA-Z_])/i.test(sql);
}

function looksLikeSelect(sql) {
  return /^\s*select\b/i.test(sql) && !/\bcount\s*\(/i.test(sql);
}

function getSqlText(arg) {
  if (!arg) return null;
  if (arg.type === 'Literal' && typeof arg.value === 'string') {
    return arg.value;
  }
  if (arg.type === 'TemplateLiteral' && arg.quasis && arg.quasis.length) {
    // Concatenate the static quasi parts; treat ${...} interpolations as
    // unknown but non-LIMIT (they don't satisfy hasLimit unless the
    // template explicitly contains `LIMIT ...` outside an expression).
    return arg.quasis.map((q) => q.value.cooked || q.value.raw).join('');
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow `.prepare(SQL).all()` where SQL is a SELECT literal without a LIMIT clause.',
      category: 'Possible Errors',
      recommended: true,
    },
    schema: [],
    messages: {
      missingLimit:
        'SQL SELECT statement passed to `.prepare(...).all()` must include a LIMIT clause. ' +
        'Unbounded `.all()` queries are a P-H034 / P-DG-001 anti-pattern. ' +
        'Add `LIMIT <N>` or `// eslint-disable-next-line massu/no-unbounded-sql-all -- <reason>` if intentional.',
    },
  },

  create(context) {
    // Architecture-review M-7: AST walk covers the chained `.prepare().X().Y().all()`
    // pattern. Deliberate scope limits documented:
    //   - Variable-bound preparations (`const p = db.prepare(sql); p.all()`)
    //     are out of scope (no static SQL string available at .all() site).
    //     Pattern-scanner Check 25 catches this via grep.
    //   - Computed MemberExpression chains (`db.prepare(sql)[...].all()`) are
    //     not walked because there's no .property identifier name to follow.
    //   - Non-literal SQL (passed via Identifier) is treated as safe at this
    //     layer; runtime bounds are enforced by the calling code's invariants.
    return {
      CallExpression(node) {
        // Match `something.all(...)` (no args required).
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'all'
        ) {
          return;
        }

        // Walk back through .all() <- .prepare(SQL) — there may be other
        // chained methods between them (e.g., `.prepare(sql).pluck().all()`).
        let cursor = node.callee.object;
        let prepareCall = null;
        while (
          cursor &&
          cursor.type === 'CallExpression' &&
          cursor.callee.type === 'MemberExpression' &&
          cursor.callee.property &&
          cursor.callee.property.type === 'Identifier'
        ) {
          if (cursor.callee.property.name === 'prepare') {
            prepareCall = cursor;
            break;
          }
          cursor = cursor.callee.object;
        }
        if (!prepareCall || !prepareCall.arguments.length) return;

        const sql = getSqlText(prepareCall.arguments[0]);
        if (sql === null) return; // dynamic SQL — out of scope

        if (!looksLikeSelect(sql)) return; // not a SELECT or is COUNT
        if (hasLimit(sql)) return; // bounded

        context.report({
          node,
          messageId: 'missingLimit',
        });
      },
    };
  },
};
