// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * scripts/ops/publish-and-verify-release.sh must refuse to publish unless HEAD IS the release tag.
 *
 * npm records the commit HEAD is at as `gitHead`. A publish from a commit past the tag makes npm and
 * the tag disagree about which commit shipped, and a pushed tag should not be moved afterwards. So the
 * only rule that cannot drift is: no tag at HEAD, no publish (and no dirty tree either).
 *
 * The check applies to the repo's REAL package (the script's own `packages/core`), never to an
 * override fixture, so this test builds a throwaway repo with the real layout: the script copied to
 * `scripts/ops/`, a fixture `packages/core`, and a stub `npm` first on PATH whose registry is a closed
 * local port. Every git call uses the sandbox env (G29), so it cannot touch the real repository.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gitSafeEnvForNewRepo } from './helpers/git-safe-env.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REAL_SCRIPT = join(REPO_ROOT, 'scripts/ops/publish-and-verify-release.sh');
const VERSION = '0.0.0-tagcheck';

const STUB_NPM = `#!/usr/bin/env bash
case "$1" in
  whoami)  echo stub-user ;;
  publish) echo "STUB-PUBLISH-RAN"; exit 0 ;;
  view)    if [ "$2" = "@massu/core" ]; then echo 0.0.1; exit 0; fi; exit 1 ;;
  *) echo "stub npm: unexpected '$*'" >&2; exit 99 ;;
esac
`;
const DECIDING_GATE =
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=JSON.parse(d).tool_input.command;" +
  "process.exit(c==='echo hello'?0:2);});\n";

let work: string;
let repo: string;
let stubDir: string;

const gitEnv = () => ({
  ...gitSafeEnvForNewRepo(),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: gitEnv(), encoding: 'utf-8' });

function publish() {
  const r = spawnSync('bash', [join(repo, 'scripts/ops/publish-and-verify-release.sh'), '--publish'], {
    encoding: 'utf-8',
    cwd: repo,
    env: {
      ...gitEnv(),
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      npm_config_registry: 'http://127.0.0.1:9/',
      MASSU_PUBLISH_VERIFY_DEADLINE_SECS: '0',
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'publish-tag-'));
  repo = join(work, 'repo');
  stubDir = join(work, 'bin');
  mkdirSync(stubDir);
  writeFileSync(join(stubDir, 'npm'), STUB_NPM);
  chmodSync(join(stubDir, 'npm'), 0o755);
  mkdirSync(join(repo, 'scripts', 'ops'), { recursive: true });
  copyFileSync(REAL_SCRIPT, join(repo, 'scripts/ops/publish-and-verify-release.sh'));
  const pkg = join(repo, 'packages', 'core');
  mkdirSync(join(pkg, 'dist', 'hooks'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@massu/core', version: VERSION }));
  writeFileSync(
    join(pkg, 'dist', 'hooks', 'h.js'),
    'function f(){ process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "X", additionalContext: "" } })); }\n',
  );
  writeFileSync(join(pkg, 'dist', 'hooks', 'pre-tool-use-gate.js'), DECIDING_GATE);
  // dist/ is build output, never committed; ignore it so a clean checkout is clean.
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  execFileSync('git', ['init', '--quiet'], { cwd: repo, env: gitSafeEnvForNewRepo() });
  git('add', '-A');
  git('commit', '--quiet', '-m', 'release');
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('publish refuses unless HEAD is exactly the release tag', () => {
  it('precondition: the sandbox is its own repository, not the real one', () => {
    expect(git('rev-parse', '--show-toplevel').trim()).toBe(execFileSync('realpath', [repo], { encoding: 'utf-8' }).trim());
  });

  it('HEAD with no release tag -> exit 2, and npm publish is never run', () => {
    const r = publish();
    expect(r.out).toContain(`is not tagged v${VERSION}`);
    expect(r.out).not.toContain('STUB-PUBLISH-RAN');
    expect(r.status).toBe(2);
  });

  it('a tag on an EARLIER commit still refuses (the 2.5.8 shape)', () => {
    git('tag', `v${VERSION}`);
    writeFileSync(join(repo, 'notes.txt'), 'post-tag bookkeeping\n');
    git('add', 'notes.txt');
    git('commit', '--quiet', '-m', 'bookkeeping after the tag');
    try {
      const r = publish();
      expect(r.out).toContain(`is not tagged v${VERSION}`);
      expect(r.out).not.toContain('STUB-PUBLISH-RAN');
      expect(r.status).toBe(2);
    } finally {
      git('tag', '-d', `v${VERSION}`);
    }
  });

  it('HEAD tagged but the tree dirty -> exit 2', () => {
    git('tag', `v${VERSION}`);
    writeFileSync(join(repo, 'uncommitted.txt'), 'x\n');
    try {
      const r = publish();
      expect(r.out).toContain('working tree is dirty');
      expect(r.out).not.toContain('STUB-PUBLISH-RAN');
      expect(r.status).toBe(2);
    } finally {
      rmSync(join(repo, 'uncommitted.txt'));
      git('tag', '-d', `v${VERSION}`);
    }
  });

  it('negative control: HEAD exactly tagged and clean -> passes the check and npm publish runs', () => {
    git('tag', `v${VERSION}`);
    try {
      const r = publish();
      expect(r.out).toContain(`HEAD is exactly v${VERSION} and the tree is clean`);
      expect(r.out).toContain('STUB-PUBLISH-RAN');
    } finally {
      git('tag', '-d', `v${VERSION}`);
    }
  });
});
