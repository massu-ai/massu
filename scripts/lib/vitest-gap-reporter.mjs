// D-1 measurement SINK: record a monotonic timestamp for every reporter callback vitest
// invokes, so the inter-event gap distribution can be measured rather than guessed.
//
// The observation surface — the Proxy, the derived hook list, the `then` refusal, the
// subject-identity extraction — lives in ONE place, `vitest-progress-core.mjs`, shared with
// D-2's heartbeat sink. Duplicating it would let the MEASUREMENT and the DETECTION drift
// apart about what an event IS, which would silently invalidate the bound this measurement
// produced (Rule 25 / G32).
//
// ⛔ THE RECORD SHAPE IS LOAD-BEARING AND MUST NOT DRIFT. `vitest-gap-analyse.mjs` reads
// `t_ms` and `event` and counts anything malformed, and the 6-run measurement behind the 90 s
// silence bound was taken with these exact fields. A behavioural equivalence check — the
// event+subject sequence, timestamps excluded — is the evidence that extracting the shared
// core changed nothing observable.

import { appendFileSync } from 'node:fs';
import { makeProgressReporter } from './vitest-progress-core.mjs';

const OUT = process.env.GAP_LOG;
if (!OUT) {
  // M2 fail closed: a measurement instrument with nowhere to write must not run silently.
  throw new Error('gap-reporter: GAP_LOG is unset — refusing to run and report nothing');
}

export default makeProgressReporter((beat) => {
  // `pid` is deliberately NOT written: the analyser's field set is what the 90 s measurement
  // was taken with, and adding a field would make old and new logs incomparable.
  const rec = {
    t_ms: beat.t_ms,
    wall: beat.wall,
    event: beat.event,
    subject: beat.subject,
  };
  try {
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
  } catch (e) {
    // Never let the instrument break the run it is measuring.
    process.stderr.write(`gap-reporter: write failed: ${e.message}\n`);
  }
});
