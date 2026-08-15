// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * F2 / A-001 — GIVE THE `MASSU_HOOK_FAILURE_LOG` SEAM ITS CALLER, AT ONE SITE.
 *
 * `recordHookFailure()` appends to `.massu/hook-failures.jsonl`, resolved by walking up
 * from `process.cwd()` for a repo marker unless `MASSU_HOOK_FAILURE_LOG` overrides it
 * (`hooks/lib/hook-failure-signal.ts`). That log is INCIDENT EVIDENCE — the only surviving
 * record of 9,796 permanently lost hook invocations — so a test appending to it corrupts
 * the corpus and, historically, moved the reality gate's own numbers. Seventeen such rows
 * are already in it, written by an earlier version of the entry-guard harness.
 *
 * WHY THIS IS ONE FILE AND NOT AN EXPORT IN EVERY HOOK-EXECUTING TEST
 * -------------------------------------------------------------------
 * The obvious scope is "every test that runs a hook", enumerated by
 * `grep -rln 'dist/hooks/' scripts/tests/ packages/core/src/__tests__/`. Measured, that
 * command returns 9 files of which only THREE execute a hook; four are static tests that
 * merely read filenames, one is not a test, and one imports the bundles without ever
 * calling `main()`. Worse, it is not the property: `memory-db.ts` calls
 * `recordHookFailure()` from its pre-DDL backup path, outside any hook, and 81 test files
 * reach `getMemoryDb()`. The predicate is `dist/hooks/`; the property is "can reach
 * `recordHookFailure`" (G28 — a gate's scope predicate must BE the property).
 *
 * Declaring the seam once, here, covers all three spawners (each composes its child env
 * from `process.env`, so each inherits it), every in-process caller, and every test written
 * from now on — with no roster to rot (Rule 25). `hook-log-untouched.ts` then asserts the
 * PROPERTY itself, end to end, rather than trusting this declaration.
 *
 * Set UNCONDITIONALLY. A test that genuinely needs its own path assigns `process.env`
 * in its own `beforeEach`, which runs after this file; honouring a pre-existing value
 * instead would let a stale or hostile environment point the log back into the repo.
 */

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// One directory per worker process. `mkdtempSync` appends six random characters to the
// prefix itself, so there is no template to get wrong — unlike shell `mktemp -t`, where
// omitting the X's works on macOS and is fatal on Linux CI.
const dir = mkdtempSync(join(tmpdir(), 'massu-hook-failures-'));

process.env.MASSU_HOOK_FAILURE_LOG = join(dir, 'hook-failures.jsonl');
