// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

/**
 * PA1-004 drift-guard (plan-2026-06-01-enterprise-governance-audit-export, CR-55
 * generalized): the Enterprise auto-learning governance invariant — the client
 * gate, the server RPC, and role-aware RLS must stay in lockstep.
 *
 * Bash mirror: scripts/massu-pattern-scanner.sh Check 37 (vitest <-> scanner
 * parity — the same two-layer pattern as Check 32 <-> team-shared-promotion).
 *
 * Public-mirror note (feedback_public_mirror_ci_and_log_leak): the server edge
 * functions + migrations + website types live under `website/`, which does NOT
 * sync to the public mirror (sync-public.sh excludes website/). Every assertion
 * that reads a website file is `it.skipIf(!HAS_SERVER_SRC)`-guarded so it is a
 * no-op in the `CI (public-mirror)` run rather than failing on a missing file.
 * The CLIENT assertions (entitlement + gate symbols) run everywhere.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

// ── Client sources (present in both private repo + public mirror) ──
const HARDENED_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-candidate-hardened.ts');
const ENTITLEMENT_SRC = resolve(REPO_ROOT, 'packages/core/src/auto-learning-entitlement.ts');
const APPLIER_SRC = resolve(REPO_ROOT, 'packages/core/src/rule-candidate-applier.ts');
const PATTERN_SCANNER = resolve(REPO_ROOT, 'scripts/massu-pattern-scanner.sh');

// ── Server sources (website/ — excluded from the public mirror) ──
const MIGRATION_049 = resolve(REPO_ROOT, 'website/supabase/migrations/049_promotion_governance.sql');
const MIGRATION_043 = resolve(REPO_ROOT, 'website/supabase/migrations/043_promoted_rules.sql');
const MIGRATION_001 = resolve(REPO_ROOT, 'website/supabase/migrations/001_initial_schema.sql');
const MIGRATION_017 = resolve(REPO_ROOT, 'website/supabase/migrations/017_comprehensive_fixes.sql');
const PROMOTED_RULES_FN = resolve(REPO_ROOT, 'website/supabase/functions/promoted-rules/index.ts');
const TYPES_SRC = resolve(REPO_ROOT, 'website/src/lib/supabase/types.ts');

const HAS_SERVER_SRC =
  existsSync(MIGRATION_049) && existsSync(MIGRATION_043) && existsSync(MIGRATION_001);

function read(p: string): string {
  return readFileSync(p, 'utf-8');
}

describe('Governance gate invariant (PA1-004 / CR-55 generalized)', () => {
  // ──────────────────────────────────────────────────────────────────────
  // CLIENT — runs everywhere (no website dependency).
  // ──────────────────────────────────────────────────────────────────────
  describe('client gate', () => {
    it('rule-candidate-hardened.ts exports the generalized validateGovernanceGate referencing policy + approvals', () => {
      const src = read(HARDENED_SRC);
      expect(src).toContain('export function validateGovernanceGate');
      // The generalized gate is parameterized on (policy, approvals).
      expect(src).toMatch(/validateGovernanceGate\s*\(\s*\n?\s*policy:\s*GovernancePolicy/);
      expect(src).toContain('approvals: GovernanceApprovals');
      expect(src).toContain('approvals_required');
      // distinct-approver invariant: the count EXCLUDES the promoter.
      expect(src).toContain('approvals.promoted_by');
      expect(src).toMatch(/id !== approvals\.promoted_by/);
    });

    it('validateHardenedApplyGate is preserved and DELEGATES to validateGovernanceGate (N=2 special case)', () => {
      const src = read(HARDENED_SRC);
      expect(src).toContain('export function validateHardenedApplyGate');
      // The body calls validateGovernanceGate (the delegation).
      const body = src.slice(src.indexOf('export function validateHardenedApplyGate'));
      expect(body).toContain('validateGovernanceGate(');
      // The exact Phase-3 refusal messages are preserved (the 4 ref/test sites).
      expect(body).toContain('two-operator review not satisfied');
      expect(body).toContain('render-only dry_run_ack');
    });

    it('roleRank is an ordinal ladder (owner>admin>developer>auditor), NOT a lexicographic compare', () => {
      const src = read(HARDENED_SRC);
      expect(src).toContain('export function roleRank');
      expect(src).toMatch(/case 'owner':\s*\n?\s*return 4/);
      expect(src).toMatch(/case 'admin':\s*\n?\s*return 3/);
      expect(src).toMatch(/case 'developer':\s*\n?\s*return 2/);
      expect(src).toMatch(/case 'auditor':\s*\n?\s*return 1/);
    });

    it('auto-learning-entitlement.ts declares ENTERPRISE_GOVERNANCE_MIN_TIER=enterprise + the predicate (reusing tierLevel, no parallel map)', () => {
      const src = read(ENTITLEMENT_SRC);
      expect(src).toMatch(/ENTERPRISE_GOVERNANCE_MIN_TIER:\s*ToolTier\s*=\s*'enterprise'/);
      expect(src).toContain('export function entitledForEnterpriseGovernance');
      expect(src).toContain('tierLevel(ENTERPRISE_GOVERNANCE_MIN_TIER)');
      // No parallel plan->tier MAP introduced here (it reuses the license.ts
      // PLAN_TO_TIER_MAP via tierLevel; referencing it in a comment is fine, but
      // it must not DEFINE its own plan->tier object literal).
      expect(src).not.toMatch(/PLAN_TO_TIER_MAP\s*[:=]\s*\{/);
    });

    it('the applier wires the governance gate (re-exports validateGovernanceGate)', () => {
      const src = read(APPLIER_SRC);
      expect(src).toContain('validateGovernanceGate');
    });

    it('pattern-scanner carries an equivalent Check 37 (vitest <-> scanner parity)', () => {
      const scanner = read(PATTERN_SCANNER);
      expect(scanner).toContain('Check 37');
      expect(scanner).toContain('validateGovernanceGate');
      expect(scanner).toContain('ENTERPRISE_GOVERNANCE_MIN_TIER');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // SERVER — website/ (skipped in the public mirror).
  // ──────────────────────────────────────────────────────────────────────
  describe('server RPC + RLS + schema', () => {
    it.skipIf(!HAS_SERVER_SRC)('migration 049 min_promoter_role CHECK equals the live user_profiles.role enum', () => {
      const m049 = read(MIGRATION_049);
      expect(m049).toContain("min_promoter_role IN ('owner', 'admin', 'developer', 'auditor')");
      const m001 = read(MIGRATION_001);
      // The role enum the policy CHECK mirrors (001:40).
      expect(m001).toMatch(/role IN \('owner', 'admin', 'developer', 'auditor'\)/);
    });

    it.skipIf(!HAS_SERVER_SRC)('promoted_rule_upsert gates on role_rank() — NOT a bare lexicographic TEXT >=', () => {
      const m049 = read(MIGRATION_049);
      // role_rank ordinal helper exists + is used for the comparison.
      expect(m049).toContain('CREATE OR REPLACE FUNCTION role_rank');
      expect(m049).toMatch(/role_rank\(v_promoter_role\)\s*<\s*role_rank\(v_policy\.min_promoter_role\)/);
      // No bare lexicographic role comparison against the policy minimum.
      expect(m049).not.toMatch(/v_promoter_role\s*>=\s*v_policy\.min_promoter_role/);
    });

    it.skipIf(!HAS_SERVER_SRC)('allowed_destinations CHECK is a subset of the live promoted_rules.destination vocabulary (045 parity)', () => {
      const m049 = read(MIGRATION_049);
      expect(m049).toContain(
        "allowed_destinations <@ ARRAY['corrections-md', 'claude-md-cr', 'pattern-scanner', 'custom-destination']",
      );
    });

    it.skipIf(!HAS_SERVER_SRC)('promotion_approvals.prompt_hash regex is byte-identical to promoted_rules.prompt_hash (043 parity)', () => {
      const m049 = read(MIGRATION_049);
      const m043 = read(MIGRATION_043);
      const re = "prompt_hash ~ '^[0-9a-f]{16}$'";
      expect(m049).toContain(re);
      expect(m043).toContain(re);
    });

    it.skipIf(!HAS_SERVER_SRC)('approvals_required carries CHECK (>= 1) so the N-of-M gate is never zero-approver-trivial', () => {
      const m049 = read(MIGRATION_049);
      expect(m049).toMatch(/approvals_required\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1\s+CHECK\s*\(approvals_required\s*>=\s*1\)/);
    });

    it.skipIf(!HAS_SERVER_SRC)('approval_state two-phase lifecycle column exists + is excluded from the client cursor when pending', () => {
      const m049 = read(MIGRATION_049);
      expect(m049).toMatch(/approval_state\s+TEXT\s+NOT NULL\s+DEFAULT\s+'applied'\s*\n?\s*CHECK\s*\(approval_state\s+IN\s*\('pending',\s*'applied',\s*'rejected'\)\)/);
      // The /promoted-rules differential-pull excludes pending rows.
      const fn = read(PROMOTED_RULES_FN);
      expect(fn).toContain(".neq('approval_state', 'pending')");
    });

    it.skipIf(!HAS_SERVER_SRC)('the apply transition flips pending->applied + bumps seq when the threshold is met', () => {
      const m049 = read(MIGRATION_049);
      // promoted_rule_upsert returns pending_approval below threshold.
      expect(m049).toContain("RETURN 'pending_approval'");
      // promotion_approval_record flips to applied + re-stamps seq.
      expect(m049).toContain('CREATE OR REPLACE FUNCTION promotion_approval_record');
      expect(m049).toMatch(/SET approval_state\s*=\s*'applied'[\s\S]*?seq\s*=\s*nextval\('promoted_rules_seq'\)/);
    });

    it.skipIf(!HAS_SERVER_SRC)('approver != promoter is enforced at count-time in BOTH the upsert and the record RPC', () => {
      const m049 = read(MIGRATION_049);
      // upsert count excludes the promoter.
      expect(m049).toMatch(/approver_user_id IS DISTINCT FROM p_promoted_by/);
      // record RPC self-approval guard + count exclusion.
      expect(m049).toContain("RETURN 'self_approval_rejected'");
      expect(m049).toMatch(/approver_user_id IS DISTINCT FROM v_promoted_by/);
    });

    it.skipIf(!HAS_SERVER_SRC)('promotion_approval_record enforces caller-org match (no cross-org forgery — CR-52 HIGH)', () => {
      const m049 = read(MIGRATION_049);
      // The authenticated branch must reject a p_org_id != the caller's own org.
      const fn = m049.slice(m049.indexOf('CREATE OR REPLACE FUNCTION promotion_approval_record'));
      expect(fn).toMatch(/p_org_id IS DISTINCT FROM get_user_org_id\(\)/);
    });

    it.skipIf(!HAS_SERVER_SRC)('promotion_policy_reconcile exists + only flips pending->applied (CR-52 arch MEDIUM)', () => {
      const m049 = read(MIGRATION_049);
      expect(m049).toContain('CREATE OR REPLACE FUNCTION promotion_policy_reconcile');
      const fn = m049.slice(m049.indexOf('CREATE OR REPLACE FUNCTION promotion_policy_reconcile'));
      expect(fn).toMatch(/approval_state = 'applied'/);
      expect(fn).toContain("approval_state = 'pending'");
      // org-scoped to the caller (no cross-org reconcile).
      expect(fn).toMatch(/p_org_id IS DISTINCT FROM get_user_org_id\(\)/);
    });

    it.skipIf(!HAS_SERVER_SRC)('require_hardened_review is CONSUMED (tighten-only) — a rejected_hardened_required branch exists', () => {
      const m049 = read(MIGRATION_049);
      expect(m049).toContain('require_hardened_review');
      expect(m049).toContain("RETURN 'rejected_hardened_required'");
      // It tightens executable destinations specifically.
      expect(m049).toMatch(/require_hardened_review[\s\S]*?pattern-scanner[\s\S]*?custom-destination/);
    });

    it.skipIf(!HAS_SERVER_SRC)('admins-only policy-edit RLS exists (inline EXISTS role IN owner/admin — the 015 precedent)', () => {
      const m049 = read(MIGRATION_049);
      expect(m049).toContain('org_promotion_policy_insert');
      expect(m049).toContain('org_promotion_policy_update');
      expect(m049).toMatch(/up\.role IN \('owner', 'admin'\)/);
    });

    it.skipIf(!HAS_SERVER_SRC)("activity_feed CHECK + ActivityEventType TS union BOTH contain 'approval_recorded'", () => {
      const m049 = read(MIGRATION_049);
      expect(m049).toContain("'approval_recorded'");
      // The 017 set is copied verbatim — spot-check a couple of values survive.
      const m017 = read(MIGRATION_017);
      expect(m017).toContain("'onboarding_completed'");
      expect(m049).toContain("'onboarding_completed'");
      const types = read(TYPES_SRC);
      expect(types).toContain("'approval_recorded'");
    });
  });
});
