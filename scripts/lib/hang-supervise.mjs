// D-4: SUPERVISE A RUN. Report before deciding anything, and keep three outcomes apart.
//
// The runner declares its progress (D-2), one module decides what silence means (D-3), and this
// module is the out-of-process watcher that ASKS. It COMPOSES `hang_watch.mjs` rather than
// re-deciding anything: a supervisor that re-implemented `classify` would drift into agreeing with
// its own bugs, and the silence bound would then live in two files (Rule 25).
//
// ── THE EXIT CONTRACT IS THREE-VALUED, AND COLLAPSING IT IS THE WHOLE DEFECT CLASS ──────────
//
//     142  the watcher decided HUNG and acted. A distinct code, because "the watcher
//          intervened" must never be readable as "the subject failed normally" — that
//          collapse is exactly what makes a DEAD detector look like a working one.
//     2    COULD NOT LOOK. The watcher failed to watch, so this run has NO liveness verdict.
//          It is returned as an infrastructure fault and NEVER as the subject's status, with
//          an explicit note in the log, because "it finished" carries no evidence that it
//          could not have hung.
//     else the SUBJECT's own exit status, passed through untouched.
//
// ── THE STARTUP GRACE, AND WHY IT IS NOT A SECOND SILENCE BOUND ──────────────────────────────
// Before the first heartbeat there IS no heartbeat, and `classify` correctly returns CANNOT_LOOK
// for a missing beat. CANNOT_LOOK is designed to be FATAL, so a supervisor that treated its first
// poll as fatal would kill every run before it started, and one that treated it as benign would be
// blind to a collection deadlock forever. The resolution is the rule's own distinction lifted one
// level: NEVER YET SEEN A BEAT is a startup state bounded by a measured grace; SAW ONE, NOW CANNOT
// READ IT is fatal immediately.
//
// The grace is MEASURED, not typed: `scripts/ops/measure-heartbeat-startup.sh`, 16 samples across
// all three run roots and both suite sizes, worst legitimate launch 703 ms, one order of magnitude
// -> 10 s (14.2x the worst observation, still 9x below the 90 s silence bound).
//
// ⛔ AND THE GRACE APPLIES ONLY WHILE THE SUBJECT IS ALIVE. If the subject dies during it (a config
// error, a bad flag, a missing dependency) it never beats, and waiting out the clock would report
// CANNOT_LOOK instead of the subject's own status and its actual error — turning every ordinary
// startup failure into an infrastructure-fault verdict aimed at the wrong layer. A dead subject
// with no beat is a FAILED RUN, not a hang.
//
// ── ATTRIBUTION IS A SAFETY PROPERTY, NOT TIDINESS ──────────────────────────────────────────
// The run directory is keyed on the pid of the process that LOADS THE REPORTER — vitest's main
// process. When the subject is `npm test`, npm is the subject and vitest is a DESCENDANT, so
// neither pid derives from the other and this module cannot compute the run dir. It DISCOVERS runs
// and ATTRIBUTES each to its own subject's process tree before acting on it. Several sessions work
// this repo concurrently, so an unattributed supervisor could report on — or under the terminate
// policy KILL — another session's healthy run.
//
// The descendant walk matches `br_tree_pids` in `scripts/lib/bounded-run.sh`: `pgrep -P` for DIRECT
// children with the loop supplying depth, a seen-set against cycles, and a depth cap. That shape is
// not arbitrary — fork-pool workers are GRANDCHILDREN, so a child-only check misses the very
// process that writes the heartbeat.

import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { VERDICT, DEFAULT_SILENCE_S, check } from './hang_watch.mjs';
import { ENV_BASE, baseFromEnv, baseFromRepoRoot, discoverRuns, isAlive, runDir }
  from './hang-heartbeat-location.mjs';

/** Exit code meaning "the watcher decided HUNG and acted". */
export const EXIT_HUNG = 142;
/** Exit code meaning "the watcher could not watch, so this run has no verdict". */
export const EXIT_CANNOT_LOOK = 2;

// ⛔ D-8 — THE ABSOLUTE TOTAL-RUNTIME CEILING. **THIS IS NOT THE DETECTOR.**
// The detector bounds SILENCE; this bounds TOTAL RUNTIME. They answer different questions, and
// conflating them is the whole reason this control needs its own name and its own exit code.
//
// ⛔ ITS OWN EXIT CODE, AND THAT IS LOAD-BEARING. If the ceiling returned 142 it would be
// indistinguishable from a detection to every consumer that reads only the status, so a ceiling
// kill would be reported as "a hang was detected" — the exact collapse the three-valued contract
// exists to prevent. 143 says "nothing was detected; I stopped this because it would not end".
//
// ⛔ WHY IT CANNOT PRE-EMPT THE DETECTOR — AND THE PRECISE SHAPE OF THAT GUARANTEE, because the
// first draft of this comment OVER-CLAIMED IT and designing the attack is what caught that.
// The check sits at the END of the poll body: the hang branch, the startup-grace branch and the
// progress branch all `return` before control reaches it. So WITHIN ANY SINGLE POLL TICK the
// detector always wins — if the rule has a verdict, the ceiling is never consulted.
//
// That ordering does NOT make the ceiling harmless at any value. ACROSS ticks, a ceiling SMALLER
// than the silence bound fires first for the ordinary reason that its deadline arrives first: at
// ceilingS=1 and boundS=3 the ceiling ends the run at t≈1s, before the rule could ever declare a
// hang. The guarantee is therefore the ordering PLUS the relationship 750 >> 90 — the margin is
// load-bearing, not a second line of defence.
//
// R8b in `scripts/ops/live-fire-hang-supervise.sh` pins exactly that: a genuinely hanging subject
// under a ceiling that PRESERVES the real relationship returns 142, not 143.
//
// ⛔ THE NUMBER IS DERIVED, NOT TYPED (CR-68). Re-derive it with:
//     bash scripts/ops/measure-full-suite-duration.sh --runs 3
// Measured 2026-09-24 on a CONTENDED host (load 9.20), packages/core, 3 of 3 runs usable:
//     54s · 66s · 75s   ->  MIN 54  MEDIAN 66  MAX 75
// 750 is 10x the MAX, not the median: the margin has to absorb the contention that makes the worst
// case worse, and several sessions work this repo at once so contention is the NORMAL state.
// ⚠️ HONEST LIMIT: those three samples trend monotonically upward (54 -> 66 -> 75), and three
// points cannot separate "the host got busier" from "runs heat each other up". So 75s is a FLOOR
// on the worst case, not the worst case — which is precisely why the margin is an order of
// magnitude rather than a percentage.
export const EXIT_ABSOLUTE_CEILING = 143;
export const DEFAULT_ABSOLUTE_MAX_S = Number(process.env.HANG_ABSOLUTE_MAX_S || 750);

/**
 * The startup grace, in seconds. MEASURED (see the header), overridable for tests only —
 * the same testability-not-tuning distinction the plan draws for `HANG_SILENCE_S`.
 */
export const DEFAULT_STARTUP_GRACE_S = Number(process.env.HANG_STARTUP_GRACE_S || 10);

/** How often to poll. Small relative to both the grace and the bound, so neither is quantised. */
export const DEFAULT_POLL_MS = Number(process.env.HANG_POLL_MS || 500);

const DEPTH_CAP = 12;

/**
 * Every descendant of `root`, inclusive. Same contract as `br_tree_pids`.
 *
 * Returns a Set of numbers. A `pgrep` that finds nothing exits non-zero, which is NOT an error
 * here — it means "no children" — so that case is distinguished from a pgrep that could not run.
 */
export function treePids(root, { exec = execFileSync } = {}) {
  const seen = new Set([Number(root)]);
  let frontier = [Number(root)];
  let depth = 0;
  while (frontier.length > 0 && depth < DEPTH_CAP) {
    const next = [];
    for (const p of frontier) {
      let out = '';
      try {
        out = exec('pgrep', ['-P', String(p)], { encoding: 'utf-8' });
      } catch (err) {
        // pgrep exits 1 when there are simply no matches. Anything else (ENOENT — pgrep absent)
        // must not be silently read as "no children", because that would shrink the attributed
        // set and make the supervisor blind to the run it is meant to watch.
        if (err && err.status === 1) continue;
        throw new Error(
          `hang-supervise: pgrep -P ${p} could not run (${err && err.message}) — an unusable ` +
            'process table means attribution is impossible, and a smaller tree would silently ' +
            'exclude the very run being supervised (M2).',
        );
      }
      for (const line of out.split('\n')) {
        const c = Number(line.trim());
        if (!Number.isInteger(c) || c <= 0 || seen.has(c)) continue;
        seen.add(c);
        next.push(c);
      }
    }
    frontier = next;
    depth += 1;
  }
  return seen;
}

/**
 * The runs under `base` that belong to `subjectPid`'s process tree.
 *
 * ⛔ `discoverRuns` returns null (not []) when the base is unreadable, and that distinction is
 * carried through: null means COULD NOT LOOK, while [] means "looked, found no runs".
 *
 * @returns {{ok: true, runs: Array}|{ok: false, reason: string}}
 */
export function attributedRuns(base, subjectPid, deps = {}) {
  const all = discoverRuns(base);
  if (all === null) {
    return {
      ok: false,
      reason:
        `the heartbeat base ${base} is unreadable — "there are no runs" and "I could not look" ` +
        'must not be the same value, and only the second one is an infrastructure fault',
    };
  }
  let tree;
  try {
    tree = treePids(subjectPid, deps);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: true, runs: all.filter((r) => tree.has(r.pid)) };
}

/**
 * The report text. PURE, so D-7 can assert on it without running a suite.
 *
 * Names the stuck candidates from observed data: the open modules, oldest-opened first (the
 * heartbeat's insertion order), each with the last event it emitted. Nothing is inferred.
 */
export function formatReport({ verdict, boundS, graceS, subjectPid, runs, wall = new Date() }) {
  const lines = [];
  lines.push('=== HANG DETECTOR REPORT ===');
  lines.push(`when            : ${wall.toISOString()}`);
  lines.push(`verdict         : ${verdict}`);
  lines.push(`subject pid     : ${subjectPid}`);
  lines.push(`silence bound   : ${boundS}s`);
  lines.push(`startup grace   : ${graceS}s`);
  lines.push(`attributed runs : ${runs.length}`);

  if (runs.length === 0) {
    lines.push('');
    lines.push('NO RUN was attributed to this subject’s process tree. That is NOT "the run was');
    lines.push('healthy" — it is "nothing reported progress under a base this supervisor could');
    lines.push('read", which is why this report exists rather than a silent pass.');
  }

  for (const r of runs) {
    lines.push('');
    lines.push(`  run pid ${r.pid}  (alive: ${r.alive})`);
    lines.push(`    ${r.reason ?? '(no reason recorded)'}`);
    const open = Array.isArray(r.openModules) ? r.openModules : [];
    if (open.length === 0) {
      lines.push('    open modules: NONE recorded in the last beat.');
      lines.push('      ⚠️ An empty set here is not proof the run was idle: by onTestRunEnd every');
      lines.push('      module has closed, so "empty" and "never populated" look identical at the');
      lines.push('      end state. Treat it as unattributed rather than as an answer.');
    } else {
      lines.push(`    open modules: ${open.length}, oldest-opened first — the stuck candidates:`);
      for (const m of open) {
        lines.push(`      - ${m.module}  last: ${m.last_event}  opened_at_ms: ${m.opened_at_ms}`);
        // The subject of that last event is what names the HOOK or the TEST inside the
        // module. It goes on its own line because a full identity is long, and it is
        // omitted rather than printed empty when the event carried no identity — an absent
        // line is honest, a blank `subject:` reads like a value.
        if (m.last_subject) lines.push(`          subject: ${m.last_subject}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the report where it OUTLIVES the process, atomically.
 *
 * Atomic because a reader may poll it while it is being written, and a partial read is a parse
 * error a consumer could plausibly treat as "no report" — i.e. as silence, the firing value.
 */
export function writeReport(base, subjectPid, text) {
  const dir = join(base, '_reports');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `hang-${subjectPid}.txt`);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, target);
  return target;
}

/**
 * Supervise one command.
 *
 * @param {string[]} argv the subject command and its arguments
 * @param {object} opts
 * @param {string} [opts.base] heartbeat base; defaults to the env, else the repo-relative default
 * @param {number} [opts.boundS] silence bound
 * @param {number} [opts.graceS] startup grace
 * @param {'report'|'terminate'} [opts.onHang] policy. BOTH exit 142; only `terminate` signals.
 * @returns {Promise<{code: number, report: string|null, why: string}>}
 */
export function supervise(argv, opts = {}) {
  const repoRoot = opts.repoRoot ?? resolve(import.meta.dirname, '..', '..');
  const base = opts.base ?? baseFromEnv() ?? baseFromRepoRoot(repoRoot);
  const boundS = opts.boundS ?? DEFAULT_SILENCE_S;
  const graceS = opts.graceS ?? DEFAULT_STARTUP_GRACE_S;
  const absoluteMaxS = opts.absoluteMaxS ?? DEFAULT_ABSOLUTE_MAX_S;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const onHang = opts.onHang ?? 'report';
  const out = opts.stdio ?? 'inherit';

  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('supervise: a command is required — refusing to supervise nothing.');
  }

  return new Promise((resolveP) => {
    // The SUBJECT runs in the background and THIS is the foreground decider. The base is exported
    // so the runner's reporter and this watcher resolve the same location by construction rather
    // than by coincidence.
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd ?? repoRoot,
      env: { ...process.env, [ENV_BASE]: base },
      stdio: out,
    });

    let subjectExit = null;
    child.on('exit', (code, signal) => {
      subjectExit = signal ? 128 + 1 : (code ?? 0);
    });

    const startedAt = Date.now();
    let everSawABeat = false;

    const finish = (code, why, report = null) => {
      clearInterval(timer);
      resolveP({ code, why, report });
    };

    const timer = setInterval(() => {
      const att = attributedRuns(base, child.pid, opts.deps ?? {});

      if (!att.ok) {
        // COULD NOT LOOK. Never the subject's status.
        const text = formatReport({
          verdict: VERDICT.CANNOT_LOOK, boundS, graceS, subjectPid: child.pid, runs: [],
        }) + `\nreason: ${att.reason}\n\nGATE WATCHER COULD NOT LOOK. This run was NOT supervised,\n`
          + "so 'it finished' carries no evidence that it could not have hung. Treat as an\n"
          + 'infrastructure fault, never as a pass.\n';
        let path = null;
        try { path = writeReport(base, child.pid, text); } catch { path = null; }
        try { child.kill('SIGTERM'); } catch { /* the subject may already be gone */ }
        return finish(EXIT_CANNOT_LOOK, att.reason, path);
      }

      // Ask the rule about each attributed run. The rule decides; this only plumbs.
      const judged = att.runs.map((r) => {
        const v = check(runDir(base, r.pid), boundS);
        return { ...r, ...v, openModules: v.openModules };
      });
      if (judged.some((r) => r.verdict !== VERDICT.CANNOT_LOOK)) everSawABeat = true;

      const hung = judged.filter((r) => r.verdict === VERDICT.HUNG);
      if (hung.length > 0) {
        // REPORT BEFORE ANY TERMINATION DECISION — the plan's words, and the ordering matters:
        // a terminated run cannot be asked what it was doing.
        const text = formatReport({
          verdict: VERDICT.HUNG, boundS, graceS, subjectPid: child.pid, runs: hung,
        });
        let path = null;
        try { path = writeReport(base, child.pid, text); } catch { path = null; }
        if (onHang === 'terminate') {
          try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }
        return finish(EXIT_HUNG, `hang detected in ${hung.length} attributed run(s)`, path);
      }

      // ── the startup window ────────────────────────────────────────────────────────────────
      if (!everSawABeat) {
        // ⛔ THE SUBJECT'S DEATH ENDS THE GRACE, and it is checked BEFORE the clock. A dead
        // subject that never beat is a failed run, and its own status is the answer.
        if (subjectExit !== null) {
          return finish(subjectExit, 'subject exited during the startup grace without ever beating');
        }
        if (Date.now() - startedAt > graceS * 1000) {
          const text = formatReport({
            verdict: VERDICT.CANNOT_LOOK, boundS, graceS, subjectPid: child.pid, runs: judged,
          }) + `\nreason: no heartbeat appeared within the ${graceS}s startup grace while the `
            + 'subject was still ALIVE. That is the collection / worker-startup deadlock shape —\n'
            + 'the one that produces a 0-byte log and can run for hours — and it is DISTINCT from\n'
            + 'a run that started and then went quiet.\n';
          let path = null;
          try { path = writeReport(base, child.pid, text); } catch { path = null; }
          if (onHang === 'terminate') {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
          }
          return finish(EXIT_HUNG, 'no heartbeat within the startup grace', path);
        }
        return; // still inside the grace, subject alive — keep waiting
      }

      // Progress is being made, or the subject has finished. Its status is the answer.
      if (subjectExit !== null) {
        return finish(subjectExit, 'subject completed under supervision');
      }

      // ── D-8: THE ABSOLUTE CEILING, AND IT IS DELIBERATELY THE LAST THING CHECKED ─────────
      // Reaching here means: the subject is ALIVE, it is BEATING, and the rule says it is
      // HEALTHY. That is the one shape nothing else bounds — a run that progresses forever —
      // and before this control existed D-6's removal of testTimeout/hookTimeout would have
      // left it with no backstop at all.
      //
      // It consults NO part of the detector: not `classify`, not `check`, not the verdict. Its
      // only input is elapsed wall time, which is what makes it genuinely independent rather
      // than a second opinion on the same evidence.
      const elapsedS = (Date.now() - startedAt) / 1000;
      if (elapsedS > absoluteMaxS) {
        // The report says, in its own words, that NOTHING WAS DETECTED. A reader who finds this
        // must not conclude a hang was diagnosed — the detector was consulted on every poll and
        // never fired.
        const text = formatReport({
          verdict: VERDICT.HEALTHY, boundS, graceS, subjectPid: child.pid, runs: judged,
        }) + `\nABSOLUTE CEILING REACHED: ${Math.round(elapsedS)}s > ${absoluteMaxS}s.\n\n`
          + 'THIS IS NOT A DETECTION. The detector was asked on every poll and never reported a\n'
          + 'hang: the run kept emitting events the whole time. This is the runaway backstop for a\n'
          + 'run that PROGRESSES FOREVER, which no silence bound can catch by construction.\n'
          + 'Re-derive the ceiling with: bash scripts/ops/measure-full-suite-duration.sh\n';
        let path = null;
        try { path = writeReport(base, child.pid, text); } catch { path = null; }
        // The ceiling ALWAYS terminates, regardless of `--on-hang`: that policy governs what to
        // do about a HANG, and this is not one. A runaway left running is the thing this exists
        // to stop.
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        return finish(
          EXIT_ABSOLUTE_CEILING,
          `absolute ceiling reached (${Math.round(elapsedS)}s > ${absoluteMaxS}s) — NOT a hang`,
          path,
        );
      }
    }, pollMs);
  });
}

// ── CLI, so the battery can invoke this directly ────────────────────────────────────────────
// node scripts/lib/hang-supervise.mjs [--on-hang report|terminate] -- <command...>
if (process.argv[1] && process.argv[1].endsWith('hang-supervise.mjs')) {
  const args = process.argv.slice(2);
  const sep = args.indexOf('--');
  if (sep === -1) {
    process.stderr.write(
      'usage: hang-supervise.mjs [--on-hang report|terminate] -- <command...>\n' +
        'The `--` is required: everything after it is the subject, verbatim.\n',
    );
    process.exit(EXIT_CANNOT_LOOK);
  }
  const flags = args.slice(0, sep);
  const cmd = args.slice(sep + 1);
  let onHang = 'report';
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--on-hang') {
      onHang = flags[i + 1];
      i += 1;
      if (!['report', 'terminate'].includes(onHang)) {
        // R-011: a closed vocabulary. An unrecognised policy is an ERROR, never a default.
        process.stderr.write(`hang-supervise: --on-hang must be report|terminate, got ${onHang}\n`);
        process.exit(EXIT_CANNOT_LOOK);
      }
    } else {
      process.stderr.write(`hang-supervise: unrecognised flag ${flags[i]}\n`);
      process.exit(EXIT_CANNOT_LOOK);
    }
  }
  if (cmd.length === 0) {
    process.stderr.write('hang-supervise: no command after `--`\n');
    process.exit(EXIT_CANNOT_LOOK);
  }
  supervise(cmd, { onHang }).then(({ code, why, report }) => {
    process.stderr.write(`hang-supervise: exit ${code} — ${why}\n`);
    if (report) process.stderr.write(`hang-supervise: report written to ${report}\n`);
    process.exit(code);
  });
}
