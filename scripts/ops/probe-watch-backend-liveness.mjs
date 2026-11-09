/**
 * A/B THE CHOKIDAR BACKEND, INTERLEAVED UNDER ONE LOAD WINDOW.
 *
 * Measuring FSEvents in one window and polling in another compares two different machine
 * states, which is exactly the mistake G27/CR-90 records ("a ratio only cancels load if both
 * sides SEE the same load"). So the two arms ALTERNATE trial by trial: any drift in system
 * load lands on both arms roughly equally.
 *
 * A trial is DEAD when the watcher reported 'ready', emitted no 'error', and then delivered
 * nothing across repeated writes — the exact shape observed in the failing suite run
 * (20 writes, 0 events, no error).
 *
 * Usage: node scripts/ops/probe-watch-backend-liveness.mjs [pairs]
 *        Run it UNDER load (e.g. concurrently with `npm test`); an idle box
 *        shows 0 dead in both arms and the probe exits 3 INCONCLUSIVE.
 */
import { createRequire } from 'module';
// Resolved relative to THIS file so the probe works from any cwd and in a clone.
const require = createRequire(import.meta.url);
const chokidar = require('chokidar');
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

const PAIRS = Number(process.argv[2] ?? 60);
const WRITES = 6;
const WRITE_GAP_MS = 300;

async function trial(polling) {
  const dir = mkdtempSync(resolve(tmpdir(), 'massu-real-chokidar-'));
  mkdirSync(resolve(dir, 'src'), { recursive: true });

  let events = 0;
  let ready = false;
  let errored = false;

  const w = chokidar.watch(['package.json', 'src/**'], {
    cwd: dir,
    ignored: ['**/node_modules/**'],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: false,
    ...(polling ? { usePolling: true, interval: 100 } : {}),
  });
  w.on('all', () => { events++; });
  w.on('ready', () => { ready = true; });
  w.on('error', () => { errored = true; });

  await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < WRITES && events === 0; i++) {
    writeFileSync(resolve(dir, 'src', 'real-event.ts'), `export const x = ${i};\n`, 'utf-8');
    await new Promise((r) => setTimeout(r, WRITE_GAP_MS));
  }

  await w.close();
  rmSync(dir, { recursive: true, force: true });
  return { dead: events === 0 && ready && !errored, delivered: events > 0 };
}

const arm = {
  fsevents: { dead: 0, delivered: 0, n: 0 },
  polling: { dead: 0, delivered: 0, n: 0 },
};

for (let i = 0; i < PAIRS; i++) {
  // Alternate which arm goes first, so a systematic within-pair ordering effect cannot
  // masquerade as a backend difference.
  const order = i % 2 === 0 ? ['fsevents', 'polling'] : ['polling', 'fsevents'];
  for (const name of order) {
    const r = await trial(name === 'polling');
    arm[name].n++;
    if (r.dead) arm[name].dead++;
    if (r.delivered) arm[name].delivered++;
  }
  if ((i + 1) % 10 === 0) {
    process.stdout.write(
      `  pair ${i + 1}/${PAIRS}  fsevents dead=${arm.fsevents.dead}/${arm.fsevents.n}  `
      + `polling dead=${arm.polling.dead}/${arm.polling.n}\n`,
    );
  }
}

console.log('');
console.log('arm        trials  delivered  DEAD (ready, no error, no events)');
for (const name of ['fsevents', 'polling']) {
  const a = arm[name];
  console.log(`${name.padEnd(10)} ${String(a.n).padStart(6)}  ${String(a.delivered).padStart(9)}  ${a.dead}`);
}
console.log('');
if (arm.fsevents.n === 0 || arm.polling.n === 0) {
  console.log('FATAL: an arm ran zero trials — refusing to report a comparison.');
  process.exit(2);
}
// POSITIVE CONTROL: if neither arm saw a dead watcher, the load window was too quiet and
// this run says nothing about the backend. Absence here is "could not look", not "clean".
if (arm.fsevents.dead === 0 && arm.polling.dead === 0) {
  console.log('INCONCLUSIVE: zero dead watchers in BOTH arms — the load window did not');
  console.log('              reproduce the defect, so this run cannot rank the backends.');
  process.exit(3);
}
console.log(
  arm.polling.dead === 0
    ? 'RESULT: polling had ZERO dead watchers while FSEvents did — the backend is the cause.'
    : 'RESULT: polling ALSO went dead — the backend is not the whole story.',
);
