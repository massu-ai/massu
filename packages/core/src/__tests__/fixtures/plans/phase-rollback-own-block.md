# Plan Test: Phase Rollback — co-located rollback lines discharge the phase

**Date**: 2026-08-12
**Plan Token**: `plan-test-phase-rb-own`
**Status**: 📋 DRAFT — awaiting approval

## 4. Implementation items

### Phase P1 — first

- **Rollback**: revert the commit; the pragma removal restores prior behaviour.

### Phase P2 — second

- **Rollback**: the parameter is optional, so revert is safe in both directions.

## 7. Rollback

Nothing in this section names a phase — each phase carries its own rollback above,
which is the shape that cannot drift.
