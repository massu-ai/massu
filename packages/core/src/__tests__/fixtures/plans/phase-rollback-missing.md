# Plan Test: Phase Rollback — a phase added after the rollback section was written

**Date**: 2026-08-12
**Plan Token**: `plan-test-phase-rb-missing`
**Status**: 📋 DRAFT — awaiting approval

This fixture reproduces the shape that shipped twice in
`2026-07-23-hook-latency-and-silent-loss-fixes.md`: the rollback section enumerates the
phases that existed when it was written, and a later phase lands hundreds of lines away.

## 4. Implementation items

### Phase P1 — first

### Phase P2 — second

### Phase P6 — added later, nobody scrolled back to the rollback section

## 7. Rollback

Each phase is one commit. P1: revert the adapter change. P2: revert restores the prior
dispatcher. No migration, no data transform anywhere in this plan.
