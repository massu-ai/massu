// Plan 3c Phase 9b P-A-005: re-export shim. Source-of-truth lives at
// `packages/adapter-spring/src/index.ts` (workspace package). This shim
// preserves the legacy import path used by codebase-introspector + tests.
export { springAdapter } from '@massu/adapter-spring';
