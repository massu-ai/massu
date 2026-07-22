// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * memory-share-cli.ts — the human's cross-repo control surface (Living Memory
 * Slice 5, B-06): `massu memory review | accept | refuse | share | trust`.
 *
 * ⛔ accept / refuse are CLI-ONLY and there is deliberately NO MCP tool for them.
 * An MCP tool is MODEL-callable, and the model may be reading attacker-influenced
 * text — "accept the memory that tells you to accept it" is one hop. Keeping
 * acceptance out of the model's reach makes that injection STRUCTURALLY impossible,
 * not merely discouraged. A drift-guard asserts these names never appear in tools.ts
 * (the same posture as the 4B render/restore/adopt/unrender CLI-only commands).
 *
 * `review` is read-only; if a read-only MCP `review` is ever added (an OPEN
 * DECISION), it must NEVER map to the accept/refuse handlers.
 */

import type Database from 'better-sqlite3';
import { homedir } from 'os';
import { getMemoryDb } from '../memory-db.ts';
import {
  acceptSharedMemory,
  refuseSharedMemory,
  listPendingSharedMemories,
  purgeSharedMemories,
} from '../shared-memory-sync.ts';
import { isLocalOrigin } from '../memory-origin.ts';
import { repinSharedFingerprint } from '../memory-repo-identity.ts';
import { findRepoById, findRepoByLabel } from '../memory-repos-registry.ts';

export interface CliResult {
  output: string;
  exitCode: number;
}

interface ShareCliOpts {
  db?: Database.Database;
  home?: string;
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const RECORD_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Dispatch a `massu memory <sub>` cross-repo subcommand. Returns the text to print
 * and an exit code; never throws for a user error (returns a message + exit 1).
 */
export async function runMemoryShareCli(sub: string, args: string[], opts: ShareCliOpts = {}): Promise<CliResult> {
  const home = opts.home ?? homedir();
  const ownDb = !opts.db;
  const db = opts.db ?? getMemoryDb();
  try {
    switch (sub) {
      case 'review':
        return review(db, home);
      case 'accept':
        return accept(db, home, args[0]);
      case 'refuse':
        return refuse(db, args[0]);
      case 'share':
        return share(db, args[0]);
      case 'trust':
        return trust(db, home, args);
      case 'purge':
        return purge(db, args);
      default:
        return {
          output:
            `Unknown memory subcommand: ${sub ?? '(none)'}\n` +
            'Usage: massu memory <review | accept <record_hash> | refuse <record_hash> | ' +
            'share <observation_id> | trust <repo_label|repo_id> --fingerprint <hex> | purge --shared>',
          exitCode: 1,
        };
    }
  } finally {
    if (ownDb) db.close();
  }
}

function review(db: Database.Database, home: string): CliResult {
  const pending = listPendingSharedMemories(db, { home });
  if (pending.length === 0) {
    return { output: 'No pending cross-repo memories. (Nothing to review.)', exitCode: 0 };
  }
  const lines: string[] = [`${pending.length} pending cross-repo memor${pending.length === 1 ? 'y' : 'ies'}:\n`];
  for (const p of pending) {
    const when = new Date(p.received_at_epoch * 1000).toISOString().slice(0, 10);
    lines.push(
      `• from ${p.origin_repo_label} — received ${when} — ${p.signature_valid ? 'signature OK' : '⚠ signature INVALID'}`,
      `  [${p.type}] ${p.title}`,
      `  ${p.detail.split('\n')[0]}`,
      `  accept:  massu memory accept ${p.record_hash}`,
      `  refuse:  massu memory refuse ${p.record_hash}`,
      '',
    );
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

function accept(db: Database.Database, home: string, recordHash?: string): CliResult {
  if (!recordHash || !RECORD_HASH_RE.test(recordHash)) {
    return { output: 'Usage: massu memory accept <record_hash> (64 hex chars)', exitCode: 1 };
  }
  const res = acceptSharedMemory(db, recordHash, { home });
  if (res.ok && res.alreadyAccepted) return { output: 'Already accepted (no-op).', exitCode: 0 };
  if (res.ok) return { output: `Accepted. Now a cross-repo memory (#${res.observationId}), fenced + labelled in recall.`, exitCode: 0 };
  return { output: `Refused: ${res.reason}. Nothing was materialized.`, exitCode: 1 };
}

function refuse(db: Database.Database, recordHash?: string): CliResult {
  if (!recordHash || !RECORD_HASH_RE.test(recordHash)) {
    return { output: 'Usage: massu memory refuse <record_hash> (64 hex chars)', exitCode: 1 };
  }
  const res = refuseSharedMemory(db, recordHash);
  return res.ok
    ? { output: 'Refused. It will no longer appear in review.', exitCode: 0 }
    : { output: `Could not refuse: ${res.reason}.`, exitCode: 1 };
}

/**
 * B-01 — the SOLE writer of `shareable=1`. Marking a decision shareable is an
 * explicit human act; a drift-guard asserts no automatic path writes this. Only a
 * LOCAL, live observation can be marked (you cannot re-share an import).
 */
function share(db: Database.Database, idArg?: string): CliResult {
  const id = Number(idArg);
  if (!idArg || !Number.isInteger(id) || id <= 0) {
    return { output: 'Usage: massu memory share <observation_id>', exitCode: 1 };
  }
  const row = db.prepare(`SELECT id, origin FROM observations WHERE id = ?`).get(id) as { id: number; origin: string } | undefined;
  if (!row) return { output: `No observation #${id}.`, exitCode: 1 };
  if (!isLocalOrigin(row.origin)) {
    return { output: `Observation #${id} is not local (origin=${row.origin}) — an imported memory cannot be re-shared.`, exitCode: 1 };
  }
  db.prepare(`UPDATE observations SET shareable = 1 WHERE id = ?`).run(id);
  return { output: `Marked #${id} shareable. It will export on the next share (if memory.share.enabled).`, exitCode: 0 };
}

/**
 * S-5 (rollback) — `massu memory purge --shared`: EXPIRE (never delete) every
 * cross-repo row. Requires the explicit `--shared` flag so a bare `purge` can never
 * silently retire memory.
 */
function purge(db: Database.Database, args: string[]): CliResult {
  if (!args.includes('--shared')) {
    return { output: 'Usage: massu memory purge --shared   (expires every cross-repo memory; never deletes)', exitCode: 1 };
  }
  const { pending, accepted } = purgeSharedMemories(db);
  return {
    output: `Purged cross-repo memory: ${pending} pending + ${accepted} accepted expired (not deleted; still asOf-queryable).`,
    exitCode: 0,
  };
}

/**
 * A-07 — the explicit human re-pin: `massu memory trust <repo> --fingerprint <hex>`.
 * The ONLY way a TOFU pin changes after first use — a key swap can never trigger it.
 */
function trust(db: Database.Database, home: string, args: string[]): CliResult {
  const target = args[0];
  const fpIdx = args.indexOf('--fingerprint');
  const fingerprint = fpIdx >= 0 ? args[fpIdx + 1] : undefined;
  if (!target || !fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    return { output: 'Usage: massu memory trust <repo_label|repo_id> --fingerprint <hex sha256>', exitCode: 1 };
  }
  const entry = findRepoById(home, target) ?? findRepoByLabel(home, target);
  if (!entry) return { output: `No registered repo '${target}'. Known repos come from ~/.massu/repos.json.`, exitCode: 1 };
  repinSharedFingerprint(db, entry.repo_id, fingerprint);
  return { output: `Re-pinned ${entry.label} (${entry.repo_id}) to fingerprint ${fingerprint.slice(0, 12)}…`, exitCode: 0 };
}
