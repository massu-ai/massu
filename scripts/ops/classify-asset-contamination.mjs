// classify-asset-contamination — split the shipped assets' foreign-token hits into
// path-solvable, toolchain-solvable, and genuinely conceptual.
//
// P4.3b-3 of docs/plans/2026-09-20-stack-conformant-asset-rendering.md quotes this tool's
// output to justify how the remaining work is mechanised. It is shipped so the split is a
// COMMAND anyone can re-run rather than a number pasted into a plan that will rot (G1).
//
// ⛔ THE ROOT IS DERIVED, NEVER HARDCODED. The first version of this file carried
// `const REPO = '/Users/<user>/massu-internal'` — lifted verbatim from the scratchpad probe
// it grew out of. Two defects in one line: it published a real home path to a PUBLIC repo
// (caught by the publication gate at sync time, which is the last place you want to find
// out), and a tool that hardcodes one machine's path is not re-runnable by "anyone", which
// was the entire reason for shipping it. A probe becomes a tool when its inputs are derived.
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
const REPO = resolve(import.meta.dirname, '..', '..');
const ORACLE = JSON.parse(readFileSync(resolve(REPO,'scripts/lib/stack-foreign-tokens.json'),'utf-8'));
const pats = [...ORACLE.vocabulary, ...ORACLE.prose];
const files = execFileSync('git', ['ls-files','packages/core/commands','packages/core/agents',
  'packages/core/patterns','packages/core/protocols','packages/core/reference'],
  {cwd:REPO,encoding:'utf-8'}).split('\n').filter((f)=>f.endsWith('.md'));
const byToken = new Map();
let totalLines = 0;
const pathOnly = [], conceptual = [], toolchainOnly = [];
for (const rel of files) {
  const lines = readFileSync(resolve(REPO,rel),'utf-8').split('\n');
  lines.forEach((l,i)=>{
    const hits = pats.filter((t)=> new RegExp(t.pattern).test(l));
    if (!hits.length) return;
    totalLines++;
    for (const h of hits) byToken.set(h.pattern, (byToken.get(h.pattern)||0)+1);
    // Would substituting the source-path variable alone clear this line?
    // (a) the EXISTING path variable
    const c1 = l.replace(/packages\/core\/src/g, '{{paths.source}}').replace(/packages\/core/g,'{{paths.source}}/..');
    // (b) PLUS the EXISTING Stack Capability Contract variables
    const c2 = c1
      .replace(/npx vitest|\bvitest\b/g, '{{verify.test}}')
      .replace(/npm run build:hooks/g, '{{verify.build}}')
      .replace(/npm run build/g, '{{verify.build}}')
      .replace(/npm (run )?test/g, '{{verify.test}}')
      .replace(/npx tsc[^`\n]*/g, '{{verify.type}}');
    const stillA = pats.some((t)=> new RegExp(t.pattern).test(c1));
    const stillB = pats.some((t)=> new RegExp(t.pattern).test(c2));
    if (!stillA) pathOnly.push('p');
    else if (!stillB) toolchainOnly.push('t');
    else conceptual.push(`${rel.replace('packages/core/','')}:${i+1}  ${l.trim().slice(0,96)}`);
  });
}
process.stderr.write(`hit lines total: ${totalLines}\n`);
process.stderr.write(`  cleared by the EXISTING path variable       : ${pathOnly.length}\n`);
process.stderr.write(`  cleared by EXISTING verify.* variables      : ${toolchainOnly.length}\n`);
process.stderr.write(`  genuinely CONCEPTUAL (need a fragment)      : ${conceptual.length}\n\n`);
process.stderr.write('=== a sample of what genuinely needs a FRAGMENT ===\n');
for (const c of conceptual.slice(0,14)) process.stderr.write('  '+c+'\n');
