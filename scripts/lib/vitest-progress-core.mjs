// ONE implementation of "what vitest emits, and how we observe it" — shared by every consumer.
//
// ⛔ WHY THIS EXISTS AS A SEPARATE MODULE. Two consumers need the same event surface: D-1's
// gap MEASUREMENT (which sets the silence bound) and D-2's progress HEARTBEAT (which the
// watcher polls). Writing the Proxy twice would put the `then` hazard, the subject-identity
// extraction and the hook derivation into two files that drift — and if they drift, the
// measurement and the detection disagree about what an EVENT is, which silently invalidates
// the bound the measurement produced. So the observation is declared ONCE and each consumer
// supplies only a SINK (Rule 25 / G32).
//
// ⛔ THE HOOK LIST IS DERIVED, NOT HAND-MAINTAINED (G32), AND THAT IS MEASURED RATHER THAN
// ASSUMED. A Proxy answers whatever callback vitest asks for. A list transcribed from the
// `Reporter` interface block in vitest's own type definitions would have MISSED `onTaskUpdate`
// and `onInit` — both fire, neither appears there, and `onTaskUpdate` turned out to be the
// "from" side of all ten longest silences in D-1's 6-run measurement, i.e. the single most
// common last-event-before-a-gap. That is exactly the event whose absence a detector measures.
//
// ⛔ `then` MUST NEVER BE ANSWERED WITH A FUNCTION. A thenable reporter makes `await reporter`
// hang forever — a hang inside the hang detector, which is the worst available failure here.

// Keys that must NOT be answered with a function.
//   `then`/`catch`/`finally` — a thenable reporter deadlocks anything that awaits it.
//   `constructor`/`prototype` — object protocol, not hooks.
const NEVER_A_HOOK = new Set(['then', 'catch', 'finally', 'constructor', 'prototype']);

// Identity of the thing an event is ABOUT.
//
// ⛔ THIS COLLECTS; IT DOES NOT PREFER. The first version tried
// ['fullName','name','moduleId','id'] IN ORDER and returned the FIRST that answered. That is
// first-match-wins over a heterogeneous set of reported entities, and it silently DISCARDS
// every other identity field — reliably including the one a reader needs. Measured 2026-09-24
// over 164/164 `onHookStart` events: a hook arrives as `{ name, entity }`, `name` answers
// second, so every hook event recorded `name=beforeEach` and threw away BOTH
// `entity.fullName` (which test) and `entity.module.moduleId` (which file). A hang inside a
// hook was therefore unattributable — which is precisely what D-7 case 5 must report.
//
// ⛔ THE OWNER WALK IS BOUNDED AT TWO HOPS, BY MEASUREMENT, NOT BY TASTE.
// `entity.module.moduleId` is two hops, so two is what the walk needs. An unbounded walk
// would scrape unrelated strings off a whole object graph and present them as identity.
// HONEST LIMIT (G20): if a future vitest links an owner under a property not named in
// OWNER_LINKS, this misses it — and misses it SILENTLY, as fewer fields rather than an
// error. That is why a subject with no identity at all still renders the `keys=` fallback
// (so "nothing identified this" is visible in the record instead of reading as empty), and
// why hook attribution is asserted by a proof rather than assumed to persist.
//
// ⛔ THE OUTERMOST NODE WINS PER FIELD. A hook's own `name` must not be overwritten by its
// owning test's `name` one hop out: the event is ABOUT the hook, and the owner is CONTEXT.

// The identity fields any reported entity may carry. This order is also the RENDER order.
const IDENTITY_FIELDS = ['moduleId', 'fullName', 'name', 'id'];
// The properties by which a reported entity points at what CONTAINS it.
const OWNER_LINKS = ['entity', 'module', 'task', 'suite', 'parent'];

function collectIdentity(node, out, depth) {
  if (!node || typeof node !== 'object') return;
  for (const k of IDENTITY_FIELDS) {
    const v = node[k];
    // `!(k in out)` is the outermost-wins rule above.
    if (typeof v === 'string' && v && !(k in out)) out[k] = v;
  }
  if (depth <= 0) return;
  for (const link of OWNER_LINKS) {
    const owner = node[link];
    if (owner && typeof owner === 'object') collectIdentity(owner, out, depth - 1);
  }
}

// identityOf(arg) -> { moduleId?, fullName?, name?, id? } — STRUCTURED, so a consumer that
// needs the module reads a FIELD instead of parsing a rendering. The heartbeat's open-module
// tracking used to recover its key by slicing a `moduleId=` prefix off the subject string;
// that parser cannot survive a subject carrying more than one field, and it existed only
// because the sink was handed a lossy string. Handing over the object deletes the parser
// rather than correcting it.
export function identityOf(arg) {
  const out = {};
  collectIdentity(arg, out, 2);
  return out;
}

// The human-readable rendering of that identity. Display only — nothing parses this.
export function subjectOf(arg) {
  if (!arg || typeof arg !== 'object') return '';
  const id = identityOf(arg);
  const parts = IDENTITY_FIELDS.filter((k) => k in id).map((k) => `${k}=${id[k]}`);
  if (parts.length) return parts.join(' ');
  return `keys=${Object.keys(arg).slice(0, 6).join(',')}`;
}

// makeProgressReporter(onBeat) -> a class usable as `--reporter=<module>`.
//
// `onBeat` receives ONE object per callback:
//   { t_ms, wall, event, subject, pid }
// and MUST NOT throw — a sink that breaks the run it observes is worse than no sink. Each
// call is wrapped, and a sink failure is reported to stderr and then swallowed, deliberately:
// the instrument must never be the reason a suite fails.
export function makeProgressReporter(onBeat) {
  if (typeof onBeat !== 'function') {
    // M2 fail closed: a reporter with no sink would run, observe everything, and record
    // nothing — silence indistinguishable from a healthy run.
    throw new Error('makeProgressReporter: onBeat must be a function');
  }

  const handler = {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (NEVER_A_HOOK.has(prop)) return undefined;
      if (!prop.startsWith('on')) return undefined;

      return (...args) => {
        try {
          onBeat({
            // hrtime is monotonic — immune to a clock step mid-run, unlike Date.now().
            t_ms: Number(process.hrtime.bigint() / 1000000n),
            wall: new Date().toISOString(),
            event: prop,
            subject: subjectOf(args[0]),
            // Structured, for consumers that need a FIELD rather than a rendering. The gap
            // reporter deliberately does not persist it: its record shape is what the 90 s
            // bound was measured with, and a new field would make old and new logs
            // incomparable.
            identity: identityOf(args[0]),
            pid: process.pid,
          });
        } catch (e) {
          process.stderr.write(`vitest-progress-core: sink failed: ${e.message}\n`);
        }
      };
    },
    has(_t, prop) {
      return typeof prop === 'string' && prop.startsWith('on') && !NEVER_A_HOOK.has(prop);
    },
  };

  return class ProgressReporter {
    constructor() {
      return new Proxy({}, handler);
    }
  };
}
