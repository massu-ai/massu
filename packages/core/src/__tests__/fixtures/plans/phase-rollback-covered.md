# Plan Test: Phase Rollback — every declared phase is named in the rollback section

**Date**: 2026-08-12
**Plan Token**: `plan-test-phase-rb-covered`
**Status**: 📋 DRAFT — awaiting approval

## 4. Implementation items

### Phase P1 — first

### Phase P2 — second

### Phase P3 — third

## 7. Rollback

Each phase is one commit. P1: revert the adapter change. P2-P3: revert in reverse order;
both are additive and revert-safe in either direction.
