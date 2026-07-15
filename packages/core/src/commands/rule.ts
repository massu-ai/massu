// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * `massu rule <subcommand>` — auto-learning rule-candidate CLI surface.
 *
 * Today this hosts a SINGLE structural side-effect that the `/massu-rule`
 * markdown protocol cannot perform itself (it is assistant-driven and has no
 * SQLite handle): recording the `shown` promotion-funnel event.
 *
 * Subcommands:
 *   record-shown <prompt_hash>
 *     Enqueue a `shown` funnel event into the local outbound store
 *     (rule_promotion_events_outbound) so the auto-learning analytics dashboard
 *     can show the proposed→SHOWN→approved/dismissed funnel (P1-002,
 *     plan-2026-06-01-auto-learning-analytics-dashboard). Team-gated (org-scoped
 *     analytics is a Team feature; CR-54/CR-55 ladder) via a CACHE-ONLY tier
 *     read (never a network hit). Best-effort: a sub-Team seat is a silent
 *     no-op (exit 0) — funnel capture is non-essential telemetry and must NEVER
 *     break the `show` protocol step.
 *
 * Exit code matrix for `record-shown`:
 *   0 = enqueued OR silently skipped (sub-Team / best-effort no-op)
 *   2 = usage error (missing / malformed prompt_hash)
 */

import { join } from 'node:path';
import { getMemoryDb, enqueueRulePromotionEvent } from '../memory-db.ts';
import { getProjectRoot } from '../config.ts';
import { undeliveredSnapshot } from '../rule-delivery.ts';
// W-4 (Layer 2): these were shipped with ZERO production callers. The promotion
// path — the whole OUTPUT side of the paid learning loop — was unreachable.
import {
  applyRuleCandidate,
  dismissRuleCandidate,
  isRuleDestination,
  readCandidate,
  type RuleDestination,
} from '../rule-candidate-applier.ts';
import {
  renderHardenedPreview,
  validateReviewAttestation,
  recordHardenedReviewAttestation,
} from '../rule-candidate-preview.ts';
import { getCandidate } from '../rule-candidate-store.ts';
import { renderCandidatePreview } from '../rule-candidate-renderer.ts';
import {
  evaluateCr53Effectiveness,
  parseKnownLimitations,
} from '../rule-promotion-effectiveness.ts';

/** The destinations a rule may be promoted to (for the usage message). */
const RULE_DESTINATIONS: readonly RuleDestination[] = [
  'corrections-md',
  'claude-md-cr',
  'pattern-scanner',
  'custom-destination',
];

/** Read `--flag value` out of argv. Returns undefined when the flag is absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}
import { getCachedTierReadOnly } from '../license.ts';
import { entitledForTeamSharedPromotion } from '../auto-learning-entitlement.ts';
import { pullInstalledPackRules } from '../rule-pack-sync.ts';

/** Same 16-hex identity as promoted_rules.prompt_hash / the migration CHECK. */
const PROMPT_HASH_RE = /^[0-9a-f]{16}$/;

export async function handleRuleSubcommand(
  args: string[],
): Promise<{ exitCode: number }> {
  const sub = args[0];

  switch (sub) {
    case 'record-shown': {
      const promptHash = args[1];
      if (!promptHash || !PROMPT_HASH_RE.test(promptHash)) {
        process.stderr.write(
          'Usage: massu rule record-shown <prompt_hash>  (16-hex)\n',
        );
        return { exitCode: 2 };
      }
      try {
        const db = getMemoryDb();
        try {
          // Team-gate: org-scoped funnel analytics is a Team feature. Cache-only
          // read — no network, fail-closed to 'free' on any miss.
          if (entitledForTeamSharedPromotion(getCachedTierReadOnly(db))) {
            enqueueRulePromotionEvent(db, {
              prompt_hash: promptHash,
              event_type: 'shown',
              created_at: new Date().toISOString(),
              metadata: {},
            });
          }
        } finally {
          db.close();
        }
      } catch {
        // Best-effort funnel telemetry — never fail the show protocol step.
      }
      return { exitCode: 0 };
    }
    case 'packs': {
      // P2-002 (curated-rule-packs): pull the org's INSTALLED-pack rules from the
      // `/installed-rules` Edge Function, verify the Ed25519 envelope, and
      // materialize each as a provenance-tagged `origin:'pack'` candidate sidecar.
      // The pull module NEVER applies — surfaced for `show` → `approve`. Tier-gated
      // (Team+) inside `pullInstalledPackRules` via a cache-only tier read. Mirrors
      // the `pull` subcommand (which invokes `pullTeamPromotions`).
      try {
        const db = getMemoryDb();
        try {
          const res = await pullInstalledPackRules(db);
          process.stdout.write(
            `pack rules: pulled=${res.pulled} materialized=${res.materialized} ` +
              `skipped=${res.skipped} dropped_unverified=${res.dropped_unverified}\n`,
          );
        } finally {
          db.close();
        }
      } catch {
        // Best-effort — a network/parse failure must never crash the CLI.
        process.stdout.write(
          'pack rules: pulled=0 materialized=0 skipped=0 dropped_unverified=0\n',
        );
      }
      return { exitCode: 0 };
    }
    case 'effectiveness': {
      // DF-2 (audit 2026-07-14): the REAL entry point for the CR-53 effectiveness
      // check. `evaluateCr53Effectiveness` / `parseKnownLimitations` had NO runtime
      // caller — they ran ONLY against a synthetic :memory: test, so CR-53's promise
      // (flag a promoted rule that RECURS over the real audit_log) never actually
      // executed at runtime. This runs it against the live memory DB + the real
      // increment-failure log, and exits non-zero when the invariant is violated.
      const db = getMemoryDb();
      try {
        const failureLogPath = join(
          getProjectRoot(),
          '.massu',
          'rule-candidates',
          '.cr53-increment-failures.jsonl',
        );
        const knownLimitations = parseKnownLimitations(process.env.MASSU_KNOWN_RULE_LIMITATIONS);
        const result = evaluateCr53Effectiveness({ db, failureLogPath, knownLimitations });
        if (result.ok) {
          process.stdout.write(
            'CR-53 effectiveness: OK — every rule promoted more than 7 days ago has prevented ' +
              'its bug class (0 recurrences), and no unresolved increment failures.\n',
          );
          return { exitCode: 0 };
        }
        process.stdout.write(
          `CR-53 effectiveness: PROBLEM — ${result.auditViolations.length} recurring promoted ` +
            `rule(s) and ${result.failureLogViolations.length} unresolved increment failure(s) ` +
            `in the last 7 days.\n` +
            '  A recurrence means an auto-learned rule did NOT prevent the bug class it was ' +
            'promoted to enforce.\n',
        );
        for (const v of result.auditViolations) {
          process.stdout.write(
            `  - rule ${v.promptHash} recurred ${v.recurrenceCount}x ` +
              `(audit_log #${v.auditLogId}, promoted ${v.timestamp})` +
              (v.filePath ? ` — ${v.filePath}` : '') +
              '\n',
          );
        }
        for (const v of result.failureLogViolations) {
          process.stdout.write(
            `  - increment failure: ${v.error ?? 'recent entry'} ${v.timestamp ?? ''}\n`,
          );
        }
        process.stdout.write(
          '  If a recurrence is a genuine documented limitation, allowlist it via the ' +
            'MASSU_KNOWN_RULE_LIMITATIONS env var.\n',
        );
        return { exitCode: 1 };
      } finally {
        db.close();
      }
    }
    case 'show': {
      // DF-1 (audit 2026-07-14): the LIVE surface for `renderCandidatePreview`.
      // The renderer had zero production callers — a human had no way to inspect
      // a detected candidate (the correction, its score/signals, what it reacted
      // to) before deciding to review/approve/dismiss. This reads the real
      // sidecar payload + the DB row and renders that data — nothing fabricated.
      const candidateId = args[1];
      if (!candidateId) {
        process.stderr.write('Usage: massu rule show <candidate_id>\n');
        return { exitCode: 2 };
      }
      let payload;
      try {
        payload = readCandidate(candidateId);
      } catch (err) {
        process.stderr.write(`massu: ${err instanceof Error ? err.message : String(err)}\n`);
        return { exitCode: 1 };
      }
      const db = getMemoryDb();
      try {
        const row = getCandidate(db, candidateId);
        const preview = renderCandidatePreview({
          prompt_hash: payload.prompt_hash,
          prompt: payload.prompt,
          score: payload.score,
          signals: payload.signals,
          prior_turn_files: payload.prior_turn_files,
          timestamp: payload.timestamp,
          origin: row?.origin ?? 'local',
          status: row?.status ?? 'proposed',
          destination: payload.destination ?? row?.destination ?? null,
          ...(payload.draft_text ? { draft_text: payload.draft_text } : {}),
        });
        process.stdout.write(preview + '\n');
        return { exitCode: 0 };
      } finally {
        db.close();
      }
    }
    case 'review': {
      // W-4 (Layer 2): THE CR-57 HARDENED PREVIEW, FINALLY REACHABLE.
      // `renderHardenedPreview` / `validateReviewAttestation` /
      // `recordHardenedReviewAttestation` were shipped with ZERO production callers
      // — a two-operator safety review for EXECUTABLE rules that no code path could
      // ever invoke. A safety gate nothing calls is not a safety gate.
      //
      //   massu rule review <candidate_id> --destination <d> --draft <text>
      //     → renders exactly what would be applied + the static risk findings.
      //   ... --attest-operator <id> --attest-note <text>
      //     → records the second-operator attestation onto the candidate sidecar,
      //       which is what lets the hardened rule publish cross-seat at all.
      const candidateId = args[1];
      if (!candidateId) {
        process.stderr.write(
          'Usage: massu rule review <candidate_id> --destination <dest> --draft <text>\n' +
            '                        [--attest-operator <id> --attest-note <text>]\n',
        );
        return { exitCode: 2 };
      }
      const destination = flagValue(args, '--destination');
      const draft = flagValue(args, '--draft');
      if (!destination || !isRuleDestination(destination) || draft === undefined) {
        process.stderr.write('massu: review requires --destination <dest> and --draft <text>\n');
        return { exitCode: 2 };
      }

      const preview = renderHardenedPreview(destination, draft);
      process.stdout.write(
        `Hardened promotion review — ${preview.destination}\n\n` +
          `This is EXACTLY what would be applied (it is displayed, never run):\n` +
          `${'-'.repeat(60)}\n${preview.rendered}\n${'-'.repeat(60)}\n\n`,
      );
      if (preview.riskFindings.length > 0) {
        process.stdout.write(
          `RISK FINDINGS — ${preview.riskFindings.length} pattern(s) a second operator must weigh:\n` +
            preview.riskFindings.map((f) => `  - ${f}\n`).join('') +
            '\nThese are advisory, not auto-rejections. A human decides.\n\n',
        );
      } else {
        process.stdout.write('No static risk patterns matched.\n\n');
      }

      const operator = flagValue(args, '--attest-operator');
      if (!operator) {
        process.stdout.write(
          'To attest (required before a hardened rule can be shared with your team):\n' +
            `  massu rule review ${candidateId} --destination ${destination} --draft '<text>' \\\n` +
            `    --attest-operator <your-id> --attest-note '<why this is safe>'\n`,
        );
        return { exitCode: 0 };
      }
      try {
        const attestation = validateReviewAttestation({
          second_operator_id: operator,
          reviewed_at: new Date().toISOString(),
          note: flagValue(args, '--attest-note') ?? '',
        });
        const sidecar = join(getProjectRoot(), '.massu', 'rule-candidates', `${candidateId}.json`);
        recordHardenedReviewAttestation(sidecar, attestation);
        process.stdout.write(`Attestation recorded by '${operator}'. This candidate may now be approved.\n`);
        return { exitCode: 0 };
      } catch (err) {
        process.stderr.write(
          `massu: attestation refused: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return { exitCode: 1 };
      }
    }
    case 'approve': {
      // W-4 / THE ROOT CAUSE OF ZERO PROMOTIONS (Layer 2).
      //
      // `applyRuleCandidate()` — the chokepoint the /massu-rule protocol calls "the
      // single authoring surface for new rules", carrying the whole transaction,
      // snapshot-rollback, audit-log and team-publish machinery — had ZERO CALLERS.
      // The protocol markdown said "Invoke applyRuleCandidate(...)"; no command
      // existed that could. The paid learning loop had no OUTPUT. This is it.
      const candidateId = args[1];
      if (!candidateId) {
        process.stderr.write(
          'Usage: massu rule approve <candidate_id> --destination <dest> --draft <text> [--slug <s>]\n',
        );
        return { exitCode: 2 };
      }
      const destination = flagValue(args, '--destination');
      const draftText = flagValue(args, '--draft');
      if (!destination || !isRuleDestination(destination)) {
        process.stderr.write(
          `massu: --destination must be one of: ${RULE_DESTINATIONS.join(', ')}\n`,
        );
        return { exitCode: 2 };
      }
      if (draftText === undefined) {
        process.stderr.write('massu: approve requires --draft <text>\n');
        return { exitCode: 2 };
      }

      const db = getMemoryDb();
      try {
        const result = await applyRuleCandidate(db, {
          candidateId,
          destination,
          draftText,
          ...(flagValue(args, '--slug') ? { slug: flagValue(args, '--slug') as string } : {}),
        });
        if (!result.ok) {
          process.stderr.write(`massu: promotion refused: ${result.error}\n`);
          return { exitCode: result.tier_refused ? 3 : 1 };
        }
        process.stdout.write(
          `Rule promoted to ${destination}.\n` +
            (result.team_shared
              ? '  Queued to share with your team. It will be delivered on the next sync — and it ' +
                'will NOT be deleted until your team\'s server confirms receipt.\n'
              : '  Local only (team sharing needs a Team seat and a shareable destination).\n'),
        );
        return { exitCode: 0 };
      } finally {
        db.close();
      }
    }
    case 'dismiss': {
      // The other half of the funnel — also previously uncallable.
      const candidateId = args[1];
      if (!candidateId) {
        process.stderr.write('Usage: massu rule dismiss <candidate_id> [--reason "..."]\n');
        return { exitCode: 2 };
      }
      const db = getMemoryDb();
      try {
        const result = dismissRuleCandidate(db, {
          candidateId,
          reason: flagValue(args, '--reason') ?? '',
        });
        if (!result.ok) {
          process.stderr.write(`massu: dismiss failed: ${result.error}\n`);
          return { exitCode: 1 };
        }
        process.stdout.write('Candidate dismissed.\n');
        return { exitCode: 0 };
      } finally {
        db.close();
      }
    }
    case 'delivery-status': {
      // D-6 (Layer 2): THE READER. Before this, the ONLY analytics event Massu had
      // ever recorded was `cloud_sync_giveup` — the sync giving up — and NOTHING
      // read it. Detection without delivery is not detection. This surfaces, in
      // plain terms: what has not reached your team, how long it has been stuck,
      // why, and whether anything was ever thrown away.
      const db = getMemoryDb();
      try {
        const snap = undeliveredSnapshot(db);
        const rules = snap.promotions + snap.revocations;
        const giveups = db
          .prepare(
            `SELECT COUNT(*) AS n, MAX(created_at) AS last
               FROM analytics_events WHERE event_type = 'cloud_sync_giveup'`,
          )
          .get() as { n: number; last: string | null };
        const lastErr = db
          .prepare(
            `SELECT last_error FROM team_promotion_outbound
              WHERE last_error IS NOT NULL ORDER BY attempts DESC LIMIT 1`,
          )
          .get() as { last_error: string } | undefined;

        if (rules === 0 && snap.events === 0) {
          process.stdout.write('Rule delivery: everything has reached your team. Nothing queued.\n');
        } else {
          process.stdout.write(
            `Rule delivery: ${rules} learned rule(s) and ${snap.events} funnel event(s) ` +
              `have NOT yet reached your team.\n` +
              `  They are SAFE — nothing is ever deleted until the server confirms it.\n` +
              (snap.oldest_rule_created_at
                ? `  Oldest waiting since: ${snap.oldest_rule_created_at}\n`
                : '') +
              `  Delivery attempts so far: ${snap.max_rule_attempts}\n` +
              (lastErr?.last_error ? `  Last error: ${lastErr.last_error}\n` : '') +
              (snap.stalled
                ? `  STALLED — this is not retrying its way out. Check your API key and endpoint ` +
                  `(\`massu doctor\`).\n`
                : ''),
          );
        }
        if (giveups.n > 0) {
          process.stdout.write(
            `\nCloud sync has given up ${giveups.n} time(s) (most recent: ${giveups.last}).\n` +
              `  Session/observation data from those attempts was dropped; learned rules were not.\n`,
          );
        }
        return { exitCode: snap.stalled ? 1 : 0 };
      } finally {
        db.close();
      }
    }
    case '--help':
    case '-h':
    case undefined: {
      process.stdout.write(
        'massu rule <subcommand>\n\n' +
          'Subcommands:\n' +
          '  show <id>                   Show a detected candidate (the correction, score, signals,\n' +
          '                              what it reacted to) before deciding to review/approve/dismiss.\n' +
          '  approve <id> --destination <d> --draft <text>\n' +
          '                              Promote a candidate to a rule (Pro+). Shares to your team at Team+.\n' +
          '  dismiss <id> [--reason ...] Dismiss a candidate and downweight its signals.\n' +
          '  review <id> --destination <d> --draft <text>\n' +
          '                              Preview a HARDENED (executable) promotion + its risk findings;\n' +
          '                              add --attest-operator/--attest-note to record a 2nd-operator review.\n' +
          '  record-shown <prompt_hash>  Record a `shown` promotion-funnel event (Team-gated, best-effort).\n' +
          '  packs                       Pull installed rule-pack rules as reviewable candidates (Team-gated).\n' +
          '  delivery-status             Show which learned rules have not yet reached your team, and why.\n' +
          '  effectiveness               Check CR-53 over the live audit_log: has any promoted rule\n' +
          '                              (older than 7 days) failed to prevent its bug class? Exits non-zero if so.\n',
      );
      return { exitCode: 0 };
    }
    default: {
      process.stderr.write(`massu: unknown rule subcommand: ${sub}\n`);
      return { exitCode: 2 };
    }
  }
}
