#!/usr/bin/env node
// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

// ============================================================
// P3-003: Stop (Session End) Hook
// Generates session summary and archives CURRENT.md.
// Dependencies: P1-002, P5-001, P5-002
// ============================================================

import { getMemoryDb, endSession, addSummary, createSession, addConversationTurn, addToolCallDetail, getLastProcessedLine, setLastProcessedLine, getRecurrenceCountForPromptHash, embedMissingObservations } from '../memory-db.ts';
// Layer 2: learned rules are delivered under a lease/ack contract — a promoted
// rule is deleted ONLY when the server confirms it. See rule-delivery.ts.
import { leaseLearning, ackLearning, nackLearning, type LearningLease } from '../rule-delivery.ts';
import { generateCurrentMd } from '../session-state-generator.ts';
import { archiveAndRegenerate } from '../session-archiver.ts';
import { parseTranscriptFrom, estimateTokens } from '../transcript-parser.ts';
import { syncToCloud, drainSyncQueue } from '../cloud-sync.ts';
import { pullTeamPromotions } from '../team-rule-sync.ts';
import { importSharedMemories } from '../shared-memory-sync.ts';
import { exportSharedMemories } from '../shared-memory-export.ts';
import { LocalFsTransport } from '../shared-memory-transport.ts';
import { getConfig } from '../config.ts';
import { calculateQualityScore, storeQualityScore, backfillQualityScores } from '../analytics.ts';
import { extractTokenUsage, calculateCost, storeSessionCost } from '../cost-tracker.ts';
import { analyzeSessionPrompts } from '../prompt-analyzer.ts';
import { runSessionSupersedeSweep } from '../memory-supersede.ts';
import { runConsolidation } from '../memory-consolidate.ts';
import { resolveConsolidationConfig } from '../consolidation-config.ts';
import type { SyncPayload } from '../cloud-sync.ts';
import type { SessionSummary } from '../memory-db.ts';
import type { TranscriptEntry, TranscriptContentBlock } from '../transcript-parser.ts';
import { recordHookFailure } from './lib/hook-failure-signal.ts';
import { isDirectInvocation } from './lib/is-direct-invocation.ts';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

async function main(): Promise<void> {
  try {
    const input = await readStdin();
    const hookInput = JSON.parse(input) as HookInput;
    const { session_id, cwd } = hookInput;

    const db = getMemoryDb();
    try {
      // Ensure session exists
      createSession(db, session_id);

      // 1. Get all observations for this session. LIMIT 10000 caps per-session
      // observation count (P-DG-001) — a long session has thousands; 10000 is
      // multiple orders beyond realistic.
      const observations = db.prepare(
        'SELECT * FROM observations WHERE session_id = ? ORDER BY created_at_epoch ASC LIMIT 10000'
      ).all(session_id) as Array<Record<string, unknown>>;

      // 2. Get user prompts. LIMIT 10000 caps per-session prompts (P-DG-001).
      const prompts = db.prepare(
        'SELECT prompt_text FROM user_prompts WHERE session_id = ? ORDER BY prompt_number ASC LIMIT 10000'
      ).all(session_id) as Array<{ prompt_text: string }>;

      // 3. Generate structured summary from observations
      const summary = buildSummaryFromObservations(observations, prompts);

      // 4. Insert summary
      addSummary(db, session_id, summary);

      // 4.5. Capture conversation turns and tool call details from transcript (P2-002)
      try {
        await captureConversationData(db, session_id, hookInput.transcript_path);
      } catch (_captureErr) {
        // Best-effort: never block session end
      }

      // 4.6. Calculate and store quality score
      try {
        const { score, breakdown } = calculateQualityScore(db, session_id);
        if (score !== 50) {
          storeQualityScore(db, session_id, score, breakdown);
        }
        backfillQualityScores(db);
      } catch (_qualityErr) {
        // Best-effort: never block session end
      }

      // 4.7. Calculate and store session cost
      try {
        const { entries } = await parseTranscriptFrom(hookInput.transcript_path, 0);
        const tokenUsage = extractTokenUsage(entries);
        const cost = calculateCost(tokenUsage);

        storeSessionCost(db, session_id, tokenUsage, cost);
      } catch (_costErr) {
        // Best-effort: never block session end
      }

      // 4.8. Analyze prompt effectiveness
      try {
        analyzeSessionPrompts(db, session_id);
      } catch (_promptErr) {
        // Best-effort: never block session end
      }

      // NOTE (plan-memory-ingestion-decision-noise-fix D-E, REVERTED): a session-end
      // extractDecisions capture was tried here and REFUTED by evidence — regex-extracting
      // "decisions" from free-text assistant reasoning is too noisy for durable memory
      // files: in massu-dev sessions the assistant DISCUSSES decisions constantly, so every
      // paragraph containing "decision"/"chose"/"approach:" was captured as an importance-5
      // "decision" titled with a raw sentence fragment (40 junk rows in one session). Same
      // noise class as D-A, just sourced from assistant text. Genuine decisions are captured
      // ONLY via the explicit `massu_adr_create` tool. See CR-52 arch finding + the incident.

      // 4.9. Embed-on-capture sweep (P2-002, plan-living-memory-slice-2a).
      // Embed this session's new observations so semantic recall works next
      // turn. Budgeted (~3s) + fail-open: NEVER delays or breaks session end —
      // a slow/absent embedder just embeds fewer rows (recall stays FTS-only).
      try {
        await embedMissingObservations(db, { budgetMs: 3000 });
      } catch (_embedErr) {
        // Best-effort: never block session end.
      }

      // 4.10. Supersede-don't-delete contradiction sweep (P2-003,
      // plan-living-memory-slice-2-temporal-model). Runs AFTER the embed sweep
      // so this session's gated observations + auto-captured decisions have
      // vectors to compare. When a new record contradicts a semantically-related
      // live prior, the prior is marked superseded (valid_to/expired_at set) —
      // NEVER deleted. Budgeted + fail-open: a slow/absent embedder or disabled
      // config just supersedes nothing (prior behavior). Kept here (not in the
      // hot post-tool-use hook) because it embeds text.
      try {
        await runSessionSupersedeSweep(db, session_id, { budgetMs: 4000 });
      } catch (_supersedeErr) {
        // Best-effort: never block session end.
      }

      // 4.11. Bounded consolidation sweep (plan-living-memory-slice-3).
      //
      // THIS is how consolidation reaches someone who just downloaded Massu:
      // no scheduler, no cron, no Guardian, no OS dependency — each session
      // does a small, budgeted slice of the maintenance work (dedupe,
      // summarize dying sessions, promote repeated corrections, expire dead
      // weight, reweight by what actually got used). The engine is resumable
      // and idempotent, so "a slice per session" converges to the same result
      // as one big nightly pass.
      //
      // A scheduled deep pass (`massu consolidate`) is an OPTIONAL extra for
      // people who want one; the lease inside runConsolidation guarantees the
      // two can never run at once and corrupt each other's cursors.
      //
      // Budgeted + fail-open: session end is never delayed or broken by it.
      try {
        const consolidationCfg = resolveConsolidationConfig();
        if (consolidationCfg.enabled && consolidationCfg.sessionSweepEnabled) {
          await runConsolidation(db, {
            config: consolidationCfg,
            budgetMs: consolidationCfg.budgetMs,
            projectRoot: cwd,
          });
        }
      } catch (_consolidateErr) {
        // Best-effort: never block session end.
      }

      // 5. Mark session as completed
      endSession(db, session_id, 'completed');

      // 6. Auto-generate CURRENT.md and archive old one
      archiveAndRegenerate(db, session_id);

      // 7. Cloud sync (if enabled)
      // Order: drain pending queue first, then sync current session
      // Held outside the try so the catch can release it — a lease stranded by an
      // exception would otherwise sit until its TTL expires.
      let openLease: LearningLease | null = null;
      try {
        // 7a. Drain pending sync queue
        await drainSyncQueue(db);

        // 7b. Sync current session data.
        //
        // LEARNED RULES ARE LEASED, NOT DRAINED (Layer 2). The old code DELETED
        // the team-promotion / revocation / funnel rows the instant it read them
        // into the payload; a failed upload then lost them forever (17 of 18 real
        // rules died this way — see rule-delivery.ts). Now they are leased, and a
        // row is deleted ONLY when the server confirms receipt (ack). Any failure
        // keeps every row and counts an attempt (nack), and a rule that keeps
        // failing raises a LOUD stall alarm rather than a silent zero.
        // Only LEASE when the rules will actually be put on the wire. A seat with
        // cloud sync off (every Free/Pro local-only seat) must not lease at all —
        // there is nothing to deliver them to, and an unleased row is untouchable.
        const cloudCfg = getConfig().cloud;
        const willTransmit =
          !!cloudCfg?.enabled && !!cloudCfg?.apiKey && !!cloudCfg?.endpoint &&
          cloudCfg?.sync?.memory !== false;
        const lease = willTransmit ? leaseLearning(db) : null;
        openLease = lease;
        const syncPayload = buildSyncPayload(db, session_id, observations, summary, lease);
        const result = await syncToCloud(db, syncPayload);
        if (lease) {
          // ACK ONLY ON A REAL RECEIPT (`transmitted`), never on `success` alone.
          // `syncToCloud` returns success:true when cloud sync is DISABLED — nothing
          // was sent. Acking on that would delete every learned rule on a local-only
          // seat: the exact silent-loss bug this whole module exists to abolish,
          // reintroduced inside its own fix. Caught by an adversarial re-read, then
          // pinned by a test (rule-delivery-never-loses-a-rule: "cloud disabled").
          if (result.transmitted === true) {
            ackLearning(db, lease);
          } else {
            nackLearning(db, lease, result.error ?? 'not transmitted (sync disabled or unreachable)');
          }
        }
        openLease = null;

        // 7c. Team-shared promotion PULL (PB-006). Best-effort, bounded by the
        // same request budget — materializes the org's promotions as reviewable
        // candidates (NEVER applies). Free/Pro seats no-op at the tier gate.
        // Deliberately at session-END, not session-start/user-prompt (those hooks
        // are latency-critical).
        try {
          await pullTeamPromotions(db);
        } catch (_pullErr) {
          // Non-blocking: pull failure never blocks session end
        }

        // 7d. Cross-repo shared-memory EXPORT + IMPORT (Slice 5, B-02/B-08). Crypto +
        // file I/O, so it runs HERE at session-END (never the recall hot path). Both
        // are self-gating on the two independent opt-ins (export→memory.share.enabled,
        // import→a non-empty subscribe list); a dormant install does nothing. session-
        // end is the composition root that wires the concrete transport into the
        // transport-agnostic halves. Export publishes THIS repo's human-marked shareable
        // decisions (fail-closed); import verifies others' → PENDING only (a human still
        // accepts each). One shared transport instance.
        try {
          const shareTransport = new LocalFsTransport();
          await exportSharedMemories(db, shareTransport);
          await importSharedMemories(db, shareTransport);
        } catch (_shareErr) {
          // Non-blocking: a cross-repo share failure never blocks session end
        }
      } catch (syncErr) {
        // Non-blocking: a sync failure never blocks session end — but it may not
        // pass SILENTLY either. If a lease was open when this threw, release it so
        // the rules retry on the next session instead of waiting out the lease TTL.
        // Nothing is deleted on this path.
        const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
        if (openLease) nackLearning(db, openLease, msg);
        recordHookFailure('session-end:cloud-sync', syncErr);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    // G-2: a hook may fail; it may not fail SILENTLY. Exit stays 0 (a Massu
    // bug must never block the user's session) but the failure now leaves a
    // durable trace: .massu/hook-failures.jsonl + stderr + hook_health.
    recordHookFailure('session-end', err);
  }
  process.exit(0);
}

/**
 * Build a sync payload from the current session data.
 *
 * Layer 2: the learned rules come from a LEASE (`rule-delivery.ts`), never from a
 * destructive drain. The caller acks the lease when the server confirms receipt
 * and nacks it otherwise; either way nothing is deleted here.
 *
 * The old `willTransmit` guard existed to stop the DELETE firing when the rows
 * would be filtered off the wire. Under lease/ack a delete cannot happen without
 * a server confirmation, so the guard is no longer load-bearing for safety — but
 * it is kept as a TRANSMIT filter: when cloud sync is off, the rules stay queued
 * (unleased rows are simply omitted from the payload) rather than being shipped
 * into a request that would drop them.
 */
function buildSyncPayload(
  db: import('better-sqlite3').Database,
  sessionId: string,
  observations: Array<Record<string, unknown>>,
  summary: SessionSummary,
  lease: LearningLease | null
): SyncPayload {
  // A null lease means "we are not transmitting this session" — the learned rules
  // stay queued and untouched. The payload simply carries no rule sections.
  const promotions = lease?.promotions ?? [];
  const revocations = lease?.revocations ?? [];
  const funnelEvents = lease?.events ?? [];
  return {
    sessions: [{
      local_session_id: sessionId,
      summary: summary.request ?? undefined,
      started_at: undefined, // Will be filled from session data if available
      ended_at: new Date().toISOString(),
      turns: 0,
      tokens_used: 0,
      estimated_cost: 0,
      tools_used: [],
    }],
    observations: observations.map((o, idx) => ({
      local_observation_id: `${sessionId}_obs_${idx}`,
      session_id: sessionId,
      type: o.type as string,
      content: (o.title as string) + (o.detail ? `: ${o.detail}` : ''),
      importance: (o.importance as number) ?? 3,
      file_path: undefined,
    })),
    ...(promotions.length > 0
      ? {
          rule_promotions: promotions.map((p) => {
            // P1-002a (CR-39 effectiveness): attach the canonical CR-53
            // recurrence_count (audit_log rule_promoted metadata) keyed by
            // prompt_hash. null when no recurrence row exists (column nullable);
            // this is what powers the "which rules actually work" view server-side.
            const recurrence = getRecurrenceCountForPromptHash(db, p.prompt_hash);
            return {
              prompt_hash: p.prompt_hash,
              destination: p.destination,
              draft_text: p.draft_text,
              score: p.score,
              signals: p.signals,
              content_hash: p.content_hash,
              ...(recurrence !== null ? { recurrence_count: recurrence } : {}),
              // PA3-004: hardened-destination publish carries the flag + attestation.
              ...(p.hardened ? { hardened: true } : {}),
              ...(p.review_attestation !== undefined
                ? { review_attestation: p.review_attestation }
                : {}),
            };
          }),
        }
      : {}),
    ...(revocations.length > 0
      ? { rule_revocations: revocations.map((prompt_hash) => ({ prompt_hash })) }
      : {}),
    ...(funnelEvents.length > 0
      ? {
          rule_promotion_events: funnelEvents.map((e) => ({
            prompt_hash: e.prompt_hash,
            event_type: e.event_type,
            created_at: e.created_at,
            ...(e.metadata && Object.keys(e.metadata).length > 0
              ? { metadata: e.metadata }
              : {}),
          })),
        }
      : {}),
  };
}

function buildSummaryFromObservations(
  observations: Array<Record<string, unknown>>,
  prompts: Array<{ prompt_text: string }>
): SessionSummary {
  // request = first user prompt
  const request = prompts[0]?.prompt_text?.slice(0, 500) ?? undefined;

  // investigated = discovery observations
  const discoveries = observations
    .filter(o => o.type === 'discovery')
    .map(o => (o.title as string))
    .join('; ');

  // decisions = decision observations
  const decisions = observations
    .filter(o => o.type === 'decision')
    .map(o => `- ${o.title}`)
    .join('\n');

  // completed = feature/bugfix/refactor observations
  const completed = observations
    .filter(o => ['feature', 'bugfix', 'refactor'].includes(o.type as string))
    .map(o => `- ${o.title}`)
    .join('\n');

  // failed_attempts = failed_attempt observations
  const failedAttempts = observations
    .filter(o => o.type === 'failed_attempt')
    .map(o => `- ${o.title}`)
    .join('\n');

  // next_steps = observations from last 10% if no completion markers
  const lastTenPercent = observations.slice(Math.floor(observations.length * 0.9));
  const hasCompletion = completed.length > 0;
  const nextSteps = hasCompletion ? undefined : lastTenPercent
    .map(o => `- [${o.type}] ${o.title}`)
    .join('\n');

  // files created/modified
  const filesCreated: string[] = [];
  const filesModified: string[] = [];
  for (const o of observations) {
    if (o.type !== 'file_change') continue;
    const files = safeParseJson(o.files_involved as string, []) as string[];
    const title = o.title as string;
    if (title.startsWith('Created') || title.startsWith('Created/wrote')) {
      filesCreated.push(...files);
    } else if (title.startsWith('Edited')) {
      filesModified.push(...files);
    }
  }

  // verification results
  const verificationResults: Record<string, string> = {};
  for (const o of observations) {
    if (o.type !== 'vr_check') continue;
    const vrType = o.vr_type as string;
    const passed = (o.title as string).includes('PASS');
    if (vrType) verificationResults[vrType] = passed ? 'PASS' : 'FAIL';
  }

  // plan progress
  const planProgress: Record<string, string> = {};
  for (const o of observations) {
    if (!o.plan_item) continue;
    planProgress[o.plan_item as string] = 'in_progress';
  }

  return {
    request,
    investigated: discoveries || undefined,
    decisions: decisions || undefined,
    completed: completed || undefined,
    failedAttempts: failedAttempts || undefined,
    nextSteps,
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    verificationResults,
    planProgress,
  };
}

function safeParseJson(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch (_e) {
    return fallback;
  }
}

/**
 * Capture conversation turns and tool call details from the JSONL transcript.
 * Uses incremental parsing to only process new lines since last invocation.
 * P2-002 + P2-003: Stop hook conversation capture with state tracking.
 */
async function captureConversationData(
  db: import('better-sqlite3').Database,
  sessionId: string,
  transcriptPath: string
): Promise<void> {
  if (!transcriptPath) return;

  // P2-003: Incremental parsing - only process new lines
  const lastLine = getLastProcessedLine(db, sessionId);
  const { entries, totalLines } = await parseTranscriptFrom(transcriptPath, lastLine);

  if (entries.length === 0) {
    setLastProcessedLine(db, sessionId, totalLines);
    return;
  }

  // Group entries into turns (user prompt -> assistant response(s) with tool calls)
  const turns = groupEntriesIntoTurns(entries);

  // Use a transaction for batch insert (P4-002: performance safeguard)
  const insertTurns = db.transaction(() => {
    // Determine starting turn number (continue from existing turns)
    const existingMax = db.prepare(
      'SELECT MAX(turn_number) as max_turn FROM conversation_turns WHERE session_id = ?'
    ).get(sessionId) as { max_turn: number | null };
    let turnNumber = (existingMax.max_turn ?? 0) + 1;

    for (const turn of turns) {
      const toolCallSummaries = turn.toolCalls.map(tc => ({
        name: tc.toolName,
        input_summary: summarizeToolInput(tc.toolName, tc.input).slice(0, 200),
        is_error: tc.isError ?? false,
      }));

      // P4-001: assistant_response capped at 10000 chars
      const assistantText = turn.assistantText?.slice(0, 10000) ?? null;

      addConversationTurn(
        db, sessionId, turnNumber,
        turn.userPrompt,
        assistantText,
        toolCallSummaries.length > 0 ? JSON.stringify(toolCallSummaries) : null,
        turn.toolCalls.length,
        estimateTokens(turn.userPrompt),
        assistantText ? estimateTokens(assistantText) : 0
      );

      // Insert tool call details for this turn (all tools, no filtering)
      for (const tc of turn.toolCalls) {
        const inputStr = JSON.stringify(tc.input);
        const outputStr = tc.result ?? '';
        const files = extractFilesFromToolCall(tc.toolName, tc.input);

        addToolCallDetail(
          db, sessionId, turnNumber,
          tc.toolName,
          summarizeToolInput(tc.toolName, tc.input),
          inputStr.length,
          outputStr.length,
          !(tc.isError ?? false),
          files.length > 0 ? files : undefined
        );
      }

      turnNumber++;
    }
  });

  insertTurns();

  // Update last processed line
  setLastProcessedLine(db, sessionId, totalLines);
}

interface ConversationTurn {
  userPrompt: string;
  assistantText: string | null;
  toolCalls: Array<{
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  }>;
}

/**
 * Group transcript entries into conversation turns.
 * A turn starts with a user message and includes all subsequent assistant messages
 * and tool calls until the next user message.
 */
function groupEntriesIntoTurns(entries: TranscriptEntry[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;
  const toolUseMap = new Map<string, { toolName: string; toolUseId: string; input: Record<string, unknown>; result?: string; isError?: boolean }>();

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message && !entry.isMeta) {
      // Start a new turn
      if (currentTurn) {
        turns.push(currentTurn);
      }
      const text = getTextFromBlocks(entry.message.content);
      if (text.trim()) {
        currentTurn = {
          userPrompt: text.trim(),
          assistantText: null,
          toolCalls: [],
        };
      }
    } else if (entry.type === 'assistant' && entry.message && currentTurn) {
      // Add assistant text
      const text = getTextFromBlocks(entry.message.content);
      if (text.trim()) {
        currentTurn.assistantText = currentTurn.assistantText
          ? currentTurn.assistantText + '\n' + text.trim()
          : text.trim();
      }

      // Extract tool calls from this assistant message
      for (const block of entry.message.content) {
        if (block.type === 'tool_use') {
          const tc = {
            toolName: (block as { name: string }).name,
            toolUseId: (block as { id: string }).id,
            input: (block as { input: Record<string, unknown> }).input ?? {},
          };
          currentTurn.toolCalls.push(tc);
          toolUseMap.set(tc.toolUseId, tc);
        } else if (block.type === 'tool_result') {
          const toolUseId = (block as { tool_use_id: string }).tool_use_id;
          const existing = toolUseMap.get(toolUseId);
          if (existing) {
            existing.result = getToolResultFromBlock(block);
            existing.isError = (block as { is_error?: boolean }).is_error ?? false;
          }
        }
      }
    }
  }

  // Push the last turn
  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}

function getTextFromBlocks(content: TranscriptContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function getToolResultFromBlock(block: TranscriptContentBlock): string {
  const content = (block as { content: string | TranscriptContentBlock[] }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => typeof b === 'object' && b !== null && b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Create a concise summary of tool input for the tool_input_summary column.
 */
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `Read ${input.file_path ?? ''}`;
    case 'Write':
      return `Write ${input.file_path ?? ''}`;
    case 'Edit':
      return `Edit ${input.file_path ?? ''}`;
    case 'Bash':
      return `$ ${(input.command as string ?? '').slice(0, 200)}`;
    case 'Grep':
      return `Grep "${input.pattern ?? ''}" in ${input.path ?? '.'}`;
    case 'Glob':
      return `Glob "${input.pattern ?? ''}" in ${input.path ?? '.'}`;
    case 'Task':
      return `Task: ${(input.description as string ?? '').slice(0, 100)}`;
    case 'WebFetch':
      return `Fetch ${input.url ?? ''}`;
    case 'WebSearch':
      return `Search "${input.query ?? ''}"`;
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 200)}`;
  }
}

/**
 * Extract file paths from a tool call input.
 */
function extractFilesFromToolCall(toolName: string, input: Record<string, unknown>): string[] {
  const filePath = input.file_path as string | undefined;
  if (filePath) return [filePath];

  const path = input.path as string | undefined;
  if (path && !path.startsWith('.') && toolName !== 'Grep') return [path];

  return [];
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 5000);
  });
}

// Run main() only when this file IS the process entry point. Written bare,
// `main()` at module scope means IMPORTING this module RUNS the hook: it reads
// stdin, does its work, and exits the host process.
if (isDirectInvocation(import.meta.url)) {
  main();
}
