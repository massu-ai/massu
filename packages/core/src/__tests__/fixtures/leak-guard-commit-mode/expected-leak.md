# Leak Fixture — Trigger Case

This fixture contains the literal word that the leak-guard pattern `\bhedge\b` matches: example-project.

The leak-guard scanner in commit-mode MUST FAIL on this file. The vitest test `leak-guard-commit-mode.test.ts` invokes the scanner with `MASSU_LEAK_GUARD_MODE=commit` and asserts exit code 1.

Reference: this is the same content-trigger word that caused the 2026-05-09 false-PASS on `massu-ai/massu#2`'s range-mode CI run; verified live by `massu-ai/massu#3` 2026-05-11 (plan-leak-guard-range-mode-verify P-A-002).
