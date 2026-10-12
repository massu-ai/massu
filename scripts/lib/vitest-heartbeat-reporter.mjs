// D-2: THE RUNNER DECLARES ITS PROGRESS. A heartbeat sink over the shared observation core.
//
// The runner already knows when every test, suite, hook and module starts and finishes. So it
// DECLARES that, and the watcher ASKS (Rule 25). Nothing here samples, polls or infers — the
// signal is an EVENT, never a rate, which is what makes it independent of the host's speed.
//
// ⛔⛔ ONE FILE WITH A ROW PER IN-FLIGHT MODULE — *NOT* ONE FILE PER WORKER, AND THAT IS A
// MEASURED CORRECTION RATHER THAN A PREFERENCE.
//
// The first version of this file wrote `worker-${process.pid}.json`, copying the shape of the
// pytest prior art. MEASURED against packages/core, where 27 modules run in flight under
// `pool: 'forks'`: it produced exactly ONE file. A vitest reporter is instantiated in the MAIN
// process and every worker's events interleave into that one stream, so `process.pid` is
// constant and per-worker files are impossible from a reporter. The prior art's per-worker
// files come from pytest-xdist workers each loading their own conftest — the writer lives IN
// the worker there. Same doctrine, different architecture: this is the "vitest-side
// translation" the plan calls BUILT rather than BORROWED, and copying the shape instead of
// translating it would have shipped a detector that can never name anything.
//
// WHAT CAN BE ATTRIBUTED RELIABLY, AND ONLY THAT. `onTestModuleStart`/`onTestModuleEnd` carry
// a `moduleId`, so the set of OPEN MODULES is exactly derivable. That set plus the global last
// event is what lets a watcher say "nothing has been emitted for N seconds, and these modules
// are still open" — which names the candidates precisely, from observed data, with nothing
// inferred.
//
// ⚠️ NOT ATTEMPTED, BECAUSE IT IS NOT YET MEASURED (R-011): attributing a TEST event to its
// module. `onTestCaseReady` reports `fullName=<suite> > <test>`, which does not identify the
// module, and whether vitest 4's TestCase exposes a module reference is UNVERIFIED. Narrowing
// from "these modules are open" to "this exact test is stuck" is a D-4 refinement that must
// start by measuring that, not by assuming a field exists.
//
// ⛔ "NO HEARTBEAT AT ALL" IS A DIFFERENT STATE FROM "A HEARTBEAT THAT WENT QUIET". The first
// means the run never reached the point of emitting anything — a collection or worker-startup
// deadlock, the shape that produces a 0-byte log and can run for hours. The second means it
// started and then stopped. Collapsing them would make a misconfigured watcher look exactly
// like a hung suite, so the file's EXISTENCE and its FRESHNESS stay two separate observable
// facts for the watcher to distinguish.
//
// ⛔ WRITES ARE ATOMIC BY RENAME. The watcher polls this file while it is being rewritten. A
// partial read is a JSON parse error, which a watcher could plausibly treat as "no data" —
// i.e. as silence, which is the FIRING value. Write a temp in the same directory and rename
// over it: rename is atomic within a filesystem, so a reader sees either the previous complete
// beat or the next one, never half of either.

import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { makeProgressReporter } from './vitest-progress-core.mjs';
import { ENV_BASE, baseFromEnv, ensureRunDir } from './hang-heartbeat-location.mjs';

// M2 FAIL CLOSED, AND DELIBERATELY WITH NO DEFAULT. A heartbeat written where the watcher is
// not reading is worse than one that never runs: the suite looks instrumented and the watcher
// sees permanent silence. Requiring the variable makes reporter and watcher agree BY
// CONSTRUCTION — they resolve the same name, or neither starts.
const BASE = baseFromEnv();
if (!BASE) {
  throw new Error(
    `vitest-heartbeat-reporter: ${ENV_BASE} is unset — refusing to beat into a location no ` +
      'watcher is reading. Whatever arms this reporter must set it. (Note: the variable names ' +
      'the BASE directory; this reporter appends its own pid, so a watcher can enumerate runs.)',
  );
}

// base/<pid>/heartbeat.json — the pid level is what keeps concurrent runs in this repo from
// overwriting one another and lets a watcher say WHICH run it read.
const DIR = ensureRunDir(BASE, process.pid);
const BEAT = join(DIR, 'heartbeat.json');
const TMP = `${BEAT}.tmp`;

// moduleId -> { openedAt, lastEvent, lastSubject, lastT }. Insertion-ordered, so the
// oldest-opened module
//
// ⛔ THE ROW CARRIES THE SUBJECT, NOT ONLY THE EVENT NAME, AND THAT IS WHAT MAKES A HANG
// NAMEABLE. The record used to keep one global `(event, subject)` pair plus per-module rows
// holding only the event NAME. Measured 2026-09-24 on a real beforeAll hang: the global last
// event was `onTaskUpdate` with `subject: keys=0` — an event that carries no identity at all —
// while the module row said `last_event: onHookStart` and had thrown the hook's identity away.
// So the report could name the FILE and not the HOOK, and D-6's precondition for deleting
// `hookTimeout` was unmet. Two lossy shapes for one question (“what was last seen?”) is the
// defect; the fix is that both scopes carry the same shape.
//
// ⛔ AND THIS IS WHERE ATTRIBUTION HAS TO LIVE, NOT IN THE GLOBAL LINE. `onTaskUpdate` is the
// “from” side of all ten longest silences in D-1's measurement — the commonest last-event before
// a gap — and it identifies nothing. A design that attributes from the global last event is
// therefore attributing from the least informative event available.
//
// The subject is stored VERBATIM, the same value the global beat holds. Trimming it here for
// readability would make the writer's rendering the thing a reader reasons about, which has
// already misled this session once.
// appears first and a watcher gets a stable "most likely stuck" ordering for free.
const openModules = new Map();

// ⛔ THERE IS NO LONGER A PARSER HERE, AND ITS ABSENCE IS THE FIX.
// This read `subject.slice('moduleId='.length)` off a prefix match. That was correct only
// while a subject carried exactly ONE field; the moment `subjectOf` began collecting every
// identity field rather than preferring one, slice-to-end would have returned the whole
// remainder of the string — `/path/x.test.ts fullName=… name=…` — as the module key, and
// every open-module row would have been keyed on garbage that still looked like a path.
// Reading the STRUCTURED field cannot express that mistake.

export default makeProgressReporter((beat) => {
  const mid = beat.identity.moduleId || null;
  if (mid) {
    if (beat.event === 'onTestModuleStart' || beat.event === 'onTestModuleQueued') {
      if (!openModules.has(mid)) {
        openModules.set(mid, {
          openedAt: beat.t_ms,
          lastEvent: beat.event,
          lastSubject: beat.subject,
          lastT: beat.t_ms,
        });
      }
    }
    const row = openModules.get(mid);
    if (row) {
      row.lastEvent = beat.event;
      row.lastSubject = beat.subject;
      row.lastT = beat.t_ms;
    }
    if (beat.event === 'onTestModuleEnd') openModules.delete(mid);
  }

  const rec = {
    // The global last beat — what a silence bound is measured against.
    t_ms: beat.t_ms,
    wall: beat.wall,
    event: beat.event,
    subject: beat.subject,
    pid: beat.pid,
    // The in-flight set, so a report can NAME candidates instead of only saying "quiet".
    open_modules: [...openModules.entries()].map(([id, r]) => ({
      module: id,
      opened_at_ms: r.openedAt,
      last_event: r.lastEvent,
      last_subject: r.lastSubject,
      last_t_ms: r.lastT,
    })),
  };

  try {
    writeFileSync(TMP, JSON.stringify(rec) + '\n');
    renameSync(TMP, BEAT);
  } catch (e) {
    // Never let the instrument break the run it observes. The watcher's own staleness check is
    // what notices a heartbeat that stopped; this path must not turn an observation failure
    // into a test failure.
    process.stderr.write(`vitest-heartbeat-reporter: write failed: ${e.message}\n`);
  }
});
